import { createHash } from 'node:crypto'
import { setTestPasswordHasher } from '../../src/core/auth/auth.js'

// better-auth's scrypt costs ~60 ms per hash or check, about a third of the suite.
// Real scrypt hashes (made before this ran) still verify through better-auth.
const PREFIX = 'test-sha256:'
const digest = (password: string) => PREFIX + createHash('sha256').update(password).digest('hex')

setTestPasswordHasher({
  hash: async (password) => digest(password),
  verify: async ({ hash, password }) =>
    hash.startsWith(PREFIX)
      ? hash === digest(password)
      : (await import('better-auth/crypto')).verifyPassword({ hash, password }),
})
