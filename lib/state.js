// Local, host-side persistence for radar state and webhook config.
// Data lives under $DSH_HOME/aihot-radar (default ~/.dsh/aihot-radar), never uploaded.
// NOTE: webhook URL is stored locally in plaintext; a future hardening can move it
// to the dsh-credentials service. The directory is created 0o700.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, statSync } from 'node:fs'
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
    // Stored footer preference. The panel switch that wrote it is gone with the
    // built-in promo line, so this is now legacy data: an explicit `false` still
    // suppresses a profile signatureText, while `true` can no longer add a line.
    notify: { signature: null },
    // Set the moment a channel is configured for the first time. The next scan
    // uses it to baseline the 已到账 history AIHOT still returns, so a new user's
    // first card is a live event instead of a week-old backlog. Cleared by that
    // scan; null means nothing to baseline.
    baselineConfirmed: null,
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
      notify: { ...d.notify, ...(parsed.notify || {}) },
      lastResult: { ...(parsed.lastResult || {}) },
      delivery: { ...(parsed.delivery || {}) },
      baselineConfirmed: typeof parsed.baselineConfirmed === 'string' ? parsed.baselineConfirmed : null,
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
// A lock whose payload does not parse is aged by its mtime instead: one written
// a moment ago may still be in the middle of being filled in and must not be
// stolen, while one left behind by a crash is recovered instead of blocking
// every future cycle (the failure mode this replaces: a corrupt lock wedged the
// radar forever, because an unreadable file was never considered stale).
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

// Age of a lock file plus whatever could be read from it. The heartbeat stamp is
// the best evidence while the payload parses; one that does not parse at all (a
// crash between create and write, a truncated write, a full disk) falls back to
// the filesystem mtime — the only honest signal left, and exactly what keeps a
// lock created a moment ago from being stolen while it is still being filled in.
// Returns null when there is no lock file at all.
function lockState(lp) {
  let stat
  try { stat = statSync(lp) } catch { return null }
  const cur = readLockFile(lp)
  const ts = Number(cur?.ts)
  const stamped = Number.isFinite(ts) && ts > 0 ? ts : null
  const age = stamped == null ? Date.now() - (Number(stat.mtimeMs) || 0) : Date.now() - stamped
  return { age, cur }
}

// The takeover guard has the same failure mode as the lock: a crashed takeover
// leaves a file behind, and a half-written one must not block every later
// attempt. Age it the same way, and treat "cannot even stat it" as ancient.
function guardAge(guard) {
  const cur = readLockFile(guard)
  const ts = Number(cur?.ts)
  if (Number.isFinite(ts) && ts > 0) return Date.now() - ts
  try { return Date.now() - (Number(statSync(guard).mtimeMs) || 0) } catch { return Infinity }
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
function takeOverStaleLock(lp, stamp, depth = 0) {
  const guard = takeoverPath()
  try {
    writeFileSync(guard, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
  } catch {
    // A crashed takeover must not wedge every future one — including one that
    // died mid-write and left an unparseable guard behind. Clearing that debris
    // is not a takeover in itself, so retry once instead of burning a cycle.
    if (guardAge(guard) > 5000) {
      try { unlinkSync(guard) } catch { return false }
      if (depth === 0) return takeOverStaleLock(lp, stamp, 1)
    }
    return false
  }
  try {
    const info = lockState(lp)
    // No file (it vanished between attempts), or a holder younger than the TTL:
    // leave it alone. An unreadable file only qualifies once its mtime is older
    // than the TTL, i.e. older than any live cycle could need to write it.
    if (!info || info.age <= LOCK_TTL_MS) return false
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
  if (takeOverStaleLock(lp, stamp)) {
    logger?.info?.('已接管超时锁：原持有者既不更新心跳也不释放，按崩溃处理')
    lockDepth = 1
    startHeartbeat()
    return true
  }
  const info = lockState(lp)
  const pid = Number(info?.cur?.pid) || 0
  logger?.warn?.(pid
    ? `state.json 被进程 ${pid} 锁定，本次跳过（避免重复推送）`
    : info
      ? 'state.json 锁文件暂时无法解析（可能正在写入），本次跳过'
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
  if (disk.notify && typeof disk.notify === 'object') state.notify = { ...(state.notify || {}), ...disk.notify }
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
  // Shared flag written by the panel (first configuration) and consumed by the
  // radar. The file always decides, including an explicit null: the panel persists
  // the marker in the same write that sets it, so a string only in this process's
  // memory is a stale copy. Keeping it would let an instance that missed the
  // radar's clear hand the consumed marker back on its next save.
  state.baselineConfirmed = typeof disk.baselineConfirmed === 'string' ? disk.baselineConfirmed : null
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
// `baselineConfirmed` is runtime-owned but panel-written: the radar consumes it,
// so it belongs here, and a save that does not own it (a footer toggle from
// another instance) then keeps the file's copy instead of erasing the pending
// baseline with that instance's older view of state.
const OWN_RUNTIME = ['seen', 'lastCheck', 'lastResult', 'delivery', 'baselineConfirmed']
const SECTIONS = [...OWN_RUNTIME, 'webhook', 'digestPref', 'digest', 'notify']

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
