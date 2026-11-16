// Scheduled daily digest: fetch the AIHOT daily report (JSON API) at a configured
// Beijing wall-clock time, push via webhook and archive a local Markdown copy.
// Uses a host timer (not dsh-schedule, which is session-bound reminders).
// Programmatic sync uses the JSON /api/v1/dailies endpoint + aihot-api UA (compliance).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, acquireStateLock, mergeStateFromDisk } from './state.js'
import { withSignature } from './notify.js'
import * as T from './time.js'

const RETRY_MS = 10 * 60 * 1000
const MAX_RETRY = 3


// item.source / item.links are objects in the JSON API; extract display strings.
const srcName = (it) => (typeof it.source === 'string' ? it.source : (it.source?.name ?? it.source?.label ?? ''))

// `report.date` is used as the archive file name, so it must be a plain date:
// a payload with "../../x" would otherwise write outside the digest directory.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function assertReportDate(date) {
  const s = String(date ?? '').trim()
  if (!DATE_RE.test(s)) throw new Error(`日报 report.date 非法：${String(date).slice(0, 40)}`)
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`日报 report.date 不是有效日期：${s}`)
  }
  return s
}

// Concise push text from the report JSON, kept within 3000 UTF-8 bytes. The
// full-text link is reserved out of the budget: a truncated card that says
// "全文见链接" without the link is worse than no truncation at all.
export function renderReportText(report) {
  const lines = []
  if (report.lead?.title) lines.push(`头条：${report.lead.title}`)
  if (report.lead?.leadParagraph) lines.push(report.lead.leadParagraph)
  for (const sec of report.sections || []) {
    lines.push('', `【${sec.label}】`)
    for (const it of (sec.items || []).slice(0, 5)) {
      const src = srcName(it)
      lines.push(`- ${it.title}${src ? ` · ${src}` : ''}`)
    }
  }
  const linkLine = report.links?.aihot ? `日报全文：${report.links.aihot}` : ''
  const body = lines.join('\n')
  const full = linkLine ? `${body}\n\n${linkLine}` : body
  if (Buffer.byteLength(full, 'utf8') <= 3000) return full

  const tail = linkLine ? `\n…（已截断，以下为全文链接）\n${linkLine}` : '\n…（已截断）'
  const budget = 3000 - Buffer.byteLength(tail, 'utf8')
  let out = ''
  for (const ch of body) {
    if (Buffer.byteLength(out + ch, 'utf8') > budget) break
    out += ch
  }
  return out + tail
}

// Human-readable Markdown archive generated from the report JSON.
export function renderReportMarkdown(report) {
  const lines = [`# AIHOT 日报 · ${report.date}`, '']
  if (report.windowStart && report.windowEnd) lines.push(`收录 ${report.windowStart} 至 ${report.windowEnd}。`, '')
  if (report.lead?.title) lines.push(`头条：${report.lead.title}`, '')
  if (report.lead?.leadParagraph) lines.push(report.lead.leadParagraph, '')
  for (const sec of report.sections || []) {
    lines.push(`## ${sec.label}`, '')
    ;(sec.items || []).forEach((it, i) => {
      const src = srcName(it)
      lines.push(`${i + 1}. ${it.title}${src ? ` · ${src}` : ''}`)
      if (it.summary) lines.push(`   ${it.summary}`)
    })
    lines.push('')
  }
  if (report.links?.aihot) lines.push(`日报全文：${report.links.aihot}`)
  return lines.join('\n')
}

