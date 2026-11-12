// Webhook push adapters. Pure formatting + a channel-dispatching sender, so the
// message builders can be unit-tested without network access.

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

export function createNotifier(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000

  async function send(cfg, title, text) {
    if (!cfg || cfg.channel === 'none' || !ADAPTERS[cfg.channel]) {
      return { ok: false, skipped: true, error: 'no webhook configured' }
    }
    if (!cfg.url && cfg.channel !== 'telegram') {
      return { ok: false, skipped: true, error: 'webhook url empty' }
    }
    const { url, body } = ADAPTERS[cfg.channel](cfg, title, text)
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
      return { ok: res.ok, status: res.status, error: res.ok ? null : respText.slice(0, 200) }
    } catch (err) {
      return { ok: false, status: 0, error: String(err?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }

  return { send, formatResetMessage }
}