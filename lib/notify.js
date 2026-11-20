// Webhook push adapters. Pure formatting + a channel-dispatching sender, so the
// message builders can be unit-tested without network access.
// send() auto-chunks oversized payloads (wecom/telegram) and validates the
// response body, because these webhooks return HTTP 200 even on business failure.

import { createHmac } from 'node:crypto'

const PROVIDER_LABEL = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }
const STATUS_ZH = { announced: '预告', confirmed: '已到账' }

// There is no built-in footer: pushes land in shared IM groups, and this plugin
// does not put its own install link there. The only line that can be appended is
// the one the user writes themselves in notify.signatureText — an explicit
// signatureText is the deliberate choice that enables it, and notify.signature:
// false wins over it. Nothing else turns it on (see signatureEnabled).
// The brand lives in the card title instead (see format*Message), so a card with
// no footer still says where it came from.

// Single source of truth for "can we actually push?" — the bridge and the
// digest scheduler must agree, or the panel says "on" while nothing is sent.
export const isWebhookConfigured = (wh) =>
  !!wh?.channel && wh.channel !== 'none' && (!!wh.url || wh.channel === 'telegram')

// Two inputs, one answer: the user's own text enables the footer, an explicit
// `false` disables it. `signature: true` alone is NOT a request for a line —
// there is no longer anything built in to append, so it appends nothing. That
// also neutralises a stale panel record (state.notify.signature = true) written
// by an older version whose switch meant "add the install link".
// Shared with the bridge so /status and the sender cannot disagree.
export function signatureEnabled(notify) {
  if (notify?.signature === false) return false
  return typeof notify?.signatureText === 'string' && notify.signatureText.trim() !== ''
}

// Stored footer preference from the removed panel switch (`null` = follow the
// profile config). Only the "off" half still means something: `false` suppresses
// the user's own line. A stored `true` was a request for the built-in install
// line, which no longer exists — letting it win would resurrect exactly what was
// removed, and it would also override an explicit `signature: false` in the
// profile, which is the user's current answer. So it is ignored.
export function effectiveNotify(configNotify, state) {
  const base = configNotify && typeof configNotify === 'object' ? configNotify : {}
  return state?.notify?.signature === false ? { ...base, signature: false } : base
}

export function signatureLine(notify) {
  if (!signatureEnabled(notify)) return ''
  return notify.signatureText.trim()
}

export function withSignature(text, notify) {
  const line = signatureLine(notify)
  return line ? `${text}\n\n${line}` : text
}

export function formatResetMessage(provider, event, notify) {
  const label = PROVIDER_LABEL[provider] || provider
  const status = STATUS_ZH[event.status] || event.status
  // The brand belongs in the title, not in the footer: the footer is opt-in, so
  // a card without it must still be recognisable in a busy group.
  const title = `AIHOT 雷达 · ${label} ${event.displayLabel || event.label || '额度重置'}（${status}）`
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
  return { title, text: withSignature(lines.join('\n'), notify) }
}

// Light notice for AIHOT-inferred states (window passed / likely completed),
// explicitly marked as unconfirmed. Pushed only when notifyConfirmed is on.
export function formatInferredMessage(provider, event, notify) {
  const label = PROVIDER_LABEL[provider] || provider
  const ps = event.presentation?.status
  const hint = ps === 'expired_unconfirmed' ? '窗口已过，未经确认' : '可能已到账，未经确认'
  const title = `AIHOT 雷达 · ${label} ${event.displayLabel || event.label || '额度重置'}（AIHOT 推断）`
  const lines = [`### ${title}`, '', `AIHOT 推断：${hint}。`, event.title || '']
  const when = event.estimate?.label || event.schedule?.label
  if (when) lines.push(`- 时间：${when}`)
  lines.push('', `数据来源：[AIHOT](https://aihot.news/${provider}-reset)`)
  return { title, text: withSignature(lines.join('\n'), notify) }
}

