import { readFileSync } from 'node:fs'
import { defineConfig } from 'inlaycms/site'
import { site } from '../release/site.js'

export const read = readFileSync

export default defineConfig({ site })
