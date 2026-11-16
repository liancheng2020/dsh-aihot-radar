// Webhook push adapters. Pure formatting + a channel-dispatching sender, so the
// message builders can be unit-tested without network access.
// send() auto-chunks oversized payloads (wecom/telegram) and validates the
// response body, because these webhooks return HTTP 200 even on business failure.

import { createHmac } from 'node:crypto'

const PROVIDER_LABEL = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }
const STATUS_ZH = { announced: '预告', confirmed: '已到账' }

// One-line attribution appended to every push card. Pushes land in shared IM
// groups, so each card doubles as a lightweight install entry; on by default,
// removable via notify.signature: false.
export const DEFAULT_SIGNATURE = 'via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar'

// Single source of truth for "can we actually push?" — the bridge and the
// digest scheduler must agree, or the panel says "on" while nothing is sent.
export const isWebhookConfigured = (wh) =>
  !!wh?.channel && wh.channel !== 'none' && (!!wh.url || wh.channel === 'telegram')

export function signatureLine(notify) {
  if (notify?.signature === false) return ''
  const custom = typeof notify?.signatureText === 'string' ? notify.signatureText.trim() : ''
  return custom || DEFAULT_SIGNATURE
}

export function withSignature(text, notify) {
  const line = signatureLine(notify)
  return line ? `${text}\n\n${line}` : text
}

export function formatResetMessage(provider, event, notify) {
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
  return { title, text: withSignature(lines.join('\n'), notify) }
}

// Light notice for AIHOT-inferred states (window passed / likely completed),
// explicitly marked as unconfirmed. Pushed only when notifyConfirmed is on.
export function formatInferredMessage(provider, event, notify) {
  const label = PROVIDER_LABEL[provider] || provider
  const ps = event.presentation?.status
  const hint = ps === 'expired_unconfirmed' ? '窗口已过，未经确认' : '可能已到账，未经确认'
  const title = `${label} ${event.displayLabel || event.label || '额度重置'}（AIHOT 推断）`
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
// "[AIHOT](url)" as source in the group chat, so flatten it first.
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
export function toFeishuCard(title, text) {
  const lines = String(text || '').split('\n')
  let sigAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^via\s/i.test(lines[i].trim())) { sigAt = i; break }
  }
  const body = (sigAt >= 0 ? lines.filter((_, i) => i !== sigAt) : lines).join('\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const elements = []
  if (body) elements.push({ tag: 'div', text: { tag: 'lark_md', content: body } })
  if (sigAt >= 0) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: lines[sigAt].trim() }] })
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
// business failure; the real status is in errcode/code/StatusCode/ok.
// `code` keeps the platform business code, so callers can map it to a next
// step (the human `error` text alone is not matchable across channels).
function checkBody(channel, respText, resOk) {
  const fallback = { ok: resOk, code: null, error: resOk ? null : (respText || '').slice(0, 200) }
  let j
  try { j = JSON.parse(respText) } catch { return fallback }
  if (!j || typeof j !== 'object') return fallback
  const fail = (code, msg) => ({ ok: false, code: code ?? null, error: msg || (respText || '').slice(0, 200) })
  const ok = { ok: true, code: null, error: null }
  switch (channel) {
    case 'wecom':
    case 'dingtalk':
      return typeof j.errcode === 'number' ? (j.errcode === 0 ? ok : fail(j.errcode, j.errmsg)) : fallback
    case 'feishu':
      if (typeof j.code === 'number' && j.code !== 0) return fail(j.code, j.msg)
      if (typeof j.StatusCode === 'number' && j.StatusCode !== 0) return fail(j.StatusCode, j.StatusMessage)
      return (typeof j.code === 'number' || typeof j.StatusCode === 'number') ? ok : fallback
    case 'serverchan':
      return typeof j.code === 'number' ? (j.code === 0 ? ok : fail(j.code, j.message || j.info)) : fallback
    case 'telegram':
      return typeof j.ok === 'boolean' ? (j.ok ? ok : fail(j.error_code, j.description)) : fallback
    case 'bark':
      return typeof j.code === 'number' ? (j.code === 200 ? ok : fail(j.code, j.message)) : fallback
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
      if (!res.ok) return { ok: false, status: res.status, code: res.status, error: (respText || '').slice(0, 200) || `HTTP ${res.status}` }
      const v = checkBody(channel, respText, true)
      return { ok: v.ok, status: res.status, code: v.code, error: v.ok ? null : v.error }
    } catch (err) {
      return { ok: false, status: 0, code: 0, error: String(err?.message || err) }
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
        : cfg.channel === 'feishu' ? { n: 6000, u: 'chars' } // card JSON has its own size cap
          : null
    const body = String(text ?? '')
    const pieces = limit ? chunkContent(body, limit.n, limit.u) : [body]
    const n = pieces.length
    let allOk = true, lastStatus = 0, firstError = null, firstCode = null
    for (let i = 0; i < n; i++) {
      const chunkTitle = i === 0 ? title : `（续 ${i + 1}/${n}）${title}`
      const payload = ADAPTERS[cfg.channel](cfg, chunkTitle, pieces[i])
      let r = await postOnce(cfg.channel, payload.url, payload.body)
      // A card rejected by an older tenant must not silently drop the message:
      // retry this chunk once as plain text (never more, or a group gets spammed).
      if (!r.ok && cfg.channel === 'feishu') {
        const plain = ADAPTERS.feishuText(cfg, chunkTitle, pieces[i])
        r = await postOnce(cfg.channel, plain.url, plain.body)
      }
      lastStatus = r.status
      if (!r.ok) { allOk = false; if (!firstError) { firstError = r.error; firstCode = r.code } }
    }
    return { ok: allOk, status: lastStatus, error: allOk ? null : firstError, code: allOk ? null : firstCode, chunks: n }
  }

  return { send }
}