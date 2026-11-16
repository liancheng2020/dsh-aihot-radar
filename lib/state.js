// Local, host-side persistence for radar state and webhook config.
// Data lives under $DSH_HOME/aihot-radar (default ~/.dsh/aihot-radar), never uploaded.
// NOTE: webhook URL is stored locally in plaintext; a future hardening can move it
// to the dsh-credentials service. The directory is created 0o700.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
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
    // provider -> key -> { attempts, state, at, error }. Push failures that are
    // waiting for a retry, and pushes whose delivery is genuinely unknown
    // (timeout), so neither disappears silently.
    delivery: {},
    digest: { lastDate: null, retries: 0, retryDate: null, lastError: null },
    // Panel preferences (null = never set by the user). Kept apart from the
    // digest run state above so a corrupt schedule cannot lose the preference.
    digestPref: { enabled: null, time: null },
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
      seen: { ...(parsed.seen || {}) },
      lastCheck: { ...(parsed.lastCheck || {}) },
      webhook: { ...d.webhook, ...(parsed.webhook || {}) },
      digest: { ...d.digest, ...(parsed.digest || {}) },
      lastResult: { ...(parsed.lastResult || {}) },
      delivery: { ...(parsed.delivery || {}) },
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

// ---- cross-process lock -----------------------------------------------------
// A desktop and a web profile opened together share one DSH_HOME. The lock is
// held for a whole scan cycle (read state -> decide -> push -> write), not just
// for the write: two processes that each read the same "unseen" event and only
// serialise their writes would still both push it.
// A lock older than 60s is treated as stale (holder crashed). While it is held
// a heartbeat rewrites the timestamp every LOCK_TTL_MS/4, so a single provider
// pushing several chunks for minutes still cannot be mistaken for a dead holder.
// Overridable so the concurrency test can watch a TTL expire in seconds instead
// of minutes; production never sets these.
const LOCK_TTL_MS = Number(process.env.AIHOT_LOCK_TTL_MS) || 60000
const LOCK_HEARTBEAT_MS = Math.max(50, Math.floor(LOCK_TTL_MS / 4))
const lockPath = () => join(dataDir(), 'state.json.lock')
const takeoverPath = () => join(dataDir(), 'state.json.lock.takeover')

let lockDepth = 0
let lockToken = null
let heartbeat = null

const lockStamp = () => JSON.stringify({ pid: process.pid, ts: Date.now(), token: lockToken })