// Fetch + push + archive one digest. Returns { skipped, ok, date, result }.
// On push failure lastDate is NOT written (caller schedules a retry).
export async function runDigest(api, state, notifier, config = {}, logger) {
  const tz = T.resolveTz(config?.digest?.timezone, logger)
  const { date: today } = T.tzParts(new Date(), tz)
  const data = await api.dailyJson()
  const report = data?.report
  if (!report?.date) throw new Error('日报 JSON 缺少 report.date')
  const date = assertReportDate(report.date)
  if (state.digest?.lastDate === date) return { skipped: true, ok: true, date, reason: 'already-done' }
  // The last attempt on this same period timed out, so it MAY already be posted.
  // Checking this here — not only in the catch-up scheduler — is what stops a
  // second instance's queued timer, or a reschedule after the panel edits the
  // time, from pushing the same digest a second time.
  if (state.digest?.uncertain?.date === date) return { skipped: true, ok: true, date, reason: 'uncertain-today' }
  const stale = date !== today
  const title = `AIHOT 日报 · ${date}` + (stale ? `（未发布今日期，以下为 ${date} 期）` : '')
  if (stale) logger?.warn?.(`日报期号 ${date} 非北京今天 ${today}，仍推送`)
  const text = withSignature(renderReportText(report), config?.notify)
  const result = await notifier.send(state.webhook, title, text)
  try {
    const dir = join(dataDir(), 'digest')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${date}.md`), renderReportMarkdown(report), 'utf8')
  } catch (err) {
    logger?.warn?.(`日报归档失败 ${date}：${String(err?.message || err)}`)
  }
  if (result.skipped || result.ok) {
    state.digest = { ...(state.digest || {}), lastDate: date, retries: 0, retryDate: today, lastError: null, uncertain: null }
    return { skipped: !!result.skipped, ok: !!result.ok, date, result, stale }
  }
  return { ok: false, date, result, stale }
}

// Resolve what actually applies: an explicit panel choice wins, otherwise the
// profile config decides. Deliberately NOT derived from "a webhook is set" —
// upgrading the plugin must never start a new daily push nobody asked for.
export function effectiveDigest(state, config = {}, logger) {
  const pref = state?.digestPref || {}
  const cfg = config.digest || {}
  const explicit = pref.enabled === true || pref.enabled === false
  const enabled = explicit ? pref.enabled : cfg.enabled === true
  return { enabled, time: T.validateTime(pref.time || cfg.time, logger) }
}

// One-off digest push for the panel's "send test" button: same content as the
// scheduled run, but it never touches lastDate, so it cannot swallow (or fake)
// today's real delivery. Throws when the report itself cannot be fetched.
export async function sendDigestNow(api, state, notifier, config = {}, logger) {
  const report = (await api.dailyJson())?.report
  if (!report?.date) throw new Error('日报 JSON 缺少 report.date')
  const date = assertReportDate(report.date)
  const title = `AIHOT 日报 · ${date}（测试）`
  const r = await notifier.send(state.webhook, title, withSignature(renderReportText(report), config?.notify))
  logger?.info?.(`日报测试推送 ${date}：${r.ok ? '成功' : r.error}`)
  return {
    ok: !!r.ok, error: r.ok ? null : (r.error || ''), chunks: r.chunks || 0,
    status: r.status || 0, code: r.code ?? null, date,
  }
}

// Has today's digest already been dealt with? A confirmed push sets lastDate; a
// push whose delivery is unknown sets digest.uncertain.date — re-sending either
// could post the same report twice, so both block the catch-up path (a restart
// must not turn "maybe delivered" into "delivered twice").
export function alreadyHandledToday(state, date) {
  if (state?.digest?.lastDate === date) return true
  return state?.digest?.uncertain?.date === date
}

// Classify one delivery attempt so the scheduler and the tests agree on whether
// it may be retried. A timeout is "delivered, unknown": it is recorded and never
// re-sent automatically, because the same digest landing twice in a group is
// worse than one that may be missing.
export function digestOutcome(state, r, today, logger) {
  const error = r?.result?.error || r?.error || 'push failed'
  const uncertain = r?.result?.timeout === true || r?.result?.uncertain === true
  if (uncertain) {
    state.digest = {
      ...(state.digest || {}),
      retries: 0,
      retryDate: today,
      lastError: error,
      uncertain: { date: r?.date || today, at: new Date().toISOString(), error },
    }
    logger?.warn?.(`日报推送超时，送达不确定（不自动重发）：${error}`)
    return { retry: false, uncertain: true, retries: 0, error }
  }
  const retries = (state.digest?.retries || 0) + 1
  state.digest = { ...(state.digest || {}), retries, retryDate: today, lastError: error }
  return { retry: retries < MAX_RETRY, uncertain: false, retries, error }
}

export function startDigest({ api, state, notifier, config, save, onDigest, logger }) {
  const cfg = config.digest || {}
  const tz = T.resolveTz(cfg.timezone, logger)
  let stopped = false
  let timer = null

  // Always started (even when off) so the panel can switch it on without a
  // restart; fire() re-reads the preference at every tick.
  const current = () => effectiveDigest(state, config, logger)
  const nextRunAt = () => Date.now() + T.msUntilNext(current().time, new Date(), tz)

  function scheduleNext(ms) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, ms)
  }
  function scheduleAtConfiguredTime() { scheduleNext(T.msUntilNext(current().time, new Date(), tz)) }

  // Optional catch-up (digest.catchUp): starting the host at 09:00 otherwise
  // means today's 08:30 digest silently never happens. Opt-in, and it still
  // respects today's outcome so a restart loop cannot spam the channel.
  function catchUpDelay() {
    if (cfg.catchUp !== true || !current().enabled) return 0
    const now = new Date()
    const { date, minutes } = T.tzParts(now, tz)
    const [hh, mm] = String(current().time).split(':').map(Number)
    if (!Number.isFinite(hh) || minutes <= hh * 60 + (Number.isFinite(mm) ? mm : 0)) return 0
    if (alreadyHandledToday(state, date)) return 0
    return 20000 // let the host settle (network / webhook warm-up) first
  }

  async function fire() {
    if (stopped) return
    if (!current().enabled) {
      logger?.debug?.('日报未开启，跳过本次')
      scheduleAtConfiguredTime()
      return
    }
    // Decide-and-push-and-save is one critical section: two instances that both
    // read "not sent today" would otherwise push the same digest twice. The lock
    // is the same one the radar uses, so a concurrent scan just defers us.
    const release = acquireStateLock(logger)
    if (!release) {
      logger?.debug?.('另一实例正在处理日报/雷达，10 秒后再试')
      scheduleNext(10000)
      return
    }
    try {
      mergeStateFromDisk(state) // pick up the other instance's lastDate / webhook edit
      // Re-read the switch AFTER the merge: the panel may have turned the digest
      // off from another instance while this timer was already queued, and the
      // pre-lock check above ran against the stale in-memory copy.
      if (!current().enabled) {
        logger?.info?.('日报已关闭（包含另一实例的改动），本次不发送')
        scheduleAtConfiguredTime()
        return
      }
      await fireLocked()
    } finally {
      release()
    }
  }

  async function fireLocked() {
    const today = T.tzParts(new Date(), tz).date
    // Cross-day reset of the retry counter.
    if (state.digest?.retryDate !== today) {
      state.digest = { ...(state.digest || {}), retries: 0, retryDate: today }
    }
    let r
    try { r = await runDigest(api, state, notifier, config, logger) }
    catch (err) { r = { ok: false, error: String(err?.message || err) } }

    if (r.skipped || r.ok) {
      save?.(state); onDigest?.(r)
      logger?.debug?.(`日报完成 ${r.date}${r.skipped ? `（跳过：${r.reason || '未配置 webhook'}）` : ''}`)
      scheduleAtConfiguredTime()
      return
    }

    const outcome = digestOutcome(state, r, today, logger)
    save?.(state); onDigest?.({ ...r, retries: outcome.retries, uncertain: outcome.uncertain })
    if (outcome.uncertain) {
      // Recorded, not retried: waiting 10 minutes to re-send a card that may
      // already be in the group is exactly the duplicate this plugin avoids.
      logger?.info?.(`日报今日不再重发（送达不确定）：${outcome.error}`)
      scheduleAtConfiguredTime()
      return
    }
    if (outcome.retry) {
      logger?.warn?.(`日报推送失败 ${outcome.retries}/${MAX_RETRY}，10分钟后重试：${outcome.error}`)
      scheduleNext(RETRY_MS)
    } else {
      logger?.error?.(`日报推送重试耗尽（${MAX_RETRY}次），今日放弃：${outcome.error}`)
      scheduleAtConfiguredTime()
    }
  }

  const catchUpIn = catchUpDelay()
  if (catchUpIn) {
    logger?.info?.(`日报今日窗口已过且未推送，${Math.round(catchUpIn / 1000)} 秒后补发一次`)
    scheduleNext(catchUpIn)
  } else scheduleAtConfiguredTime()

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer) },
    // Called after the panel saves a new time/switch: apply it now, not at the
    // next configured tick (otherwise "I changed it" looks broken for a day).
    reschedule() { if (!stopped) scheduleAtConfiguredTime() },
    nextRunAt,
    // One locked pass, the same code path the timer takes. Used by the tests to
    // drive a tick deterministically instead of waiting for wall-clock time.
    tick: fire,
  }
}