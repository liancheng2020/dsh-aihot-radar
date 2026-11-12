// Webhook push adapters. Pure formatting + a channel-dispatching sender, so the
// message builders can be unit-tested without network access.
// send() auto-chunks oversized payloads (wecom/telegram) and validates the
// response body, because these webhooks return HTTP 200 even on business failure.

import { createHmac } from 'node:crypto'

const PROVIDER_LABEL = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }
const STATUS_ZH = { announced: '预告', confirmed: '已到账' }

export function formatResetMessage(provider, event) {
  const label = PROVIDER_LABEL[provider] || provider
  const status = STATUS_ZH[event.status] || event.status
  const title = `${label} ${event.displayLabel || event.label || '额度重置'}（${status}）`
  const lines = [`### ${title}`, '', event.title || '']
  const when = event.estimate?.label || event.schedule?.label
  if (when) lines.push(`- 时间：${when}`)
  const scope = event.presentation?.productsZh || event.scope
  if (scope) lines.push(`- 适用：${scope}`)
  if (event.estimate?.reason) lines.push(`- 说明：${event.estimate.reason}`)
  const post = event.posts?.[0]
  if (post) {
    const url = post.url || (post.id ? `https://x.com/i/status/${post.id}` : '')
    lines.push(`- 原帖：${post.author ? '@' + post.author + ' ' : ''}${post.text || ''}${url ? ' ' + url : ''}`)
  }
  lines.push('', `数据来源：[AIHOT](https://aihot.news/${provider}-reset)`)
  return { title, text: lines.join('\n') }
}

// Light notice for AIHOT-inferred states (window passed / likely completed),
// explicitly marked as unconfirmed. Pushed only when notifyConfirmed is on.
export function formatInferredMessage(provider, event) {
  const label = PROVIDER_LABEL[provider] || provider
  const ps = event.presentation?.status
  const hint = ps === 'expired_unconfirmed' ? '窗口已过，未经确认' : '可能已到账，未经确认'
  const title = `${label} ${event.displayLabel || event.label || '额度重置'}（AIHOT 推断）`
  const lines = [`### ${title}`, '', `AIHOT 推断：${hint}。`, event.title || '']
  const when = event.estimate?.label || event.schedule?.label
  if (when) lines.push(`- 时间：${when}`)
  lines.push('', `数据来源：[AIHOT](https://aihot.news/${provider}-reset)`)
  return { title, text: lines.join('\n') }
}

function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const sign = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return encodeURIComponent(sign)
}

