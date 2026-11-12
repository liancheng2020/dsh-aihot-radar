// Client half: a sidebar panel that reads the public AIHOT API directly
// (CORS: *). Two tabs: the quota-reset radar and a daily-report reader.
// Styled with the host's --dsw-alias-* theme tokens so it matches DSH natively.
window.__ModuleLoader__.load({
  id: 'dsh-aihot-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const BASE = 'https://aihot.news'
    const PROVIDERS = [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude' },
      { id: 'antigravity', label: 'Antigravity' },
    ]
    const TOOLS = [
      ['aihot_latest', '最近 AI 重点资讯'],
      ['aihot_search', '关键词搜索资讯'],
      ['aihot_hot', '当前 AI 热榜'],
      ['aihot_daily', 'AIHOT 日报'],
      ['aihot_report', '周报 / 月报'],
      ['aihot_story', '热点事件时间线'],
      ['aihot_resets', '额度重置记录'],
    ]

    const T = {
      text: 'var(--dsw-alias-label-primary, #e8e8ea)',
      sub: 'var(--dsw-alias-label-secondary, #a0a0a8)',
      tertiary: 'var(--dsw-alias-label-tertiary, #6e6e78)',
      dimmed: 'var(--dsw-alias-label-dimmed, #50505a)',
      base: 'var(--dsw-alias-bg-base, #0e0e11)',
      layer1: 'var(--dsw-alias-bg-layer-1, #1a1a1f)',
      layer2: 'var(--dsw-alias-bg-layer-2, #232329)',
      border: 'var(--dsw-alias-border-l2, #2e2e36)',
      borderSoft: 'var(--dsw-alias-border-l1, #26262c)',
      brand: 'var(--dsw-alias-brand-primary, #5b8cff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #2a2a32)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
      success: 'var(--dsw-alias-state-success-primary, #34c759)',
      error: 'var(--dsw-alias-state-error-primary, #ff4d4f)',
    }

    const css = {
      panel: { padding: '20px 22px', color: T.text, fontSize: 13, lineHeight: 1.6, overflowY: 'auto', height: '100%', background: T.base },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
      titleWrap: { display: 'flex', alignItems: 'center', gap: 10 },
      iconBadge: { width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, rgba(91,140,255,0.18), rgba(245,166,35,0.14))', border: `1px solid ${T.border}`, color: T.brand, flex: 'none' },
      h1: { fontSize: 17, fontWeight: 650, margin: 0, letterSpacing: '0.2px', display: 'flex', alignItems: 'center', gap: 8 },
      live: { width: 7, height: 7, borderRadius: '50%', background: T.success, animation: 'aihot-pulse 2.4s infinite' },
      sub: { color: T.tertiary, fontSize: 12, margin: '3px 0 0' },
      btn: { fontSize: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.layer1, color: T.sub, cursor: 'pointer', transition: 'all .15s ease', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' },
      tabs: { display: 'flex', gap: 6, marginBottom: 20, borderBottom: `1px solid ${T.borderSoft}`, paddingBottom: 12 },
      tab: { fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: T.tertiary, cursor: 'pointer', transition: 'all .15s ease', display: 'inline-flex', alignItems: 'center', gap: 7 },
      tabActive: { background: 'rgba(91,140,255,0.12)', border: `1px solid rgba(91,140,255,0.35)`, color: T.brand },
      strip: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 22 },
      chip: { background: T.layer1, border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: '10px 12px' },
      chipTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
      chipName: { fontSize: 12, fontWeight: 600, color: T.sub },
      dot: (c) => ({ width: 8, height: 8, borderRadius: '50%', background: c, flex: 'none' }),
      chipVal: { fontSize: 18, fontWeight: 650, color: T.text, lineHeight: 1.2 },
      chipMeta: { fontSize: 11, color: T.sub, marginTop: 2 },
      section: { marginBottom: 24 },
      h2: { fontSize: 12, fontWeight: 600, margin: '0 0 10px', color: T.tertiary, textTransform: 'uppercase', letterSpacing: '0.6px', display: 'flex', alignItems: 'center', gap: 8 },
      count: { fontSize: 11, fontWeight: 600, color: T.sub, background: T.layer2, border: `1px solid ${T.borderSoft}`, borderRadius: 20, padding: '0 8px', lineHeight: '18px' },
      hero: { background: `linear-gradient(135deg, rgba(245,166,35,0.10), ${T.layer1} 60%)`, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.warn}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 },
      card: { background: T.layer1, border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: '12px 14px', transition: 'all .15s ease' },
      row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 },
      cardTitle: { fontWeight: 600, fontSize: 13, color: T.text, display: 'flex', alignItems: 'center', gap: 7 },
      badge: (c) => ({ fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, background: c, color: '#0e0e11', whiteSpace: 'nowrap', flex: 'none' }),
      badgeSoft: (c) => ({ fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, color: c, border: `1px solid ${c}`, background: 'transparent', whiteSpace: 'nowrap', flex: 'none' }),
      meta: { fontSize: 12, color: T.sub, margin: '2px 0' },
      metaDim: { fontSize: 11.5, color: T.tertiary, margin: '2px 0' },
      countdown: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: T.warn, background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: 8, padding: '3px 10px', marginTop: 0 },
      link: { color: T.brand, textDecoration: 'none', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 6, transition: 'opacity .15s' },
      tools: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 },
      tool: { display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', background: T.layer1, border: `1px solid ${T.borderSoft}`, borderRadius: 8, transition: 'all .15s ease' },
      toolDot: { width: 5, height: 5, borderRadius: '50%', background: T.brand, flex: 'none' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: T.brand, fontWeight: 600 },
      toolDesc: { fontSize: 11.5, color: T.tertiary, marginLeft: 'auto' },
      empty: { color: T.dimmed, fontSize: 12.5, fontStyle: 'italic', padding: '14px 16px', background: T.layer1, border: `1px dashed ${T.border}`, borderRadius: 10 },
      error: { color: T.error, fontSize: 12.5, padding: '12px 14px', background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.3)', borderRadius: 10, marginBottom: 16 },
      foot: { marginTop: 8, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11.5, color: T.sub, display: 'flex', alignItems: 'center', gap: 6 },
      // daily report
      dtoolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
      dnav: { fontSize: 12, padding: '5px 12px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.layer1, color: T.sub, cursor: 'pointer', transition: 'all .15s ease' },
      ddate: { fontSize: 13, fontWeight: 650, color: T.text, padding: '0 6px' },
      md: { fontSize: 13, lineHeight: 1.75, color: T.sub },
      mdH1: { fontSize: 16, fontWeight: 650, color: T.text, margin: '0 0 12px' },
      mdCat: { fontSize: 12.5, fontWeight: 650, color: T.brand, margin: '20px 0 10px', display: 'flex', alignItems: 'center', gap: 8 },
      mdCatBar: { width: 3, height: 14, borderRadius: 2, background: T.brand, flex: 'none' },
      mdP: { margin: '8px 0', color: T.sub },
      mdNote: { margin: '8px 0', color: T.sub, fontSize: 11.5 },
      mdItem: { display: 'flex', gap: 11, padding: '11px 14px', background: T.layer1, border: `1px solid ${T.borderSoft}`, borderRadius: 10, marginBottom: 8 },
      mdNum: { width: 22, height: 22, borderRadius: 6, background: T.layer2, border: `1px solid ${T.border}`, color: T.sub, fontSize: 11.5, fontWeight: 650, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', marginTop: 1 },
      mdItemTitle: { fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.5 },
      mdItemBody: { fontSize: 12, color: T.tertiary, marginTop: 4, lineHeight: 1.65 },
      mdLink: { color: T.brand, textDecoration: 'none', transition: 'opacity .15s' },
      mdCode: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, background: T.layer2, border: `1px solid ${T.borderSoft}`, borderRadius: 4, padding: '0 5px', color: T.text },
      mdHr: { border: 'none', borderTop: `1px solid ${T.borderSoft}`, margin: '16px 0' },
    }

    function RadarIcon({ size = 20 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
        h('path', { d: 'M12 20 A8 8 0 0 1 4 12', opacity: 0.55 }),
        h('path', { d: 'M12 16 A4 4 0 0 1 8 12', opacity: 0.85 }),
        h('circle', { cx: 12, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('line', { x1: 12, y1: 12, x2: 18, y2: 6 }),
        h('circle', { cx: 18, cy: 6, r: 1.7, fill: 'currentColor', stroke: 'none' }))
    }

    // ---- Safe Markdown renderer (React elements only, no innerHTML) ----
    function inline(text, kp) {
      const nodes = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
      let last = 0, m, i = 0
      while ((m = re.exec(text))) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const tok = m[0]
        if (tok.startsWith('**')) nodes.push(h('strong', { key: kp + i, style: { color: T.text, fontWeight: 650 } }, tok.slice(2, -2)))
        else if (tok.startsWith('`')) nodes.push(h('code', { key: kp + i, style: css.mdCode }, tok.slice(1, -1)))
        else {
          const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
          if (mm && /^https?:\/\//.test(mm[2])) nodes.push(h('a', { key: kp + i, href: mm[2], target: '_blank', rel: 'noreferrer', style: css.mdLink, className: 'aihot-link' }, mm[1]))
          else nodes.push(tok)
        }
        last = m.index + tok.length; i++
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function Markdown({ source }) {
      const blocks = useMemo(() => {
        const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
        const out = []
        let para = []
        let k = 0
        const flush = () => {
          if (!para.length) return
          const text = para.join(' ')
          const isNote = /安全边界|不可信|回原文核对/.test(text)
          out.push(h('p', { key: 'p' + k++, style: isNote ? css.mdNote : css.mdP }, inline(text, 'pi' + k)))
          para = []
        }
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const trimmed = line.trim()
          if (!trimmed) { flush(); continue }
          if (/^［.*］$/.test(trimmed)) { flush(); if (/结束/.test(trimmed)) break; continue } // boundary: stop after the closing marker
          const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
          if (heading) { flush(); if (/回答提示/.test(heading[2])) break; out.push(h('div', { key: 'h' + k++, style: css.mdH1 }, inline(heading[2], 'hi' + k))); continue }
          if (/^---+$/.test(trimmed)) { flush(); out.push(h('hr', { key: 'hr' + k++, style: css.mdHr })); continue }
          const cat = trimmed.match(/^【(.+)】$/)
          if (cat) { flush(); out.push(h('div', { key: 'c' + k++, style: css.mdCat }, h('span', { style: css.mdCatBar }), cat[1])); continue }
          const item = trimmed.match(/^(\d+)\.\s+(.*)$/)
          if (item) {
            flush()
            const body = []
            while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*\d+\.\s/.test(lines[i + 1])) {
              body.push(lines[++i].trim())
            }
            out.push(h('div', { key: 'it' + k++, style: css.mdItem, className: 'aihot-card' },
              h('span', { style: css.mdNum }, item[1]),
              h('div', { style: { minWidth: 0 } },
                h('div', { style: css.mdItemTitle }, inline(item[2], 'it' + k)),
                body.length ? h('div', { style: css.mdItemBody }, body.map((b, bi) => h('div', { key: bi }, inline(b, 'ib' + k + bi)))) : null)))
            continue
          }
          const bullet = trimmed.match(/^[-*]\s+(.*)$/)
          if (bullet) { flush(); out.push(h('div', { key: 'b' + k++, style: { ...css.mdP, display: 'flex', gap: 8 } }, h('span', { style: { color: T.brand } }, '•'), h('span', null, inline(bullet[1], 'bi' + k)))); continue }
          para.push(trimmed)
        }
        flush()
        return out
      }, [source])
      return h('div', { style: css.md }, blocks)
    }

    function addDays(dateStr, n) {
      const [y, m, d] = dateStr.split('-').map(Number)
      const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
      const p = (x) => String(x).padStart(2, '0')
      return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    }

    // Latest available daily-report date: the report for date D publishes at D 08:00 Beijing.
    function latestReportDate() {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
      const g = Object.fromEntries(parts.map((p) => [p.type, p.value]))
      const today = `${g.year}-${g.month}-${g.day}`
      const minutes = Number(g.hour === '24' ? '0' : g.hour) * 60 + Number(g.minute)
      return minutes >= 480 ? today : addDays(today, -1)
    }

    function DailyReport({ nonce }) {
      const [date, setDate] = useState(null) // null = latest
      const [md, setMd] = useState('')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)

      const load = useCallback(async (d) => {
        setLoading(true); setError(null)
        try {
          const url = d ? `${BASE}/api/v1/agent/daily/${d}` : `${BASE}/api/v1/agent/daily`
          const res = await fetch(url, { headers: { Accept: 'text/markdown, text/plain' } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setMd(await res.text())
        } catch (err) {
          setError(String(err?.message || err)); setMd('')
        } finally { setLoading(false) }
      }, [])

      useEffect(() => { load(date) }, [date, nonce, load])

      const shownDate = useMemo(() => {
        const m = md.match(/日报\s*·\s*(\d{4}-\d{2}-\d{2})/)
        return m ? m[1] : date
      }, [md, date])

      const maxDate = useMemo(() => latestReportDate(), [nonce])
      const atLatest = shownDate != null && shownDate >= maxDate
      const nextDisabled = loading || atLatest

      return h('div', null,
        h('div', { style: css.dtoolbar },
          h('button', { style: css.dnav, className: 'aihot-btn', onClick: () => setDate(shownDate ? addDays(shownDate, -1) : null), disabled: loading }, '← 前一天'),
          h('span', { style: css.ddate }, shownDate || '最新一期'),
          h('button', { style: { ...css.dnav, ...(nextDisabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }, className: 'aihot-btn', onClick: () => { if (!nextDisabled && shownDate) setDate(addDays(shownDate, 1)) }, disabled: nextDisabled, title: atLatest ? '已是最新日报' : '查看后一天' }, '后一天 →'),
          h('button', { style: { ...css.dnav, marginLeft: 'auto' }, className: 'aihot-btn', onClick: () => { setDate(null); load(null) } }, '回到最新'),
          shownDate ? h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: `${BASE}/daily/${shownDate}`, target: '_blank', rel: 'noreferrer' }, '网页版', h('span', null, '↗')) : null),
        error ? h('div', { style: css.error }, `日报读取失败：${error}`) : null,
        loading && !md ? h('div', { style: css.empty }, '日报加载中…') : h(Markdown, { source: md }))
    }

    function Countdown({ target }) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
      const ms = target - now
      if (!Number.isFinite(ms)) return null
      if (ms <= 0) return h('span', { style: css.countdown }, '窗口已开启 · 待确认')
      const s = Math.floor(ms / 1000)
      const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
      const parts = []
      if (d) parts.push(`${d}天`)
      if (hh || d) parts.push(`${hh}小时`)
      parts.push(`${mm}分`, `${String(ss).padStart(2, '0')}秒`)
      return h('span', { style: css.countdown }, '距预计窗口 ', parts.join(' '))
    }

    const monitorColor = (m) => m === 'healthy' ? T.success : m === 'delayed' ? T.warn : T.dimmed
    const monitorTitle = (m) => m === 'healthy' ? 'AIHOT 监控正常' : m === 'delayed' ? 'AIHOT 数据延迟' : 'AIHOT 监控状态未知'

    function ProviderChip({ provider, resp }) {
      const err = resp?._error
      const events = resp?.events || []
      const monitor = resp?.monitor?.status || 'unknown'
      const pending = events.filter((e) => e.status === 'announced')
      const confirmed = events.filter((e) => e.status === 'confirmed')
      const dotColor = err ? T.error : monitorColor(monitor)
      const dotTitle = err ? `读取失败：${err}` : monitorTitle(monitor)
      const meta = err ? '读取失败' : monitor === 'delayed' ? '数据延迟' : pending.length ? '有重置预告' : '近 7 天无预告'
      return h('div', { style: css.chip },
        h('div', { style: css.chipTop }, h('span', { style: css.chipName }, provider.label), h('span', { style: css.dot(dotColor), title: dotTitle })),
        h('div', { style: css.chipVal }, err ? '—' : pending.length ? `${pending.length} 待生效` : confirmed.length ? `${confirmed.length} 近期` : '—'),
        h('div', { style: css.chipMeta }, meta))
    }

    function PendingCard({ provider, event, outage }) {
      const when = event.estimate?.label || event.schedule?.label
      const post = event.posts?.[0]
      const postUrl = post?.url || (post?.id ? `https://x.com/i/status/${post.id}` : null)
      const target = event.estimate?.from ? Date.parse(event.estimate.from) : (event.schedule?.from ? Date.parse(event.schedule.from) : NaN)
      const outageText = outage ? (outage.label || outage.message || outage.title || outage.since || outage.at || '详见 AIHOT') : null
      return h('div', { style: css.hero },
        outageText ? h('div', { style: { fontSize: 11.5, color: T.warn, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: css.dot(T.warn) }), `服务故障公告：${outageText}`) : null,
        h('div', { style: css.row },
          h('span', { style: css.cardTitle }, h('span', { style: css.dot(T.warn) }), `${provider.label} · ${event.displayLabel || event.label || '额度重置'}`),
          h('span', { style: css.badge(T.warn) }, '预告')),
        event.title ? h('div', { style: css.meta }, event.title) : null,
        when ? h('div', { style: css.metaDim }, `预计：${when}`) : null,
        (Number.isFinite(target) || postUrl) ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 } },
          Number.isFinite(target) ? h(Countdown, { target }) : null,
          postUrl ? h('a', { style: { ...css.link, marginTop: 0 }, href: postUrl, target: '_blank', rel: 'noreferrer' }, '查看原帖', h('span', null, '↗')) : null) : null)
    }

    function EventCard({ provider, event }) {
      const when = event.estimate?.label || event.schedule?.label
      const post = event.posts?.[0]
      const postUrl = post?.url || (post?.id ? `https://x.com/i/status/${post.id}` : null)
      return h('div', { style: css.card, className: 'aihot-card' },
        h('div', { style: css.row },
          h('span', { style: css.cardTitle }, h('span', { style: css.dot(T.success) }), `${provider.label} · ${event.displayLabel || event.label || '额度重置'}`),
          h('span', { style: css.badgeSoft(T.success) }, '已到账')),
        when ? h('div', { style: css.metaDim }, when) : null,
        postUrl ? h('a', { style: css.link, href: postUrl, target: '_blank', rel: 'noreferrer' }, '原帖', h('span', null, '↗')) : null)
    }

    function RadarContent({ nonce, onMonitor }) {
      const [data, setData] = useState({})
      const [loading, setLoading] = useState(true)
      const [failed, setFailed] = useState([])
      const [updatedAt, setUpdatedAt] = useState(null)

      useEffect(() => {
        let cancelled = false
        const ctrl = new AbortController()
        const to = setTimeout(() => ctrl.abort(), 8000)
        setLoading(true)
        ;(async () => {
          const results = await Promise.allSettled(PROVIDERS.map(async (p) => {
            const res = await fetch(`${BASE}/api/v1/${p.id}-resets/recent`, { headers: { Accept: 'application/json' }, signal: ctrl.signal })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return [p.id, await res.json()]
          }))
          clearTimeout(to)
          if (cancelled) return
          const next = {}; const fails = []
          results.forEach((r, i) => {
            const id = PROVIDERS[i].id
            if (r.status === 'fulfilled') next[id] = r.value[1]
            else { next[id] = { _error: String(r.reason?.message || r.reason) }; fails.push(id) }
          })
          setData(next); setFailed(fails); setUpdatedAt(new Date()); setLoading(false)
        })()
        return () => { cancelled = true; clearTimeout(to); ctrl.abort() }
      }, [nonce])

      const { pending, recent, apiCheckedAt } = useMemo(() => {
        const pending = [], recent = []
        let apiCheckedAt = null
        for (const p of PROVIDERS) {
          const resp = data[p.id]
          if (resp?.checkedAt && (!apiCheckedAt || resp.checkedAt > apiCheckedAt)) apiCheckedAt = resp.checkedAt
          for (const ev of resp?.events || []) {
            if (ev.status === 'announced') pending.push({ provider: p, event: ev, outage: resp?.outage })
            else recent.push({ provider: p, event: ev })
          }
        }
        recent.sort((a, b) => Date.parse(b.event.updatedAt || b.event.createdAt || 0) - Date.parse(a.event.updatedAt || a.event.createdAt || 0))
        return { pending, recent, apiCheckedAt }
      }, [data])

      useEffect(() => {
        if (!onMonitor) return
        const statuses = PROVIDERS.map((p) => data[p.id]?._error ? 'unknown' : (data[p.id]?.monitor?.status || 'unknown'))
        const agg = statuses.includes('delayed') ? 'delayed' : statuses.every((s) => s === 'healthy') ? 'healthy' : 'unknown'
        onMonitor(agg)
      }, [data, onMonitor])

      const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) } catch { return iso } }

      return h('div', null,
        failed.length ? h('div', { style: css.error }, `部分来源读取失败：${failed.join('、')} · 其余数据仍可用`) : null,
        h('div', { style: css.strip }, PROVIDERS.map((p) => h(ProviderChip, { key: p.id, provider: p, resp: data[p.id] }))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, '待生效预告', h('span', { style: css.count }, pending.length)),
          pending.length ? pending.map((x, i) => h(PendingCard, { key: 'p' + i, ...x })) : h('div', { style: css.empty }, loading ? '加载中…' : '当前没有待生效的重置预告')),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, '最近事件', h('span', { style: css.count }, recent.length)),
          recent.length ? h('div', { style: css.grid }, recent.slice(0, 10).map((x, i) => h(EventCard, { key: 'r' + i, ...x }))) : h('div', { style: css.empty }, loading ? '加载中…' : '近 7 天无记录')),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, '资讯工具', h('span', { style: css.count }, TOOLS.length)),
          h('div', { style: css.tools }, TOOLS.map(([name, desc]) => h('div', { style: css.tool, className: 'aihot-tool', key: name }, h('span', { style: css.toolDot }), h('span', { style: css.code }, name), h('span', { style: css.toolDesc }, desc)))),
          h('div', { style: { ...css.metaDim, marginTop: 10 } }, '在对话中直接提问即可调用，例如「今天 AI 圈发生了什么」')),
        h('div', { style: { ...css.metaDim, marginTop: -8, marginBottom: 8 } },
          (apiCheckedAt ? `AIHOT 核对于 ${fmtTime(apiCheckedAt)}` : '') + (apiCheckedAt && updatedAt ? ' · ' : '') + (updatedAt ? `面板刷新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : '')),
        h('div', { style: { ...css.metaDim, marginBottom: 16 } }, '后台推送状态可向 Agent 提问（aihot_radar_status）'))
    }

    function RadarPanel() {
      const [tab, setTab] = useState('radar')
      const [nonce, setNonce] = useState(0)
      const [monitor, setMonitor] = useState('unknown')

      useEffect(() => {
        if (document.getElementById('aihot-radar-style')) return
        const el = document.createElement('style')
        el.id = 'aihot-radar-style'
        el.textContent = `
          @keyframes aihot-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,199,89,0.5); } 70% { box-shadow: 0 0 0 6px rgba(52,199,89,0); } 100% { box-shadow: 0 0 0 0 rgba(52,199,89,0); } }
          .aihot-radar-panel::-webkit-scrollbar { width: 8px; }
          .aihot-radar-panel::-webkit-scrollbar-track { background: transparent; }
          .aihot-radar-panel::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 8px; }
          .aihot-radar-panel::-webkit-scrollbar-thumb:hover { background: ${T.tertiary}; }
          .aihot-card:hover { border-color: ${T.border}; background: ${T.layer2}; }
          .aihot-btn:hover { border-color: ${T.brand}; color: ${T.text}; background: ${T.hover}; }
          .aihot-tool:hover { border-color: ${T.border}; background: ${T.layer2}; }
          .aihot-link:hover { opacity: 0.75; }
          .aihot-tab:hover { color: ${T.sub}; background: ${T.hover}; }
        `
        document.head.appendChild(el)
      }, [])

      return h('div', { style: css.panel, className: 'aihot-radar-panel' },
        h('div', { style: css.head },
          h('div', { style: css.titleWrap },
            h('div', { style: css.iconBadge }, h(RadarIcon, { size: 21 })),
            h('div', null,
              h('div', { style: css.h1 }, 'AIHOT 雷达', h('span', { style: { ...css.live, background: monitorColor(monitor) }, title: monitorTitle(monitor) })),
              h('div', { style: css.sub }, 'Codex / Claude / Antigravity 额度重置监控 · AI 资讯日报'))),
          h('button', { style: css.btn, className: 'aihot-btn', onClick: () => setNonce((n) => n + 1) }, '刷新')),

        h('div', { style: css.tabs },
          h('button', { style: { ...css.tab, ...(tab === 'radar' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('radar') }, h(RadarIcon, { size: 15 }), '额度雷达'),
          h('button', { style: { ...css.tab, ...(tab === 'daily' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('daily') }, '📰', '今日日报')),

        tab === 'radar' ? h(RadarContent, { nonce, onMonitor: setMonitor }) : h(DailyReport, { nonce }),

        h('div', { style: css.foot },
          '数据来源', h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: BASE, target: '_blank', rel: 'noreferrer' }, 'AIHOT', h('span', null, '↗')),
          h('span', { style: { marginLeft: 'auto' } }, '后台雷达自动推送 · webhook 见 state.json')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'aihot-radar', order: 60, label: 'AIHOT 雷达',
        }, RadarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'aihot-radar',
        }, RadarPanel))
      },
    }
  },
})