function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const sign = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return encodeURIComponent(sign)
}

// Some channels render no markdown at all (Feishu text, Telegram without
// parse_mode, Bark). Sending raw markdown there shows "### 标题" and
// "[AIHOT](url)" as source in the group chat, so flatten it first. Every link
// keeps its target, including one the user put in their own footer: the text is
// theirs, so nothing in it is treated as a signature to be trimmed.
export function toPlainText(md) {
  return String(md ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 $2')
}

// Feishu card colour carries the meaning: scanning a busy group chat, orange
// (announcement) vs green (confirmed) is how people decide whether to open it.
function feishuTemplate(title) {
  const s = String(title || '')
  if (s.includes('推断')) return 'grey'
  if (s.includes('已到账')) return 'green'
  if (s.includes('预告')) return 'orange'
  return 'blue'
}

// B1: keep send() dumb (title + markdown text) and translate it into a card.
// lark_md renders headings as plain "#", so they become bold instead; links
// stay as [label](url) and become real inline links (what text messages lose).
// The whole text goes in one body block: with no built-in footer there is no
// predefined last line to lift into a note element, and guessing one out of the
// user's own text would move or restyle content they wrote.
export function toFeishuCard(title, text) {
  const body = String(text || '')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const elements = []
  if (body) elements.push({ tag: 'div', text: { tag: 'lark_md', content: body } })
  return {
    config: { wide_screen_mode: true },
    header: {
      template: feishuTemplate(title),
      title: { tag: 'plain_text', content: String(title || '').replace(/^#{1,6}\s+/, '') },
    },
    elements,
  }
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
    return { url: cfg.url, body: { msg_type: 'interactive', card: toFeishuCard(title, text) } }
  },
  // Not a channel: the plain-text shape of a Feishu message, used when a tenant
  // rejects the card schema (see send()).
  feishuText(cfg, title, text) {
    return { url: cfg.url, body: { msg_type: 'text', content: { text: `${toPlainText(title)}\n${toPlainText(text)}` } } }
  },
  bark(cfg, title, text) {
    return { url: cfg.url, body: { title: toPlainText(title), body: toPlainText(text), group: 'aihot-radar' } }
  },
  serverchan(cfg, title, text) {
    // ServerChan renders markdown in the WeChat push, so keep the syntax.
    return { url: cfg.url, body: { title, desp: text } }
  },
  telegram(cfg, title, text) {
    // cfg.url = bot token, cfg.secret = chat_id. No parse_mode -> plain text.
    const url = `https://api.telegram.org/bot${cfg.url}/sendMessage`
    return { url, body: { chat_id: cfg.secret, text: `${toPlainText(title)}\n${toPlainText(text)}`, disable_web_page_preview: true } }
  },
  generic(cfg, title, text) {
    return { url: cfg.url, body: { title, text, source: 'aihot-radar' } }
  },
}

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
// business failure; the real status is in errcode/code/StatusCode/ok. HTTP 200
// alone proves nothing: an HTML portal page, an empty body, or a receipt without
// the platform's success field all mean "not accepted", not "pushed".
// `code` keeps the platform business code, so callers can map it to a next
// step (the human `error` text alone is not matchable across channels).
function checkBody(channel, respText, contentType = '') {
  const text = String(respText ?? '').trim()
  const snippet = text.slice(0, 200)
  const fail = (code, msg) => ({ ok: false, code: code ?? null, error: msg || snippet })
  const ok = { ok: true, code: null, error: null }
  if (!text) {
    // A self-hosted endpoint answering 204 / empty 200 is the documented shape of
    // "accepted" there, and it has no receipt to read. The known platforms always
    // return one, so an empty body from them means "we cannot tell", not "sent".
    return channel === 'generic' ? ok : fail(null, '响应正文为空，无法确认推送成功')
  }
  if (!/json/i.test(contentType) && /^</.test(text)) {
    return fail(null, `响应是 HTML 而非 JSON（疑似门户/代理拦截页）：${text.slice(0, 120)}`)
  }
  let j
  try { j = JSON.parse(text) } catch { return fail(null, `响应不是 JSON，无法确认推送成功：${text.slice(0, 120)}`) }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return fail(null, '响应不是 JSON 对象，无法确认推送成功')
  const missing = (what) => fail(null, `响应缺少 ${what} 字段，无法确认推送成功`)
  switch (channel) {
    case 'wecom':
    case 'dingtalk':
      return typeof j.errcode === 'number' ? (j.errcode === 0 ? ok : fail(j.errcode, j.errmsg)) : missing('errcode')
    case 'feishu':
      if (typeof j.code === 'number' && j.code !== 0) return fail(j.code, j.msg)
      if (typeof j.StatusCode === 'number' && j.StatusCode !== 0) return fail(j.StatusCode, j.StatusMessage)
      return (typeof j.code === 'number' || typeof j.StatusCode === 'number') ? ok : missing('code')
    case 'serverchan':
      return typeof j.code === 'number' ? (j.code === 0 ? ok : fail(j.code, j.message || j.info)) : missing('code')
    case 'telegram':
      return typeof j.ok === 'boolean' ? (j.ok ? ok : fail(j.error_code, j.description)) : missing('ok')
    case 'bark':
      return typeof j.code === 'number' ? (j.code === 200 ? ok : fail(j.code, j.message)) : missing('code')
    default:
      // No documented receipt for a self-hosted endpoint: accept a JSON object
      // that does not declare a failure, but never a bare 200 with no body.
      if (j.ok === false) return fail(j.error_code ?? null, j.error || j.message)
      if (typeof j.errcode === 'number' && j.errcode !== 0) return fail(j.errcode, j.errmsg || j.message)
      if (typeof j.code === 'number' && j.code !== 0) return fail(j.code, j.message || j.msg)
      if (typeof j.success === 'boolean' && !j.success) return fail(null, j.message)
      return ok
  }
}

// Feishu answers HTTP 200 with code != 0 when an older tenant cannot render the
// card schema. Only those rejections are worth a plain-text re-send: a timeout,
// a rate limit or a permission error did not accept the message, so retrying as
// text would either duplicate it or fail the same way.
const FEISHU_CARD_FORMAT_CODES = new Set([19001, 19002, 19003, 9499, 230001, 230002])
function isFeishuCardFormatError(r) {
  if (!r || r.ok) return false
  if (r.timeout) return false           // may have been delivered: never re-send
  if (r.status === 429) return false    // rate limited: a second POST doubles the count
  if (r.status >= 500) return false
  if (r.code != null && FEISHU_CARD_FORMAT_CODES.has(Number(r.code))) return true
  return /card|schema|msg[ _]?type|interactive|卡片|消息格式/i.test(String(r.error || ''))
}

export function createNotifier(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000

  // `timeout`/`retryable` tell callers what happened to the message, not just
  // that something went wrong: a timeout may have landed (do not re-send), a
  // 4xx/5xx from the platform did not (safe to retry).
  async function postOnce(channel, url, body) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      let respText
      try {
        respText = await res.text()
      } catch (err) {
        // A body that stalls or dies after the headers arrived is NOT "nothing
        // happened": the request already reached the channel, so the card may
        // well be posted. Never classify this as retryable.
        const aborted = timedOut || controller.signal.aborted
        return {
          ok: false, status: res?.status || 0, code: 0, timeout: true, retryable: false,
          error: aborted
            ? `响应正文超时（${timeoutMs}ms），送达不确定`
            : `响应正文读取中断，送达不确定：${String(err?.message || err)}`,
        }
      }
      if (!res.ok) {
        return {
          ok: false, status: res.status, code: res.status, timeout: false,
          retryable: res.status !== 429,
          error: (respText || '').slice(0, 200) || `HTTP ${res.status}`,
        }
      }
      const v = checkBody(channel, respText, res.headers?.get?.('content-type') || '')
      return { ok: v.ok, status: res.status, code: v.code, timeout: false, retryable: !v.ok, error: v.ok ? null : v.error }
    } catch (err) {
      const name = err?.name || ''
      const aborted = timedOut || controller.signal.aborted || name === 'AbortError' || name === 'TimeoutError'
      const code = err?.code || err?.cause?.code || ''
      // A socket that died after the request went out may have been delivered.
      const resetMidFlight = /^(ECONNRESET|EPIPE|ECONNABORTED|ETIMEDOUT|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)$/.test(String(code))
      const unknown = aborted || resetMidFlight
      return {
        ok: false, status: 0, code: 0, timeout: unknown, retryable: !unknown,
        error: aborted ? `请求超时（${timeoutMs}ms），送达不确定` : String(err?.message || err),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // `opts.skip` lists piece indexes an earlier attempt already confirmed, so a
  // long digest resumes instead of re-posting the parts that did land. The result
  // carries that progress: `delivered` (known landed, skipped included) and
  // `failed` (indexes that did not), both aligned with the deterministic chunking
  // of the same text — the caller stores them and passes the difference back.
  async function send(cfg, title, text, opts = {}) {
    const empty = { chunks: 0, total: 0, delivered: [], failed: [] }
    if (!cfg || cfg.channel === 'none' || !ADAPTERS[cfg.channel]) {
      return { ...empty, ok: false, skipped: true, error: 'no webhook configured', timeout: false, retryable: false }
    }
    if (!cfg.url && cfg.channel !== 'telegram') {
      return { ...empty, ok: false, skipped: true, error: 'webhook url empty', timeout: false, retryable: false }
    }
    const limit = cfg.channel === 'wecom' ? { n: 3900, u: 'bytes' }
      : cfg.channel === 'telegram' ? { n: 3800, u: 'chars' }
        : cfg.channel === 'feishu' ? { n: 6000, u: 'chars' } // card JSON has its own size cap
          : null
    const body = String(text ?? '')
    const pieces = limit ? chunkContent(body, limit.n, limit.u) : [body]
    const n = pieces.length
    const skip = new Set((Array.isArray(opts.skip) ? opts.skip : []).filter((i) => Number.isInteger(i) && i >= 0 && i < n))
    let lastStatus = 0, firstError = null, firstCode = null
    let uncertain = false, retryable = false
    const delivered = []
    const failed = []
    for (let i = 0; i < n; i++) {
      // Confirmed earlier: posting it again would duplicate that part of the card.
      if (skip.has(i)) { delivered.push(i); continue }
      const chunkTitle = i === 0 ? title : `（续 ${i + 1}/${n}）${title}`
      const payload = ADAPTERS[cfg.channel](cfg, chunkTitle, pieces[i])
      let r = await postOnce(cfg.channel, payload.url, payload.body)
      // A card the tenant explicitly rejected as malformed must not silently drop
      // the message: retry this chunk once as plain text (never more, or a group
      // gets spammed). Timeouts / 429 / 5xx are NOT format rejections and are left
      // alone — see isFeishuCardFormatError.
      if (isFeishuCardFormatError(r) && cfg.channel === 'feishu') {
        const plain = ADAPTERS.feishuText(cfg, chunkTitle, pieces[i])
        r = await postOnce(cfg.channel, plain.url, plain.body)
      }
      lastStatus = r.status
      if (r.ok) { delivered.push(i); continue }
      failed.push(i)
      if (r.timeout) uncertain = true
      if (r.retryable !== false && !r.timeout) retryable = true
      if (!firstError) { firstError = r.error; firstCode = r.code }
    }
    const allOk = failed.length === 0
    return {
      ok: allOk, status: lastStatus, error: allOk ? null : firstError, code: allOk ? null : firstCode,
      chunks: n, total: n, delivered, failed,
      timeout: uncertain, retryable: !allOk && retryable && !uncertain,
    }
  }

  return { send }
}