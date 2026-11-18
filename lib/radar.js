// Quota-reset radar: poll AIHOT /resets/recent, dedup by event id+status
// (plus AIHOT-inferred presentation states), push on new announcements and
// confirmed transitions. scanProvider is pure-ish (injectable api/notifier).
//
// Delivery model: an event is only marked seen AFTER the channel accepted it.
// A definite failure stays unseen so the next cycle retries it (bounded, so a
// wrong webhook cannot loop forever); a timeout is "delivered, unknown" — it is
// recorded instead of being retried, because re-sending could double the card.

import { RateLimitError } from './api.js'
import { formatResetMessage, formatInferredMessage } from './notify.js'
import { acquireStateLock, mergeStateFromDisk, touchStateLock } from './state.js'
import * as T from './time.js'

const MAX_NOTIFY_PER_CYCLE = 5
// A permanently broken webhook must not retry an event forever; after this many
// definite failures the key is retired (and left in state.delivery for the panel).
const MAX_SEND_ATTEMPTS = 5

// AIHOT-inferred presentation states that warrant a light, unconfirmed notice.
function isInferred(event) {
  const ps = event.presentation?.status
  return event.status === 'announced' && (ps === 'expired_unconfirmed' || ps === 'likely_completed')
}

function keyOf(event) {
  if (isInferred(event)) return `${event.id}:${event.status}:${event.presentation.status}`
  // in_progress maps to the plain announced key so it never re-pushes.
  return `${event.id}:${event.status}`
}

function deliveryOf(state, provider) {
  if (!state.delivery || typeof state.delivery !== 'object') state.delivery = {}
  const cur = state.delivery[provider]
  if (!cur || typeof cur !== 'object') state.delivery[provider] = {}
  return state.delivery[provider]
}

// Timeout / connection reset mid-flight: the card may or may not have landed.
// Retrying would risk a duplicate in a shared group, so it is recorded instead.
function isUncertain(result) {
  return result?.timeout === true || result?.uncertain === true
}

// Scan one provider. Mutates state.seen[provider]; returns scan result.
export async function scanProvider(api, provider, state, notifier, opts = {}) {
  const {
    notifyAnnounced = true,
    notifyConfirmed = true,
    webhook = state.webhook,
    muted = false,
    quiet = false,
    notify = {},
  } = opts
  const data = await api.resetsRecent(provider)
  const events = Array.isArray(data?.events) ? data.events : []
  const currentKeys = new Set(events.map(keyOf))
  const seen = state.seen[provider]
  const firstRun = seen === undefined
  const seenSet = new Set(seen || [])
  const notified = []
  const retrying = []
  const uncertain = []
  const gaveUp = []
  const paused = []
  const delivery = deliveryOf(state, provider)

  for (const event of events) {
    const key = keyOf(event)
    if (seenSet.has(key)) continue
    const inferred = isInferred(event)
    const normalAnnounced = event.status === 'announced' && !inferred
    // First run: baseline non-announced history silently (never push later).
    if (firstRun && !normalAnnounced) { seenSet.add(key); continue }
    // Config-suppressed kinds are marked seen so toggling later won't spam old events.
    if (inferred && !notifyConfirmed) { seenSet.add(key); continue }
    if (normalAnnounced && !notifyAnnounced) { seenSet.add(key); continue }
    if (event.status === 'confirmed' && !notifyConfirmed) { seenSet.add(key); continue }
    // Per-provider mute: suppress and mark seen so unmuting later won't spam.
    if (muted) { seenSet.add(key); continue }
    // Quiet hours: defer (leave unseen) so the event pushes after the window.
    if (quiet) continue
    // Per-cycle cap BEFORE marking seen, so overflow is deferred to the next cycle.
    if (notified.length >= MAX_NOTIFY_PER_CYCLE) continue
    const { title, text } = inferred
      ? formatInferredMessage(provider, event, notify)
      : formatResetMessage(provider, event, notify)
    const result = await notifier.send(webhook, title, text)

    // No channel configured, or the user switched it off: pause. This is not a
    // failure — charging it to the retry budget would retire the event after 5
    // quiet cycles and lose it forever.
    if (result?.skipped) { paused.push({ key, error: result.error || 'no webhook configured' }); continue }

    if (result?.ok) {
      seenSet.add(key)
      delete delivery[key]
      notified.push({ event, result, delivered: true })
      continue
    }

    const attempts = (delivery[key]?.attempts || 0) + 1
    const at = new Date().toISOString()
    const error = result?.error || 'push failed'
    notified.push({ event, result, attempts, uncertain: isUncertain(result) })

    if (isUncertain(result)) {
      // Not retried (a duplicate is worse than a maybe-missed card), but not
      // silently swallowed either: the key is recorded so status/panel shows it.
      seenSet.add(key)
      delivery[key] = { attempts, state: 'uncertain', at, error }
      uncertain.push({ key, error })
    } else if (attempts >= MAX_SEND_ATTEMPTS) {
      seenSet.add(key)
      delivery[key] = { attempts, state: 'gave-up', at, error }
      gaveUp.push({ key, attempts, error })
    } else {
      // Definite failure: leave the key unseen so the next cycle retries it.
      delivery[key] = { attempts, state: 'retrying', at, error }
      retrying.push({ key, attempts, error })
    }
  }

  // Trim seen to the current snapshot so it cannot grow without bound.
  state.seen[provider] = [...seenSet].filter((k) => currentKeys.has(k))
  for (const key of Object.keys(delivery)) {
    if (!currentKeys.has(key)) delete delivery[key]
  }
  state.lastCheck[provider] = new Date().toISOString()
  // Only genuinely open announcements are pending: AIHOT keeps expired ones in
  // the 7-day window with status "announced" but presentation.status flipped to
  // an inferred state, and its own monitor.pendingCount already excludes them.
  const pending = events.filter((e) => e.status === 'announced' && !isInferred(e))
  return {
    provider, notified, pending, events,
    retrying, uncertain, gaveUp, paused,
    checkedAt: state.lastCheck[provider],
    monitor: data?.monitor?.status || 'unknown',
    outage: data?.outage || null,
    apiCheckedAt: data?.checkedAt || null,
  }
}

