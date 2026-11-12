// Two-process dedup verification (R3). Spawns two node workers sharing one
// DSH_HOME; worker 2 delays 600ms so worker 1 has saved its seen keys first.
// With cross-instance refreshSeen, the same event must be pushed exactly once.
// Run: node scripts/verify-dedup.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const stateUrl = pathToFileURL(join(lib, 'state.js')).href
const radarUrl = pathToFileURL(join(lib, 'radar.js')).href

const home = mkdtempSync(join(tmpdir(), 'aihot-dedup-'))
const pushLog = join(home, 'pushes.log')
writeFileSync(pushLog, '')

const workerCode = `
import { loadState, saveState } from '${stateUrl}'
import { refreshSeen, scanProvider } from '${radarUrl}'
import { appendFileSync } from 'node:fs'
const state = loadState()
await new Promise((r) => setTimeout(r, Number(process.env.DELAY || 0)))
refreshSeen(state)
const api = { resetsRecent: async () => ({ events: [{ id: 'evt-1', status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'announced' }, posts: [] }] }) }
const notifier = { send: async () => { appendFileSync(process.env.PUSH_LOG, 'push\\n'); return { ok: true, chunks: 1 } } }
await scanProvider(api, 'codex', state, notifier)
saveState(state)
`

const run = (delay) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
    env: { ...process.env, DSH_HOME: home, PUSH_LOG: pushLog, DELAY: String(delay) },
    stdio: 'inherit',
  })
  child.on('exit', resolve)
})

await Promise.all([run(0), run(600)])
const count = existsSync(pushLog) ? readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).length : 0
console.log(`\n推送计数: ${count} (应为 1)`)
process.exitCode = count === 1 ? 0 : 1