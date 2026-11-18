import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')

async function staticClosure(entry: string): Promise<{ files: string[]; packages: string[] }> {
  const outdir = await mkdtemp(join(tmpdir(), 'inlay-imports-'))
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      write: false,
      metafile: true,
      outdir,
      logLevel: 'silent',
    })
    const outputs = result.metafile.outputs
    const start = Object.keys(outputs).find((path) => outputs[path]?.entryPoint === entry)
    if (start === undefined) throw new Error(`no output for ${entry}`)
    const files = new Set<string>()
    const packages = new Set<string>()
    const seen = new Set<string>()
    const walk = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      const output = outputs[path]
      if (output === undefined) throw new Error(`no output ${path}`)
      for (const input of Object.keys(output.inputs)) files.add(input)
      for (const imp of output.imports) {
        if (imp.kind !== 'import-statement') continue
        if (imp.external) {
          if (!imp.path.startsWith('node:')) packages.add(imp.path)
        } else {
          walk(imp.path)
        }
      }
    }
    walk(start)
    return { files: [...files].sort(), packages: [...packages].sort() }
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

describe('static imports', () => {
  it('the CLI entry point loads nothing statically', async () => {
    expect(await staticClosure('src/adapters/cli/bin.ts')).toEqual({ files: ['src/adapters/cli/bin.ts'], packages: [] })
  })

  it("serve's primary loads only what supervising needs", async () => {
    const closure = await staticClosure('src/host/serve.ts')
    expect(closure.files).toContain('src/host/primary.ts')
    expect(closure.packages).toEqual([])
    expect(closure.files).toEqual([
      'src/core/errors.ts',
      'src/core/messages/en.ts',
      'src/core/messages/index.ts',
      'src/core/release/keys.ts',
      'src/core/release/pointer.ts',
      'src/host/bin.ts',
      'src/host/config.ts',
      'src/host/ipc.ts',
      'src/host/primary.ts',
      'src/host/serve.ts',
    ])
  })
})
