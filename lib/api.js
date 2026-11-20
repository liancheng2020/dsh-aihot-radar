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
  // Per-URL conditional-request cache: { etag, body, maxAgeMs }. maxAgeMs is the
  // response's own freshness hint, kept so the poller can avoid re-requesting a
  // document it just received — a 304 still costs a round trip.
  const cache = new Map()
  // AIHOT's contract is Cache-Control: public, max-age=60, s-maxage=60 — s-maxage is
  // the shared/CDN window and wins; max-age is the fallback for a response that only
  // sends the plain one. Three answers, because they mean different things:
  //   null → no cache header at all ("no information": keep whatever we had)
  //   0    → explicitly not cacheable (no-cache / no-store: drop the old window)
  //   N    → fresh for N ms
  const parseCacheWindow = (value) => {
    if (value == null) return null
    const s = String(value)
    const m = /(?:^|[,\s])s-maxage=(\d+)/i.exec(s) || /(?:^|[,\s])max-age=(\d+)/i.exec(s)
    if (m) {
      // Clamped to an hour: a misconfigured header must not park the radar for a day
      // and turn a stale cache window into a missed alert.
      return Math.min(Number(m[1]) * 1000, 3600 * 1000)
    }
    if (/(?:^|[,\s])no-(?:cache|store)(?:$|[,\s])/i.test(s)) return 0
    return null
  }

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
    // The timer must outlive the headers: aborting only the fetch() await would
    // leave res.text() reading a stalled body with no deadline at all.
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' })

      if (res.status === 304 && cached) {
        // A 304 can move the window in either direction: an explicit max-age=0 means
        // the cached copy is no longer fresh, so it is written through. Only a 304
        // that carries no cache header at all leaves the previous value alone.
        const window = parseCacheWindow(res.headers.get('Cache-Control'))
        if (window != null) cached.maxAgeMs = window
        return cached.body
      }
      if (res.status === 429 || res.status === 503) {
        throw new RateLimitError(parseRetryAfter(res.headers.get('Retry-After')), res.status)
      }
      if (!res.ok) {
        const err = new Error(`AIHOT request failed: HTTP ${res.status} for ${path}`)
        err.status = res.status
        throw err
      }
      const body = await res.text() // still covered by the same abort signal
      const etag = res.headers.get('ETag')
      const window = parseCacheWindow(res.headers.get('Cache-Control'))
      // Recorded even without an ETag: the freshness window is useful on its own
      // (the poller asks for it on every cycle), and only the conditional request
      // needs an ETag to exist.
      if (etag || window != null) {
        cache.set(url, { etag: etag || null, body, maxAgeMs: window ?? 0 })
      } else {
        // Neither revalidatable nor timed any more: drop the entry. Keeping it would
        // make the next cycle send an If-None-Match the server no longer honours and
        // report a freshness window this response just disowned.
        cache.delete(url)
      }
      return body
    } catch (err) {
      if (controller.signal.aborted) {
        const e = new Error(`AIHOT request timeout after ${timeoutMs}ms for ${path}`)
        e.code = 'ETIMEDOUT'
        e.timeout = true
        throw e
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
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
    // How long the last response for `path` stays fresh, in ms (0 = no hint). The
    // radar uses it as a floor for its own interval, so a faster pollSeconds never
    // re-requests a document the upstream just told us is still cacheable.
    cacheMaxAgeMs: (path) => cache.get(baseUrl + path)?.maxAgeMs || 0,
    latest: (opts = {}) => getText('/api/v1/agent/latest' + query({
      window: opts.window, category: opts.category, mode: opts.mode,
      limit: opts.limit === undefined ? undefined : Math.min(30, Math.max(1, Math.round(opts.limit))),
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
  }
}

export { PROVIDERS }