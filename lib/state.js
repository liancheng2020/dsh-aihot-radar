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
    seen: {},                 // provider -> array of "id:status[:presentation]" keys already notified
    webhook: { channel: 'none', url: '', secret: '' },
    lastCheck: {},            // provider -> ISO timestamp of our last scan
    lastResult: {},           // provider -> { at, ok, error, pending } for the status tool / panel
    digest: { lastDate: null, retries: 0, retryDate: null, lastError: null },
    actor: randomUUID(),      // kept locally, no longer sent in User-Agent
  }
}

export function loadState(logger) {
  const file = join(dataDir(), 'state.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return defaultState() // missing file = fresh install, not a failure
  }
  try {
    const parsed = JSON.parse(raw)
    const d = defaultState()
    return {
      ...d,
      ...parsed,
      webhook: { ...d.webhook, ...(parsed.webhook || {}) },
      digest: { ...d.digest, ...(parsed.digest || {}) },
      lastResult: { ...(parsed.lastResult || {}) },
    }
  } catch (err) {
    try {
      const bak = join(dataDir(), `state.corrupt-${Date.now()}.json`)
      renameSync(file, bak)
      logger?.warn?.(`state.json 损坏，已备份到 ${bak} 并回落默认值：${String(err?.message || err)}`)
    } catch (e) {
      logger?.warn?.(`state.json 损坏且备份失败，回落默认值：${String(err?.message || err)}`)
    }
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