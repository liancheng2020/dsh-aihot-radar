// Scheduled daily digest: fetch the AIHOT daily report at a configured Beijing
// wall-clock time, push via webhook and archive a local Markdown copy.
// Uses a host timer (not dsh-schedule, which is session-bound reminders).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './state.js'

const TZ = 'Asia/Shanghai'

export function beijingParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const hour = Number(parts.hour === '24' ? '0' : parts.hour)
  const minutes = hour * 60 + Number(parts.minute)
  return { date, minutes, hour, minute: Number(parts.minute) }
}

// Milliseconds until the next occurrence of HH:mm Beijing time.
export function msUntilNext(timeHHmm, now = new Date()) {
  const [h, m] = timeHHmm.split(':').map(Number)
  const target = h * 60 + (m || 0)
  const { minutes } = beijingParts(now)
  let deltaMin = target - minutes
  if (deltaMin <= 0) deltaMin += 24 * 60
  // Align to the wall clock: subtract current seconds/ms so we fire near :00.
  const sec = now.getSeconds() * 1000 + now.getMilliseconds()
  return deltaMin * 60 * 1000 - sec
}

export async function runDigest(api, state, notifier, config = {}) {
  const digest = config.digest || {}
  const { date } = beijingParts()
  if (state.digest?.lastDate === date) return { skipped: true, date }
  const markdown = await api.daily()
  const title = `AIHOT 日报 · ${date}`
  const result = await notifier.send(state.webhook, title, markdown)
  try {
    const dir = join(dataDir(), 'digest')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${date}.md`), markdown, 'utf8')
  } catch {
    // Archiving is best-effort; push still succeeded.
  }
  state.digest = { ...(state.digest || {}), lastDate: date }
  return { skipped: false, date, result, chars: markdown.length }
}

export function startDigest({ api, state, notifier, config, save, onDigest }) {
  const digest = config.digest || {}
  if (digest.enabled !== true) return () => {}
  const time = /^\d{2}:\d{2}$/.test(digest.time || '') ? digest.time : '08:30'
  let stopped = false
  let timer = null

  function schedule() {
    if (stopped) return
    timer = setTimeout(async () => {
      if (stopped) return
      try {
        const result = await runDigest(api, state, notifier, config)
        save?.(state)
        onDigest?.(result)
      } catch (err) {
        onDigest?.({ error: String(err?.message || err) })
      }
      schedule()
    }, msUntilNext(time))
  }

  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}