// Scheduled daily digest: fetch the AIHOT daily report (JSON API) at a configured
// Beijing wall-clock time, push via webhook and archive a local Markdown copy.
// Uses a host timer (not dsh-schedule, which is session-bound reminders).
// Programmatic sync uses the JSON /api/v1/dailies endpoint + aihot-api UA (compliance).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './state.js'
import { withSignature } from './notify.js'
import * as T from './time.js'

const RETRY_MS = 10 * 60 * 1000
const MAX_RETRY = 3

export const validateTime = T.validateTime
export const msUntilNext = (timeHHmm, now = new Date(), tz = T.DEFAULT_TZ) => T.msUntilNext(timeHHmm, now, tz)
export const beijingParts = (now = new Date(), tz = T.DEFAULT_TZ) => T.tzParts(now, tz)

// item.source / item.links are objects in the JSON API; extract display strings.
const srcName = (it) => (typeof it.source === 'string' ? it.source : (it.source?.name ?? it.source?.label ?? ''))

// Concise push text from the report JSON, kept within 3000 UTF-8 bytes.
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
  if (report.links?.aihot) lines.push('', `日报全文：${report.links.aihot}`)
  let text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') > 3000) {
    let out = ''
    for (const ch of text) {
      if (Buffer.byteLength(out + ch, 'utf8') > 2950) break
      out += ch
    }
    text = out + '\n…（已截断，全文见链接）'
  }
  return text
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
  const date = report.date
  if (state.digest?.lastDate === date) return { skipped: true, ok: true, date, reason: 'already-done' }
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
    state.digest = { ...(state.digest || {}), lastDate: date, retries: 0, retryDate: today, lastError: null }
    return { skipped: !!result.skipped, ok: !!result.ok, date, result, stale }
  }
  return { ok: false, date, result, stale }
}

export function startDigest({ api, state, notifier, config, save, onDigest, logger }) {
  const digest = config.digest || {}
  if (digest.enabled !== true) return () => {}
  const time = validateTime(digest.time, logger)
  const tz = T.resolveTz(digest.timezone, logger)
  let stopped = false
  let timer = null

  function scheduleNext(ms) { if (!stopped) timer = setTimeout(fire, ms) }

  async function fire() {
    if (stopped) return
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
      logger?.debug?.(`日报完成 ${r.date}${r.skipped ? '（仅归档，未配置 webhook）' : ''}`)
      scheduleNext(msUntilNext(time, new Date(), tz))
      return
    }

    const retries = (state.digest?.retries || 0) + 1
    const errMsg = r.result?.error || r.error || 'push failed'
    state.digest = { ...(state.digest || {}), retries, retryDate: today, lastError: errMsg }
    save?.(state); onDigest?.({ ...r, retries })
    if (retries < MAX_RETRY) {
      logger?.warn?.(`日报推送失败 ${retries}/${MAX_RETRY}，10分钟后重试：${errMsg}`)
      scheduleNext(RETRY_MS)
    } else {
      logger?.error?.(`日报推送重试耗尽（${MAX_RETRY}次），今日放弃：${errMsg}`)
      scheduleNext(msUntilNext(time, new Date(), tz))
    }
  }

  scheduleNext(msUntilNext(time, new Date(), tz))
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}