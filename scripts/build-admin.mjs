import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const watch = process.argv.includes('--watch')

const options = {
  absWorkingDir: root,
  entryPoints: { admin: 'client/admin/admin.ts', editor: 'client/admin/editor.ts' },
  outdir: 'assets/admin',
  entryNames: '[name]',
  outExtension: { '.js': '.js' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  logLevel: 'info',
}

const tailwind = ['node_modules/.bin/tailwindcss', '-i', 'client/admin/admin.css', '-o', 'assets/admin/admin.css', '--minify']

function runTailwind(extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(tailwind[0], [...tailwind.slice(1), ...extra], { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 || watch ? resolve(child) : reject(new Error(`tailwindcss exited with ${code}`))))
    if (watch) resolve(child)
  })
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  const child = await runTailwind(['--watch'])
  const stop = async () => {
    child.kill()
    await ctx.dispose()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  await build(options)
  await runTailwind()
}