// One scan cycle across every provider, holding the cross-instance lock for the
// whole read-decide-push-write sequence. Without that, two instances each read
// "unseen", each push, and the later writer silently drops the other's keys.
// Returns { locked, results, retryAfterSeconds? }; callers skip when !locked.
export async function scanCycle({ api, state, notifier, config = {}, onScan, logger } = {}) {
  const radar = config.radar || {}
  const providers = (radar.providers && radar.providers.length ? radar.providers : api.PROVIDERS)
  const release = acquireStateLock(logger)
  if (!release) return { locked: false, results: [] }
  const results = []
  try {
    // Under the lock: pick up the other instance's dedupe keys and panel edits
    // instead of overwriting them with this process's stale copy.
    mergeStateFromDisk(state)
    const tz = T.resolveTz(config.digest?.timezone)
    const quiet = T.isQuietNow(radar.quiet, new Date(), tz)
    const mutedList = Array.isArray(radar.muted) ? radar.muted : []
    for (const provider of providers) {
      // The heartbeat normally keeps the lock alive; if it was taken over anyway
      // (e.g. this process was suspended), stop pushing instead of racing the
      // new holder — a second push is exactly what the lock exists to prevent.
      if (!touchStateLock()) {
        logger?.warn?.('state.json 锁已被其他实例接管，本轮中止（避免重复推送）')
        return { locked: false, results, lostLock: true }
      }
      try {
        const result = await scanProvider(api, provider, state, notifier, {
          notifyAnnounced: radar.notifyAnnounced !== false,
          notifyConfirmed: radar.notifyConfirmed !== false,
          muted: mutedList.includes(provider),
          quiet,
          notify: config.notify || {},
        })
        results.push(result)
        onScan?.(result)
      } catch (err) {
        if (err instanceof RateLimitError) {
          const result = { provider, error: err.message, rateLimited: true }
          results.push(result)
          onScan?.(result)
          // Back off: skip remaining providers this cycle and delay the next one.
          return { locked: true, results, retryAfterSeconds: err.retryAfterSeconds }
        }
        const result = { provider, error: String(err?.message || err) }
        results.push(result)
        onScan?.(result)
      }
    }
    return { locked: true, results }
  } finally {
    release()
  }
}

// Start the polling loop. Returns a stop() function.
export function startRadar({ api, state, notifier, config, onScan, logger }) {
  const radar = config.radar || {}
  if (radar.enabled === false) return () => {}
  const intervalMs = Math.max(60, radar.pollSeconds ?? 120) * 1000
  let stopped = false
  let timer = null

  async function cycle() {
    if (stopped) return
    let nextDelay = intervalMs
    const out = await scanCycle({ api, state, notifier, config, onScan, logger })
    if (!out.locked) {
      // Another instance is mid-cycle; it owns this round's pushes.
      logger?.debug?.('另一实例正在扫描，本周期跳过（避免重复推送）')
    } else if (out.retryAfterSeconds) {
      nextDelay = Math.max(nextDelay, out.retryAfterSeconds * 1000)
    }
    if (!stopped) timer = setTimeout(cycle, nextDelay)
  }

  // First scan shortly after activation, then on interval.
  timer = setTimeout(cycle, 3000)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