function readLockFile(lp) {
  try {
    const j = JSON.parse(readFileSync(lp, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

// True only while the file still carries our token: a lock that expired and was
// taken over belongs to the new holder, and the old one must stop writing.
function ownsLock() {
  if (lockDepth === 0) return false
  const cur = readLockFile(lockPath())
  return !!cur && cur.token === lockToken
}

function startHeartbeat() {
  if (heartbeat) return
  heartbeat = setInterval(() => { touchStateLock() }, LOCK_HEARTBEAT_MS)
  heartbeat.unref?.() // never keep the process alive just for the lock
}

function stopHeartbeat() {
  if (!heartbeat) return
  clearInterval(heartbeat)
  heartbeat = null
}

// Two instances can both see a stale lock. A short-lived guard file makes the
// takeover itself exclusive, and the token re-read makes a lost race harmless.
function takeOverStaleLock(lp, stamp) {
  const guard = takeoverPath()
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
  } catch {
    // A crashed takeover must not wedge every future one.
    try {
      const g = JSON.parse(readFileSync(guard, 'utf8'))
      if (Date.now() - (g?.ts || 0) > 5000) unlinkSync(guard)
    } catch { /* still held by a live process */ }
    return false
  }
  try {
    const cur = readLockFile(lp)
    if (!cur || Date.now() - (cur.ts || 0) < LOCK_TTL_MS) return false
    try { writeFileSync(lp, stamp, 'utf8') } catch { return false }
    const after = readLockFile(lp)
    return !!after && after.token === lockToken
  } finally {
    try { unlinkSync(guard) } catch { /* already gone */ }
  }
}

function acquireLock(logger) {
  if (lockDepth > 0) { lockDepth++; return true } // re-entrant within one process
  try { mkdirSync(dataDir(), { recursive: true, mode: 0o700 }) } catch { /* surfaced on write */ }
  const lp = lockPath()
  lockToken = randomUUID()
  const stamp = lockStamp()
  try {
    writeFileSync(lp, stamp, { flag: 'wx' }) // exclusive create
    lockDepth = 1
    startHeartbeat()
    return true
  } catch { /* lock exists: maybe stale */ }
  if (takeOverStaleLock(lp, stamp)) { lockDepth = 1; startHeartbeat(); return true }
  const cur = readLockFile(lp)
  logger?.warn?.(cur?.pid
    ? `state.json 被进程 ${cur.pid} 锁定，本次跳过（避免重复推送）`
    : 'state.json 锁定冲突且无法读取锁文件，本次跳过')
  lockToken = null
  return false
}

function releaseLock() {
  if (lockDepth === 0) return
  lockDepth--
  if (lockDepth > 0) return
  stopHeartbeat()
  const lp = lockPath()
  const cur = readLockFile(lp)
  // Only remove the lock we still own (a stale takeover may have replaced it).
  if (!cur || cur.token === lockToken) {
    try { unlinkSync(lp) } catch { /* already gone */ }
  }
  lockToken = null
}

// Acquire the shared lock. Returns a release function, or null when another
// process holds it (caller must then skip this cycle rather than push anyway).
export function acquireStateLock(logger) {
  if (!acquireLock(logger)) return null
  let released = false
  return () => {
    if (released) return
    released = true
    releaseLock()
  }
}

// Refresh the timestamp so a long cycle is not taken over. Returns false once
// the lock is no longer ours (the caller must then abandon its write).
export function touchStateLock() {
  if (lockDepth === 0) return false
  if (!ownsLock()) return false
  try { writeFileSync(lockPath(), lockStamp(), 'utf8') } catch { return false }
  return true
}

// Re-read the shared state while holding the lock. The in-memory copy may be
// minutes old (and the panel may have saved a new webhook from the other
// instance meanwhile), so writing it back untouched would both lose that edit
// and re-push events the other instance already delivered.
export function mergeStateFromDisk(state) {
  const disk = readDiskState()
  if (!disk) return false

  // Panel-owned config: the file is the single source of truth.
  if (disk.webhook && typeof disk.webhook === 'object') state.webhook = { ...state.webhook, ...disk.webhook }
  if (disk.digestPref && typeof disk.digestPref === 'object') state.digestPref = { ...(state.digestPref || {}), ...disk.digestPref }
  if (disk.digest && typeof disk.digest === 'object') state.digest = { ...(state.digest || {}), ...disk.digest }

  // Dedupe truth is additive: a key seen by either instance is seen.
  for (const [p, arr] of Object.entries(disk.seen || {})) {
    if (!Array.isArray(arr)) continue
    state.seen[p] = [...new Set([...(state.seen[p] || []), ...arr])]
  }
  // Delivery records are a keyed state map, not an additive set: a record is
  // deleted when the push finally succeeds. Unioning the in-memory copy would
  // put a deleted "retrying" entry back, so the file is authoritative here.
  state.delivery = (disk.delivery && typeof disk.delivery === 'object') ? disk.delivery : {}
  for (const [p, ts] of Object.entries(disk.lastCheck || {})) {
    if (!state.lastCheck[p] || String(ts) > String(state.lastCheck[p])) state.lastCheck[p] = ts
  }
  for (const [p, r] of Object.entries(disk.lastResult || {})) {
    if (!state.lastResult[p] || String(r?.at || '') >= String(state.lastResult[p]?.at || '')) state.lastResult[p] = r
  }
  return true
}

function readDiskState() {
  try {
    const disk = JSON.parse(readFileSync(join(dataDir(), 'state.json'), 'utf8'))
    return disk && typeof disk === 'object' ? disk : null
  } catch { return null }
}

// Sections a caller can own. The radar owns the runtime ones; the panel owns the
// webhook, the panel digest switch, and the scheduler owns its run state.
const OWN_RUNTIME = ['seen', 'lastCheck', 'lastResult', 'delivery']
const SECTIONS = [...OWN_RUNTIME, 'webhook', 'digestPref', 'digest']

function newestByAt(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) {
    if (!out[k] || String(v?.at || v || '') >= String(out[k]?.at || out[k] || '')) out[k] = v
  }
  return out
}

// Compose the document to write. A section the caller does not own is taken from
// the file verbatim — never merged with the caller's memory. Merging looks safer
// but resurrects what the owner deliberately deleted (a delivery record cleared
// by a successful retry, a seen key trimmed out of the API snapshot), and the
// stale copy then keeps re-adding it on every unrelated save.
function mergeForWrite(disk, state, own) {
  if (!disk) return { ...state }
  const out = { ...disk, ...state }
  for (const section of SECTIONS) {
    if (!own.has(section) && disk[section] !== undefined) out[section] = disk[section]
  }
  out.actor = disk.actor || state.actor
  out.version = disk.version ?? state.version
  return out
}

function applyState(target, next) {
  for (const k of Object.keys(next)) target[k] = next[k]
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k]
}

// `own` names the sections this caller just changed. Everything else is merged
// from a fresh read inside the lock, so no write path can publish a stale view
// of another instance's seen keys or configuration.
export function saveState(state, logger, opts = {}) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!acquireLock(logger)) return false
  try {
    if (!ownsLock()) {
      logger?.warn?.('state.json 锁已被其他进程接管，本次放弃写入（避免覆盖新状态）')
      return false
    }
    const next = mergeForWrite(readDiskState(), state, new Set(opts.own || OWN_RUNTIME))
    const file = join(dir, 'state.json')
    const tmp = join(dir, `.state-${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* POSIX only; ignore on Windows */ }
    // Keep this instance aligned with what is on disk, so its next save starts
    // from the truth instead of from the snapshot it happened to be holding.
    applyState(state, next)
    return true
  } finally {
    releaseLock()
  }
}
