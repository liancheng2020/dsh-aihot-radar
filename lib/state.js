// Local, host-side persistence for radar state and webhook config.
// Data lives under $DSH_HOME/aihot-radar (default ~/.dsh/aihot-radar), never uploaded.
// NOTE: webhook URL is stored locally in plaintext; a future hardening can move it
// to the dsh-credentials service. The directory is created 0o700.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function resolveHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

export function dataDir() {
  return join(resolveHome(), 'aihot-radar')
}

function defaultState() {
  return {
    version: 1,
    seen: {},                 // provider -> array of "id:status" keys already notified
    webhook: { channel: 'none', url: '', secret: '' },
    lastCheck: {},            // provider -> ISO timestamp
    digest: { lastDate: null },
    actor: randomUUID(),
  }
}

export function loadState() {
  const file = join(dataDir(), 'state.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...defaultState(), ...parsed, webhook: { ...defaultState().webhook, ...(parsed.webhook || {}) } }
  } catch {
    return defaultState()
  }
}

export function saveState(state) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'state.json')
  const tmp = join(dir, `.state-${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}