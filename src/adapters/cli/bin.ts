#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { runCli } from './main.js'

async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    let muted = false
    const output = new Writable({
      write(chunk, _enc, done) {
        if (!muted) process.stderr.write(chunk)
        done()
      },
    })
    const rl = createInterface({ input: process.stdin, output, terminal: true })
    process.stderr.write(prompt)
    muted = true
    try {
      return await new Promise<string>((resolve) => rl.question('', resolve))
    } finally {
      muted = false
      rl.close()
      process.stderr.write('\n')
    }
  }
  const rl = createInterface({ input: process.stdin })
  try {
    for await (const line of rl) return line
    return ''
  } finally {
    rl.close()
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: console.log,
  err: console.error,
  readSecret,
})
