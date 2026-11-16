import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  if (existsSync(`${root}assets/admin/admin.css`) && existsSync(`${root}assets/admin/admin.js`)) return
  const res = spawnSync('node', ['scripts/build-admin.mjs'], { cwd: root, stdio: 'inherit' })
  if (res.status !== 0) throw new Error('Building the admin assets failed')
}
