// Quota-reset radar: poll AIHOT /resets/recent, dedup by event id+status
// (plus AIHOT-inferred presentation states), push on new announcements and
// confirmed transitions. scanProvider is pure-ish (injectable api/notifier).

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RateLimitError } from './api.js'
import { formatResetMessage, formatInferredMessage } from './notify.js'
import { dataDir } from './state.js'
import * as T from './time.js'

const MAX_NOTIFY_PER_CYCLE = 5

// Re-read shared seen/lastCheck from disk so a second instance (e.g. desktop +
// web on the same DSH_HOME) sees keys the first instance already pushed. This is
// best-effort cross-instance dedup (not a mutex); on read failure keep memory.
export function refreshSeen(state) {
  try {
    const disk = JSON.parse(readFileSync(join(dataDir(), 'state.json'), 'utf8'))
    if (disk && disk.seen && typeof disk.seen === 'object') {
      for (const p of Object.keys(disk.seen)) {
        const arr = Array.isArray(disk.seen[p]) ? disk.seen[p] : []
        state.seen[p] = [...new Set([...(state.seen[p] || []), ...arr])]
      }
    }
    if (disk && disk.lastCheck && typeof disk.lastCheck === 'object') {
      state.lastCheck = { ...state.lastCheck, ...disk.lastCheck }
    }
  } catch { /* keep in-memory state */ }
}

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
    seenSet.add(key)
    const { title, text } = inferred
      ? formatInferredMessage(provider, event, notify)
      : formatResetMessage(provider, event, notify)
    const result = await notifier.send(webhook, title, text)
    notified.push({ event, result })
  }

  // Trim seen to the current snapshot so it cannot grow without bound.
  state.seen[provider] = [...seenSet].filter((k) => currentKeys.has(k))
  state.lastCheck[provider] = new Date().toISOString()
  const pending = events.filter((e) => e.status === 'announced')
  return {
    provider, notified, pending, events,
    checkedAt: state.lastCheck[provider],
    monitor: data?.monitor?.status || 'unknown',
    outage: data?.outage || null,
    apiCheckedAt: data?.checkedAt || null,
  }
}

// Start the polling loop. Returns a stop() function.
export function startRadar({ api, state, notifier, config, onScan }) {
  const radar = config.radar || {}
  if (radar.enabled === false) return () => {}
  const providers = (radar.providers && radar.providers.length ? radar.providers : api.PROVIDERS)
  const intervalMs = Math.max(60, radar.pollSeconds ?? 120) * 1000
  const tz = T.resolveTz(config.digest?.timezone)
  const mutedList = Array.isArray(radar.muted) ? radar.muted : []
  let stopped = false
  let timer = null
  let lastMtime = 0

  function maybeRefresh() {
    try {
      const st = statSync(join(dataDir(), 'state.json'))
      if (st.mtimeMs === lastMtime) return
      lastMtime = st.mtimeMs
      refreshSeen(state)
    } catch { /* no state file yet */ }
  }

  async function cycle() {
    if (stopped) return
    maybeRefresh()
    let nextDelay = intervalMs
    const quiet = T.isQuietNow(radar.quiet, new Date(), tz)
    for (const provider of providers) {
      if (stopped) break
      try {
        const result = await scanProvider(api, provider, state, notifier, {
          notifyAnnounced: radar.notifyAnnounced !== false,
          notifyConfirmed: radar.notifyConfirmed !== false,
          muted: mutedList.includes(provider),
          quiet,
          notify: config.notify || {},
        })
        onScan?.(result)
      } catch (err) {
        if (err instanceof RateLimitError) {
          onScan?.({ provider, error: err.message, rateLimited: true })
          // Back off: skip remaining providers this cycle and delay the next one.
          nextDelay = Math.max(nextDelay, err.retryAfterSeconds * 1000)
          break
        }
        onScan?.({ provider, error: String(err?.message || err) })
      }
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