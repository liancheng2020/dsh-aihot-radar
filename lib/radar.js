// Quota-reset radar: poll AIHOT /resets/recent, dedup by event id+status,
// push on new announcements and confirmed transitions.
// scanProvider is pure-ish (injectable api/notifier) so it can be unit-tested.

import { RateLimitError } from './api.js'
import { formatResetMessage } from './notify.js'

const MAX_NOTIFY_PER_CYCLE = 5

function keyOf(event) {
  return `${event.id}:${event.status}`
}

// Scan one provider. Mutates state.seen[provider]; returns scan result.
export async function scanProvider(api, provider, state, notifier, opts = {}) {
  const {
    notifyAnnounced = true,
    notifyConfirmed = true,
    webhook = state.webhook,
  } = opts
  const data = await api.resetsRecent(provider)
  const events = Array.isArray(data?.events) ? data.events : []
  const seen = state.seen[provider]
  const firstRun = seen === undefined
  const seenSet = new Set(seen || [])
  const notified = []

  for (const event of events) {
    const key = keyOf(event)
    if (seenSet.has(key)) continue
    seenSet.add(key)
    // On first run only surface pending announcements (actionable), not history.
    if (firstRun && event.status !== 'announced') continue
    if (event.status === 'announced' && !notifyAnnounced) continue
    if (event.status === 'confirmed' && !notifyConfirmed) continue
    if (notified.length >= MAX_NOTIFY_PER_CYCLE) continue
    const { title, text } = formatResetMessage(provider, event)
    const result = await notifier.send(webhook, title, text)
    notified.push({ event, result })
  }

  state.seen[provider] = [...seenSet]
  state.lastCheck[provider] = new Date().toISOString()
  const pending = events.filter((e) => e.status === 'announced')
  return { provider, notified, pending, events, checkedAt: state.lastCheck[provider] }
}

// Start the polling loop. Returns a stop() function.
export function startRadar({ api, state, notifier, config, save, onScan }) {
  const radar = config.radar || {}
  if (radar.enabled === false) return () => {}
  const providers = (radar.providers && radar.providers.length ? radar.providers : api.PROVIDERS)
  const intervalMs = Math.max(60, radar.pollSeconds ?? 120) * 1000
  let stopped = false
  let timer = null

  async function cycle() {
    if (stopped) return
    for (const provider of providers) {
      if (stopped) break
      try {
        const result = await scanProvider(api, provider, state, notifier, {
          notifyAnnounced: radar.notifyAnnounced !== false,
          notifyConfirmed: radar.notifyConfirmed !== false,
        })
        save?.(state)
        onScan?.(result)
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Back off; the next cycle retries. Do not parallel-retry.
          onScan?.({ provider, error: err.message, rateLimited: true })
        } else {
          onScan?.({ provider, error: String(err?.message || err) })
        }
      }
    }
    if (!stopped) timer = setTimeout(cycle, intervalMs)
  }

  // First scan shortly after activation, then on interval.
  timer = setTimeout(cycle, 3000)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}