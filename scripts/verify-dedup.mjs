// Cross-process dedup + lock verification. Two node workers share one DSH_HOME
// and must push the same event exactly once, whichever way they overlap:
//   1. staggered  — worker 2 starts 600ms later (the historical case, once
//                   refreshSeen()-only dedup was enough);
//   2. simultaneous — both hit a shared wall-clock barrier and start together,
//                   so they read "unseen" at the same moment. Only the lock
//                   covering read → push → write can keep this at one push;
//   3. simultaneous + lock retry — the loser waits for the lock and scans again
//                   (it must find the key already in the merged state).
// Run: node scripts/verify-dedup.mjs
//
// Each worker goes through scanCycle(), i.e. the same path the host uses; a test
// that called scanProvider() directly would bypass the lock and prove nothing.

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const stateUrl = pathToFileURL(join(lib, 'state.js')).href
const radarUrl = pathToFileURL(join(lib, 'radar.js')).href

const workerCode = `
import { loadState, saveState } from '${stateUrl}'
import { scanCycle } from '${radarUrl}'
import { appendFileSync } from 'node:fs'

const startAt = Number(process.env.START_IN || 0)
if (startAt) {
  const wait = startAt - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}
const state = loadState()
const api = {
  PROVIDERS: ['codex'],
  resetsRecent: async () => ({ events: [{ id: 'evt-1', status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'announced' }, posts: [] }] }),
}
const notifier = { send: async () => { appendFileSync(process.env.PUSH_LOG, 'push\\n'); return { ok: true, status: 200, code: null, chunks: 1 } } }
const runOnce = () => scanCycle({ api, state, notifier, config: { radar: {} }, onScan: () => saveState(state) })

let out = await runOnce()
if (out.locked === false && process.env.RETRY === '1') {
  // Contention path: wait for the other instance instead of skipping the event.
  for (let i = 0; i < 40 && out.locked === false; i++) {
    await new Promise((r) => setTimeout(r, 100))
    out = await runOnce()
  }
}
`

const runWorker = ({ home, pushLog, startAt, retry }) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
    env: { ...process.env, DSH_HOME: home, PUSH_LOG: pushLog, START_IN: String(startAt), RETRY: retry ? '1' : '0' },
    stdio: 'inherit',
  })
  child.on('exit', resolve)
})

const results = []
async function scenario(name, { offsets = [0, 0], retry = [false, false] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aihot-dedup-'))
  const pushLog = join(home, 'pushes.log')
  writeFileSync(pushLog, '')
  // Shared barrier: both children are spawned first, then start together.
  const startAt = Date.now() + 1200
  await Promise.all(offsets.map((off, i) => runWorker({ home, pushLog, startAt: startAt + off, retry: retry[i] })))
  const count = existsSync(pushLog) ? readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).length : 0
  const stateFile = join(home, 'aihot-radar', 'state.json')
  let seen = []
  try { seen = JSON.parse(readFileSync(stateFile, 'utf8'))?.seen?.codex || [] } catch { /* missing = empty */ }
  const ok = count === 1 && seen.includes('evt-1:announced')
  results.push({ name, count, seen, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  推送 ${count}（应为 1）· seen=${JSON.stringify(seen)}`)
}

await scenario('错开 600ms 启动', { offsets: [0, 600] })
await scenario('真正同时启动（同一时刻抢锁）')
await scenario('同时启动 + 抢锁后重试', { retry: [false, true] })

// ---- 4. a slow operation must not lose the lock to the TTL --------------------
// TTL is overridden to 600ms and the holder busy-waits ~4 TTLs, i.e. it is only
// still the owner because the heartbeat renews it. A taker that shows up mid-way
// must be refused; if the holder ever loses it, touchStateLock() returns false.
const holderCode = `
import { acquireStateLock, touchStateLock } from '${stateUrl}'
const release = acquireStateLock()
if (!release) { console.log('HOLDER_LOCKED_OUT'); process.exit(1) }
await new Promise((r) => setTimeout(r, 2500))
console.log(touchStateLock() ? 'HOLDER_OK' : 'HOLDER_LOST')
release()
`
const takerCode = `
import { acquireStateLock } from '${stateUrl}'
await new Promise((r) => setTimeout(r, 900))
const release = acquireStateLock()
console.log(release ? 'TAKER_GOT_LOCK' : 'TAKER_BLOCKED')
release?.()
`
const spawnCapture = (code, home, ttl) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DSH_HOME: home, AIHOT_LOCK_TTL_MS: String(ttl) },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  child.on('exit', () => resolve(out.trim()))
})

{
  const home = mkdtempSync(join(tmpdir(), 'aihot-lock-'))
  const holder = spawnCapture(holderCode, home, 600)
  await new Promise((r) => setTimeout(r, 300))
  const taker = spawnCapture(takerCode, home, 600)
  const [h, t] = await Promise.all([holder, taker])
  const ok = h === 'HOLDER_OK' && t === 'TAKER_BLOCKED'
  results.push({ name: '慢操作期间锁不被过期抢走', ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  慢操作期间锁不被过期抢走  holder=${h} taker=${t}`)
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
