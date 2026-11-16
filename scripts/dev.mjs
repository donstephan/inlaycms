import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (cmd, args) => spawn(cmd, args, { cwd: root, stdio: 'inherit' })

const children = [
  run('node', ['scripts/build-admin.mjs', '--watch']),
  // inlaycms dev restarts the site when a file in example/ changes; tsx watch restarts inlaycms dev when Inlay's code does.
  run('node_modules/.bin/tsx', ['watch', '--clear-screen=false', 'src/adapters/cli/bin.ts', 'dev', '--config', 'example/inlay.config.ts']),
]

let exiting = false
function stop(code) {
  if (exiting) return
  exiting = true
  for (const child of children) child.kill()
  process.exit(code)
}

for (const child of children) child.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
