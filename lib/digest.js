// Scheduled daily digest: fetch the AIHOT daily report (JSON API) at a configured
// Beijing wall-clock time, push via webhook and archive a local Markdown copy.
// Uses a host timer (not dsh-schedule, which is session-bound reminders).
// Programmatic sync uses the JSON /api/v1/dailies endpoint + aihot-api UA (compliance).

import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { dataDir, acquireStateLock, mergeStateFromDisk } from './state.js'
import { withSignature, effectiveNotify } from './notify.js'

// Single resolver for every digest path: the panel switch wins over the profile
// config, so the scheduled push and "send test" cannot disagree about the footer.
const notifyFor = (config, state) => effectiveNotify(config?.notify, state)
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
// lastDate is written only when the channel confirmed the send: a report that was
// merely archived is recorded under `archived`, and the period stays pending.
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
  // Same brand prefix as the reset cards, so every channel shows one family of
  // titles and the digest stays identifiable with the footer switched off.
  const title = `AIHOT 雷达 · 日报 ${date}` + (stale ? `（未发布今日期，以下为 ${date} 期）` : '')
  if (stale) logger?.warn?.(`日报期号 ${date} 非北京今天 ${today}，仍推送`)
  const text = withSignature(renderReportText(report), notifyFor(config, state))
  const channel = state.webhook?.channel || 'none'
  // Piece indexes are only meaningful for the exact same message on the exact
  // same target: a changed report (or a channel with a different size limit)
  // re-chunks into different pieces, and resuming by index would then leave a
  // hole or repeat a part. The hash makes "same message" checkable.
  const hash = createHash('sha1').update(text).digest('hex')
  // The target — not just the channel type — is part of that identity. Swapping
  // in another 企微 bot keeps channel === 'wecom' while having none of the pieces
  // the old bot received; resuming there would silently skip the first chunk and
  // then report the digest as fully delivered.
  const target = createHash('sha1')
    .update(`${channel}\u0000${state.webhook?.url || ''}\u0000${state.webhook?.secret || ''}`)
    .digest('hex')
  const prev = state.digest?.partial
  const prevTarget = typeof prev?.target === 'string' ? prev.target : null
  const sameDate = prev?.date === date
  const sameTarget = prevTarget != null && prevTarget === target
  const sameText = sameDate && prev?.hash === hash
  const resumeOk = sameTarget && sameText
  // Auto-resume needs BOTH to match. `delivered` describes what that receiver
  // already has, so it is only reusable for the same receiver and the same
  // bytes: a changed footer re-chunks the report (resuming by index would skip
  // or repeat a part), and a record with no receiver at all — written before
  // `target` existed — cannot be attributed to the channel we are about to use.
  // In both cases nothing is sent: guessing costs a duplicate card, and the
  // honest state is "partially delivered, waiting for a decision".
  const blockedPartial = !!prev && sameDate && !resumeOk && (prevTarget == null || sameTarget)
  if (blockedPartial) {
    const reason = prevTarget == null
      ? '旧续传记录缺少接收端标识，无法确认已送达的段属于当前通道'
      : '内容与上次不同（例如改了尾注），分段位置可能变化，继续补发会重复或漏段'
    logger?.warn?.(`日报 ${date} 部分送达 ${prev.delivered?.length || 0}/${prev.total || '?'} 段，未自动补发：${reason}。如需补发请手动发送。`)
    state.digest = { ...(state.digest || {}), lastError: reason, retries: 0 }
    return {
      ok: false, date, stale, resumed: 0, blocked: true, error: reason,
      delivered: Array.isArray(prev.delivered) ? prev.delivered.length : 0,
      total: Number(prev.total) || 0,
    }
  }
  // A different, known receiver simply has none of the pieces yet, so it gets the
  // whole report — that is not a duplicate anywhere.
  const resume = resumeOk && Array.isArray(prev.delivered) ? prev.delivered : []
  const result = await notifier.send(state.webhook, title, text, resume.length ? { skip: resume } : {})
  // Archiving is local and happens either way, so it is recorded on its own key:
  // "the report is on disk" must never be read as "the group got it".
  let archived = false
  try {
    const dir = join(dataDir(), 'digest')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${date}.md`), renderReportMarkdown(report), 'utf8')
    archived = true
    state.digest = { ...(state.digest || {}), archived: { date, at: new Date().toISOString() } }
  } catch (err) {
    logger?.warn?.(`日报归档失败 ${date}：${String(err?.message || err)}`)
  }
  const delivered = Array.isArray(result.delivered) ? result.delivered : []
  const total = Number(result.total) || Number(result.chunks) || 0
  if (result.ok && !result.skipped) {
    state.digest = { ...(state.digest || {}), lastDate: date, retries: 0, retryDate: today, lastError: null, uncertain: null, partial: null }
    return { ok: true, date, result, stale, resumed: resume.length, archived }
  }
  if (result.skipped) {
    // Nothing left the machine — no channel, or pushing is off. The period stays
    // pending: writing lastDate here would make the panel claim a delivery that
    // never happened, and the period would then be skipped once a channel exists.
    const reason = result.error || '未配置推送通道'
    state.digest = { ...(state.digest || {}), retries: 0, retryDate: today, lastError: null }
    return { ok: false, skipped: true, noChannel: true, date, reason, archived, stale, resumed: 0 }
  }
  // Definite failure with known progress: remember which pieces landed so the
  // retry posts only the rest. A timed-out piece may have arrived, so nothing is
  // stored for resumption — the scheduler stops instead of risking a duplicate.
  state.digest = {
    ...(state.digest || {}),
    partial: (result.timeout || !delivered.length || !total)
      ? null
      : { date, hash, channel, target, delivered, total, at: new Date().toISOString() },
  }
  return { ok: false, date, result, stale, resumed: resume.length, delivered: delivered.length, total }
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
  const title = `AIHOT 雷达 · 日报 ${date}（测试）`
  const r = await notifier.send(state.webhook, title, withSignature(renderReportText(report), notifyFor(config, state)))
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
    // Progress is reported, not resumed: the missing piece may already be in the
    // group, so the honest answer is "unknown" and the day stops here.
    const progress = Number(r?.total) ? { delivered: Number(r.delivered) || 0, total: Number(r.total) } : {}
    state.digest = {
      ...(state.digest || {}),
      retries: 0,
      retryDate: today,
      lastError: error,
      partial: null,
      uncertain: { date: r?.date || today, at: new Date().toISOString(), error, ...progress },
    }
    const done = progress.total ? `（已确认送达 ${progress.delivered}/${progress.total} 段）` : ''
    logger?.warn?.(`日报推送超时，送达不确定${done}（不自动重发）：${error}`)
    return { retry: false, uncertain: true, retries: 0, error, ...progress }
  }
  if (r?.blocked) {
    // Nothing was sent: the pieces that landed cannot be continued safely, so
    // retrying on a timer would only walk into the same wall. Keep the partial
    // record (the panel still reports 部分送达) and stop the automatic path —
    // sending the remaining content is a manual decision from here.
    state.digest = { ...(state.digest || {}), retries: 0, retryDate: today, lastError: error }
    logger?.warn?.(`日报今日不再自动补发（已送达的段不会重发）：${error}`)
    return { retry: false, uncertain: false, blocked: true, retries: 0, error }
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
      if (r.noChannel) {
        // Nothing was sent, so the period stays pending — and the log must state what
        // actually happened: a failed archive is not an archive.
        const why = r.reason || '未配置推送通道'
        logger?.info?.(r.archived
          ? `日报 ${r.date} 已归档到本地，未推送（${why}）；该期仍算未送达`
          : `日报 ${r.date} 归档失败，未推送（${why}）；该期仍算未送达`)
      } else {
        logger?.debug?.(`日报完成 ${r.date}${r.skipped ? `（跳过：${r.reason || ''}）` : ''}`)
      }
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
    if (outcome.blocked) {
      // Not a failure to retry and not a delivery either: the day ends here with
      // the partial record intact, and the log says why.
      scheduleAtConfiguredTime()
      return
    }
    if (outcome.retry) {
      // Say what the retry will actually do: resuming the missing pieces is not
      // "sending the whole report again", and the log is where that is visible.
      const p = state.digest?.partial
      const how = p ? `10分钟后只补未送达的 ${p.total - p.delivered.length} 段（已送达 ${p.delivered.length}/${p.total}）` : '10分钟后整篇重试'
      logger?.warn?.(`日报推送失败 ${outcome.retries}/${MAX_RETRY}，${how}：${outcome.error}`)
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