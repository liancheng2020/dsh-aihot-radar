// AIHOT public API client. Pure module (no cordis dependency) so it can be
// unit-tested against the live API with plain node.
// Docs: https://aihot.news/api/v1/agent  ·  https://aihot.news/openapi-v1.json

import { createRequire } from 'node:module'

const DEFAULT_BASE = 'https://aihot.news'
const PROVIDERS = ['codex', 'claude', 'antigravity']
const { version: PKG_VERSION } = createRequire(import.meta.url)('../package.json')

export class RateLimitError extends Error {
  constructor(retryAfterSeconds, status) {
    super(`AIHOT rate limited (HTTP ${status}); retry after ${retryAfterSeconds}s`)
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
    this.status = status
  }
}

function parseRetryAfter(header) {
  if (!header) return 60
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(1, seconds)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000))
  return 60
}

export function createApi(options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 20000
  // Interactive agent tools identify as the plugin; programmatic sync (radar
  // polling, digest) uses the AIHOT API UA per the official compliance guidance.
  const userAgent = options.mode === 'tools'
    ? `dsh-aihot-radar/${PKG_VERSION} (agent-tools)`
    : 'aihot-api/2.0.0'
  // Per-URL conditional-request cache: { etag, body }
  const cache = new Map()

  async function request(path, accept) {
    const url = baseUrl + path
    const headers = {
      'Accept': accept,
      'Accept-Encoding': 'gzip, br',
      'User-Agent': userAgent,
    }
    const cached = cache.get(url)
    if (cached?.etag) headers['If-None-Match'] = cached.etag

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' })
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 304 && cached) return cached.body
    if (res.status === 429 || res.status === 503) {
      throw new RateLimitError(parseRetryAfter(res.headers.get('Retry-After')), res.status)
    }
    if (!res.ok) {
      throw new Error(`AIHOT request failed: HTTP ${res.status} for ${path}`)
    }
    const body = await res.text()
    const etag = res.headers.get('ETag')
    if (etag) cache.set(url, { etag, body })
    return body
  }

  const getText = (path) => request(path, 'text/markdown, text/plain;q=0.9, */*;q=0.5')
  async function getJson(path) {
    const body = await request(path, 'application/json')
    return JSON.parse(body)
  }

  function query(params) {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? `?${s}` : ''
  }

  return {
    PROVIDERS,
    latest: (opts = {}) => getText('/api/v1/agent/latest' + query({
      window: opts.window, category: opts.category, mode: opts.mode, limit: opts.limit,
    })),
    search: (q, opts = {}) => getText('/api/v1/agent/search' + query({ q, window: opts.window })),
    hot: () => getText('/api/v1/agent/hot'),
    daily: (date) => getText(date ? `/api/v1/agent/daily/${date}` : '/api/v1/agent/daily'),
    dailyJson: (date) => getJson(date ? `/api/v1/dailies/${date}` : '/api/v1/dailies/latest'),
    weekly: (week) => getText(week ? `/api/v1/agent/weekly/${week}` : '/api/v1/agent/weekly'),
    monthly: (month) => getText(month ? `/api/v1/agent/monthly/${month}` : '/api/v1/agent/monthly'),
    story: (publicId) => getText(`/api/v1/agent/stories/${encodeURIComponent(publicId)}`),
    resets: (provider) => getText(`/api/v1/agent/${provider}-resets`),
    resetsRecent: (provider) => getJson(`/api/v1/${provider}-resets/recent`),
    hotTopics: () => getJson('/api/v1/hot-topics'),
  }
}

export { PROVIDERS }