// Each adapter returns { url, body } for a JSON POST.
const ADAPTERS = {
  wecom(cfg, title, text) {
    return { url: cfg.url, body: { msgtype: 'markdown', markdown: { content: `**${title}**\n${text}` } } }
  },
  dingtalk(cfg, title, text) {
    let url = cfg.url
    if (cfg.secret) {
      const ts = Date.now()
      url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${dingtalkSign(cfg.secret, ts)}`
    }
    return { url, body: { msgtype: 'markdown', markdown: { title, text } } }
  },
  feishu(cfg, title, text) {
    return { url: cfg.url, body: { msg_type: 'text', content: { text: `${title}\n${text}` } } }
  },
  bark(cfg, title, text) {
    return { url: cfg.url, body: { title, body: text, group: 'aihot-radar' } }
  },
  serverchan(cfg, title, text) {
    return { url: cfg.url, body: { title, desp: text } }
  },
  telegram(cfg, title, text) {
    // cfg.url = bot token, cfg.secret = chat_id
    const url = `https://api.telegram.org/bot${cfg.url}/sendMessage`
    return { url, body: { chat_id: cfg.secret, text: `${title}\n${text}`, disable_web_page_preview: true } }
  },
  generic(cfg, title, text) {
    return { url: cfg.url, body: { title, text, source: 'aihot-radar' } }
  },
}

export const CHANNELS = Object.keys(ADAPTERS)

// Split text into chunks <= limit, preferring line boundaries and never cutting
// a UTF-8 character. unit is 'bytes' (Buffer) or 'chars' (String.length).
export function chunkContent(text, limit, unit) {
  const measure = unit === 'bytes' ? (s) => Buffer.byteLength(s, 'utf8') : (s) => s.length
  const lines = String(text).split('\n')
  const chunks = []
  let cur = ''
  const pushCur = () => { if (cur) { chunks.push(cur); cur = '' } }
  for (const line of lines) {
    const candidate = cur ? cur + '\n' + line : line
    if (measure(candidate) <= limit) { cur = candidate; continue }
    pushCur()
    if (measure(line) <= limit) { cur = line; continue }
    // A single line longer than the limit: hard-split by code point.
    let piece = ''
    for (const ch of line) {
      if (measure(piece + ch) > limit) { chunks.push(piece); piece = ch }
      else piece += ch
    }
    cur = piece
  }
  pushCur()
  return chunks.length ? chunks : ['']
}

// Validate a webhook response body. These channels return HTTP 200 even on
// business failure; the real status is in errcode/code/StatusCode/ok.
function checkBody(channel, respText, resOk) {
  const fallback = { ok: resOk, error: resOk ? null : (respText || '').slice(0, 200) }
  let j
  try { j = JSON.parse(respText) } catch { return fallback }
  if (!j || typeof j !== 'object') return fallback
  const fail = (msg) => ({ ok: false, error: msg || (respText || '').slice(0, 200) })
  const ok = { ok: true, error: null }
  switch (channel) {
    case 'wecom':
    case 'dingtalk':
      return typeof j.errcode === 'number' ? (j.errcode === 0 ? ok : fail(j.errmsg || `errcode ${j.errcode}`)) : fallback
    case 'feishu':
      if (typeof j.code === 'number' && j.code !== 0) return fail(j.msg || `code ${j.code}`)
      if (typeof j.StatusCode === 'number' && j.StatusCode !== 0) return fail(j.StatusMessage || `StatusCode ${j.StatusCode}`)
      return (typeof j.code === 'number' || typeof j.StatusCode === 'number') ? ok : fallback
    case 'serverchan':
      return typeof j.code === 'number' ? (j.code === 0 ? ok : fail(j.message || j.info || `code ${j.code}`)) : fallback
    case 'telegram':
      return typeof j.ok === 'boolean' ? (j.ok ? ok : fail(j.description || 'telegram ok=false')) : fallback
    case 'bark':
      return typeof j.code === 'number' ? (j.code === 200 ? ok : fail(j.message || `code ${j.code}`)) : fallback
    default:
      return fallback
  }
}

export function createNotifier(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000

  async function postOnce(channel, url, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const respText = await res.text().catch(() => '')
      if (!res.ok) return { ok: false, status: res.status, error: (respText || '').slice(0, 200) || `HTTP ${res.status}` }
      const v = checkBody(channel, respText, true)
      return { ok: v.ok, status: res.status, error: v.ok ? null : v.error }
    } catch (err) {
      return { ok: false, status: 0, error: String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  async function send(cfg, title, text) {
    if (!cfg || cfg.channel === 'none' || !ADAPTERS[cfg.channel]) {
      return { ok: false, skipped: true, error: 'no webhook configured', chunks: 0 }
    }
    if (!cfg.url && cfg.channel !== 'telegram') {
      return { ok: false, skipped: true, error: 'webhook url empty', chunks: 0 }
    }
    const limit = cfg.channel === 'wecom' ? { n: 3900, u: 'bytes' }
      : cfg.channel === 'telegram' ? { n: 3800, u: 'chars' }
        : null
    const body = String(text ?? '')
    const pieces = limit ? chunkContent(body, limit.n, limit.u) : [body]
    const n = pieces.length
    let allOk = true, lastStatus = 0, firstError = null
    for (let i = 0; i < n; i++) {
      const chunkTitle = i === 0 ? title : `（续 ${i + 1}/${n}）${title}`
      const { url, body: payload } = ADAPTERS[cfg.channel](cfg, chunkTitle, pieces[i])
      const r = await postOnce(cfg.channel, url, payload)
      lastStatus = r.status
      if (!r.ok) { allOk = false; if (!firstError) firstError = r.error }
    }
    return { ok: allOk, status: lastStatus, error: allOk ? null : firstError, chunks: n }
  }

  return { send }
}