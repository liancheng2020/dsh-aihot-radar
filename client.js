// Client half: a sidebar panel that reads the public AIHOT API directly
// (CORS: *). Two tabs: the quota-reset radar and a daily-report reader.
// Bilingual UI (zh/en) following the host locale; styled with --dsw-alias-* tokens.
// The message catalog below mirrors locale/*.json (build-free plugin: the module
// loader cannot require arbitrary JSON, so the catalog is inlined here).
window.__ModuleLoader__.load({
  id: 'dsh-aihot-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    const BASE = 'https://aihot.news'
    // Keep in sync with lib/api.js PROVIDERS.
    const PROVIDERS = [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude' },
      { id: 'antigravity', label: 'Antigravity' },
    ]
    const TOOLS = [
      ['aihot_latest', 'tool.latest'],
      ['aihot_search', 'tool.search'],
      ['aihot_hot', 'tool.hot'],
      ['aihot_daily', 'tool.daily'],
      ['aihot_report', 'tool.report'],
      ['aihot_story', 'tool.story'],
      ['aihot_resets', 'tool.resets'],
    ]

    const L = {
      zh: {
        'meta.title': 'AIHOT 雷达',
        'sub': 'Codex / Claude / Antigravity 额度重置监控 · AI 资讯日报',
        'refresh': '刷新',
        'tab.radar': '额度雷达', 'tab.daily': '今日日报',
        'monitor.healthy': 'AIHOT 监控正常', 'monitor.delayed': 'AIHOT 数据延迟', 'monitor.unknown': 'AIHOT 监控状态未知',
        'chip.pending': '{n} 待生效', 'chip.recent': '{n} 近期',
        'chip.hasPending': '有重置预告', 'chip.noPending': '近 7 天无预告', 'chip.delayed': '数据延迟', 'chip.failed': '读取失败',
        'sec.pending': '待生效预告', 'sec.recent': '最近事件', 'sec.tools': '资讯工具',
        'empty.pending': '当前没有待生效的重置预告', 'empty.loading': '加载中…', 'empty.recent': '近 7 天无记录',
        'tools.hint': '在对话中直接提问即可调用，例如「今天 AI 圈发生了什么」',
        'status.checkedAt': 'AIHOT 核对于 {t}', 'status.refreshedAt': '面板刷新于 {t}',
        'status.askAgent': '后台推送状态可向 Agent 提问（aihot_radar_status）',
        'badge.announced': '预告', 'badge.confirmed': '已到账',
        'reset.default': '额度重置', 'outage': '服务故障公告：{t}', 'outage.recovered': '已恢复', 'estimate': '预计：{t}',
        'link.source': '查看原帖', 'link.sourceShort': '原帖',
        'countdown.prefix': '距预计窗口', 'countdown.open': '窗口已开启 · 待确认',
        'unit.day': '天', 'unit.hour': '小时', 'unit.min': '分', 'unit.sec': '秒',
        'daily.prev': '← 前一天', 'daily.next': '后一天 →', 'daily.latest': '回到最新', 'daily.web': '网页版',
        'daily.latestLabel': '最新一期', 'daily.atLatest': '已是最新日报', 'daily.nextTitle': '查看后一天',
        'daily.failed': '日报读取失败：{e}', 'daily.loading': '日报加载中…',
        'foot.source': '数据来源', 'foot.push': '后台雷达自动推送 · webhook 见 state.json',
        'err.partial': '部分来源读取失败：{p} · 其余数据仍可用',
        'tool.latest': '最近 AI 重点资讯', 'tool.search': '关键词搜索资讯', 'tool.hot': '当前 AI 热榜',
        'tool.daily': 'AIHOT 日报', 'tool.report': '周报 / 月报', 'tool.story': '热点事件时间线', 'tool.resets': '额度重置记录',
      },
      en: {
        'meta.title': 'AIHOT Radar',
        'sub': 'Codex / Claude / Antigravity quota-reset monitoring · AI news digest',
        'refresh': 'Refresh',
        'tab.radar': 'Quota Radar', 'tab.daily': 'Daily Report',
        'monitor.healthy': 'AIHOT monitor healthy', 'monitor.delayed': 'AIHOT data delayed', 'monitor.unknown': 'AIHOT monitor status unknown',
        'chip.pending': '{n} pending', 'chip.recent': '{n} recent',
        'chip.hasPending': 'Reset pending', 'chip.noPending': 'No pending in 7 days', 'chip.delayed': 'Data delayed', 'chip.failed': 'Failed to load',
        'sec.pending': 'Pending announcements', 'sec.recent': 'Recent events', 'sec.tools': 'News tools',
        'empty.pending': 'No pending reset announcements', 'empty.loading': 'Loading…', 'empty.recent': 'No records in 7 days',
        'tools.hint': 'Ask in chat to invoke, e.g. "what happened in AI today"',
        'status.checkedAt': 'AIHOT checked at {t}', 'status.refreshedAt': 'Panel refreshed at {t}',
        'status.askAgent': 'Ask the agent for push status (aihot_radar_status)',
        'badge.announced': 'Announced', 'badge.confirmed': 'Confirmed',
        'reset.default': 'Quota reset', 'outage': 'Service outage: {t}', 'outage.recovered': 'recovered', 'estimate': 'Expected: {t}',
        'link.source': 'View source', 'link.sourceShort': 'Source',
        'countdown.prefix': 'Window opens in', 'countdown.open': 'Window open · unconfirmed',
        'unit.day': 'd', 'unit.hour': 'h', 'unit.min': 'm', 'unit.sec': 's',
        'daily.prev': '← Prev day', 'daily.next': 'Next day →', 'daily.latest': 'Back to latest', 'daily.web': 'Web version',
        'daily.latestLabel': 'Latest edition', 'daily.atLatest': 'Already the latest', 'daily.nextTitle': 'View next day',
        'daily.failed': 'Failed to load daily: {e}', 'daily.loading': 'Loading daily…',
        'foot.source': 'Data source', 'foot.push': 'Background radar auto-push · webhook in state.json',
        'err.partial': 'Some sources failed: {p} · other data still available',
        'tool.latest': 'Latest AI highlights', 'tool.search': 'Keyword news search', 'tool.hot': 'Current AI trending',
        'tool.daily': 'AIHOT daily', 'tool.report': 'Weekly / monthly', 'tool.story': 'Event timeline', 'tool.resets': 'Quota-reset records',
      },
    }

    let LOCALE = null
    let LANG = 'zh'
    const activeLang = () => { try { return LOCALE?.getLocale?.().active === 'en' ? 'en' : 'zh' } catch { return 'zh' } }
    const tr = (key, lang) => (L[lang] && L[lang][key]) || L.zh[key] || key
    function t(key, vars) {
      let s = tr(key, LANG)
      if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k])
      return s
    }
    function useActiveLang() {
      const [lang, setLang] = useState(activeLang)
      useEffect(() => {
        if (!LOCALE || typeof LOCALE.subscribe !== 'function') return
        const un = LOCALE.subscribe(() => setLang(activeLang()))
        return () => { if (typeof un === 'function') un() }
      }, [])
      return lang
    }

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
      panel: { boxSizing: 'border-box', padding: '20px 22px', color: T.text, fontSize: 13, lineHeight: 1.6, overflowY: 'auto', height: '100%', background: T.base },
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
      strip: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 10, marginBottom: 22 },
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
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g
      let last = 0, m, i = 0
      const link = (label, url, key) => h('a', { key, href: url, target: '_blank', rel: 'noreferrer', style: css.mdLink, className: 'aihot-link' }, label)
      while ((m = re.exec(text))) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const tok = m[0]
        if (tok.startsWith('**')) nodes.push(h('strong', { key: kp + i, style: { color: T.text, fontWeight: 650 } }, tok.slice(2, -2)))
        else if (tok.startsWith('`')) nodes.push(h('code', { key: kp + i, style: css.mdCode }, tok.slice(1, -1)))
        else if (/^https?:\/\//.test(tok)) nodes.push(link(tok, tok, kp + i))
        else {
          const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
          if (mm && /^https?:\/\//.test(mm[2])) nodes.push(link(mm[1], mm[2], kp + i))
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
          if (/^［.*］$/.test(trimmed)) { flush(); if (/结束/.test(trimmed)) break; continue }
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
      const t2 = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
      const p = (x) => String(x).padStart(2, '0')
      return `${t2.getUTCFullYear()}-${p(t2.getUTCMonth() + 1)}-${p(t2.getUTCDate())}`
    }

    function latestReportDate() {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
      const g = Object.fromEntries(parts.map((p) => [p.type, p.value]))
      const today = `${g.year}-${g.month}-${g.day}`
      const minutes = Number(g.hour === '24' ? '0' : g.hour) * 60 + Number(g.minute)
      return minutes >= 480 ? today : addDays(today, -1)
    }

    function DailyReport({ nonce }) {
      const [date, setDate] = useState(null)
      const [md, setMd] = useState('')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)

      useEffect(() => {
        let cancelled = false
        const ctrl = new AbortController()
        const to = setTimeout(() => ctrl.abort(), 8000)
        setLoading(true); setError(null)
        ;(async () => {
          try {
            const url = date ? `${BASE}/api/v1/agent/daily/${date}` : `${BASE}/api/v1/agent/daily`
            const res = await fetch(url, { headers: { Accept: 'text/markdown, text/plain' }, signal: ctrl.signal })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const text = await res.text()
            if (!cancelled) setMd(text)
          } catch (err) {
            if (!cancelled) { setError(String(err?.message || err)); setMd('') }
          } finally {
            clearTimeout(to)
            if (!cancelled) setLoading(false)
          }
        })()
        return () => { cancelled = true; clearTimeout(to); ctrl.abort() }
      }, [date, nonce])

      const shownDate = useMemo(() => {
        const m = md.match(/日报\s*·\s*(\d{4}-\d{2}-\d{2})/)
        return m ? m[1] : date
      }, [md, date])

      const maxDate = useMemo(() => latestReportDate(), [nonce])
      const atLatest = shownDate != null && shownDate >= maxDate
      const nextDisabled = loading || atLatest

      return h('div', null,
        h('div', { style: css.dtoolbar },
          h('button', { type: 'button', style: css.dnav, className: 'aihot-btn', onClick: () => setDate(shownDate ? addDays(shownDate, -1) : null), disabled: loading }, t('daily.prev')),
          h('span', { style: css.ddate }, shownDate || t('daily.latestLabel')),
          h('button', { type: 'button', style: { ...css.dnav, ...(nextDisabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }, className: 'aihot-btn', onClick: () => { if (!nextDisabled && shownDate) setDate(addDays(shownDate, 1)) }, disabled: nextDisabled, title: atLatest ? t('daily.atLatest') : t('daily.nextTitle') }, t('daily.next')),
          h('button', { type: 'button', style: { ...css.dnav, marginLeft: 'auto' }, className: 'aihot-btn', onClick: () => setDate(null) }, t('daily.latest')),
          shownDate ? h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: `${BASE}/daily/${shownDate}`, target: '_blank', rel: 'noreferrer' }, t('daily.web'), h('span', null, '↗')) : null),
        error ? h('div', { style: css.error }, t('daily.failed', { e: error })) : null,
        loading && !md ? h('div', { style: css.empty }, t('daily.loading')) : h(Markdown, { source: md }))
    }

    function Countdown({ target }) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => { const ti = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(ti) }, [])
      const ms = target - now
      if (!Number.isFinite(ms)) return null
      if (ms <= 0) return h('span', { style: css.countdown }, t('countdown.open'))
      const s = Math.floor(ms / 1000)
      const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
      const parts = []
      if (d) parts.push(`${d}${t('unit.day')}`)
      if (hh || d) parts.push(`${hh}${t('unit.hour')}`)
      parts.push(`${mm}${t('unit.min')}`, `${String(ss).padStart(2, '0')}${t('unit.sec')}`)
      return h('span', { style: css.countdown }, t('countdown.prefix') + ' ', parts.join(' '))
    }

    const monitorColor = (m) => m === 'healthy' ? T.success : m === 'delayed' ? T.warn : T.dimmed
    const monitorTitle = (m) => t(m === 'healthy' ? 'monitor.healthy' : m === 'delayed' ? 'monitor.delayed' : 'monitor.unknown')
    const fmtTime = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) } catch { return String(iso) } }

    function ProviderChip({ provider, resp }) {
      const err = resp?._error
      const events = resp?.events || []
      const monitor = resp?.monitor?.status || 'unknown'
      const pending = events.filter((e) => e.status === 'announced')
      const confirmed = events.filter((e) => e.status === 'confirmed')
      const dotColor = err ? T.error : monitorColor(monitor)
      const dotTitle = err ? `${t('chip.failed')}: ${err}` : monitorTitle(monitor)
      const meta = err ? t('chip.failed') : monitor === 'delayed' ? t('chip.delayed') : pending.length ? t('chip.hasPending') : t('chip.noPending')
      return h('div', { style: css.chip },
        h('div', { style: css.chipTop }, h('span', { style: css.chipName }, provider.label), h('span', { style: css.dot(dotColor), title: dotTitle })),
        h('div', { style: css.chipVal }, err ? '—' : pending.length ? t('chip.pending', { n: pending.length }) : confirmed.length ? t('chip.recent', { n: confirmed.length }) : '—'),
        h('div', { style: css.chipMeta }, meta))
    }

    function PendingCard({ provider, event, outage }) {
      const when = event.estimate?.label || event.schedule?.label
      const post = event.posts?.[0]
      const postUrl = post?.url || (post?.id ? `https://x.com/i/status/${post.id}` : null)
      const target = event.estimate?.from ? Date.parse(event.estimate.from) : (event.schedule?.from ? Date.parse(event.schedule.from) : NaN)
      const outageText = outage
        ? ([fmtTime(outage.publishedAt), outage.text || outage.originalText?.slice(0, 40)].filter(Boolean).join(' · ') + (outage.recoveredAt ? ` ${t('outage.recovered')}` : ''))
        : null
      return h('div', { style: css.hero },
        outageText ? h('div', { style: { fontSize: 11.5, color: T.warn, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: css.dot(T.warn) }), t('outage', { t: outageText })) : null,
        h('div', { style: css.row },
          h('span', { style: css.cardTitle }, h('span', { style: css.dot(T.warn) }), `${provider.label} · ${event.displayLabel || event.label || t('reset.default')}`),
          h('span', { style: css.badge(T.warn) }, t('badge.announced'))),
        event.title ? h('div', { style: css.meta }, event.title) : null,
        when ? h('div', { style: css.metaDim }, t('estimate', { t: when })) : null,
        (Number.isFinite(target) || postUrl) ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 } },
          Number.isFinite(target) ? h(Countdown, { target }) : null,
          postUrl ? h('a', { style: { ...css.link, marginTop: 0 }, href: postUrl, target: '_blank', rel: 'noreferrer' }, t('link.source'), h('span', null, '↗')) : null) : null)
    }

    function EventCard({ provider, event }) {
      const when = event.estimate?.label || event.schedule?.label
      const post = event.posts?.[0]
      const postUrl = post?.url || (post?.id ? `https://x.com/i/status/${post.id}` : null)
      return h('div', { style: css.card, className: 'aihot-card' },
        h('div', { style: css.row },
          h('span', { style: css.cardTitle }, h('span', { style: css.dot(T.success) }), `${provider.label} · ${event.displayLabel || event.label || t('reset.default')}`),
          h('span', { style: css.badgeSoft(T.success) }, t('badge.confirmed'))),
        when ? h('div', { style: css.metaDim }, when) : null,
        postUrl ? h('a', { style: css.link, href: postUrl, target: '_blank', rel: 'noreferrer' }, t('link.sourceShort'), h('span', null, '↗')) : null)
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

      return h('div', null,
        failed.length ? h('div', { style: css.error }, t('err.partial', { p: failed.join('、') })) : null,
        h('div', { style: css.strip }, PROVIDERS.map((p) => h(ProviderChip, { key: p.id, provider: p, resp: data[p.id] }))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.pending'), h('span', { style: css.count }, pending.length)),
          pending.length ? pending.map((x, i) => h(PendingCard, { key: 'p' + i, ...x })) : h('div', { style: css.empty }, loading ? t('empty.loading') : t('empty.pending'))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.recent'), h('span', { style: css.count }, recent.length)),
          recent.length ? h('div', { style: css.grid }, recent.slice(0, 10).map((x, i) => h(EventCard, { key: 'r' + i, ...x }))) : h('div', { style: css.empty }, loading ? t('empty.loading') : t('empty.recent'))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.tools'), h('span', { style: css.count }, TOOLS.length)),
          h('div', { style: css.tools }, TOOLS.map(([name, key]) => h('div', { style: css.tool, className: 'aihot-tool', key: name }, h('span', { style: css.toolDot }), h('span', { style: css.code }, name), h('span', { style: css.toolDesc }, t(key))))),
          h('div', { style: { ...css.metaDim, marginTop: 10 } }, t('tools.hint'))),
        h('div', { style: { ...css.metaDim, marginTop: -8, marginBottom: 8 } },
          (apiCheckedAt ? t('status.checkedAt', { t: fmtTime(apiCheckedAt) }) : '') + (apiCheckedAt && updatedAt ? ' · ' : '') + (updatedAt ? t('status.refreshedAt', { t: updatedAt.toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) }) : '')),
        h('div', { style: { ...css.metaDim, marginBottom: 16 } }, t('status.askAgent')))
    }

    function RadarPanel() {
      LANG = useActiveLang()
      const [tab, setTab] = useState('radar')
      const [nonce, setNonce] = useState(0)
      const [monitor, setMonitor] = useState('unknown')

      useEffect(() => {
        if (document.getElementById('aihot-radar-style')) return
        const el = document.createElement('style')
        el.id = 'aihot-radar-style'
        el.textContent = `
          @keyframes aihot-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,199,89,0.5); } 70% { box-shadow: 0 0 0 6px rgba(52,199,89,0); } 100% { box-shadow: 0 0 0 0 rgba(52,199,89,0); } }
          @media (prefers-reduced-motion: reduce) { .aihot-pulse { animation: none !important; } }
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
              h('div', { style: css.h1 }, t('meta.title'), h('span', { className: 'aihot-pulse', style: { ...css.live, background: monitorColor(monitor) }, title: monitorTitle(monitor), 'aria-hidden': true })),
              h('div', { style: css.sub }, t('sub')))),
          h('button', { type: 'button', style: css.btn, className: 'aihot-btn', onClick: () => setNonce((n) => n + 1) }, t('refresh'))),

        h('div', { style: css.tabs, role: 'tablist' },
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'radar', style: { ...css.tab, ...(tab === 'radar' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('radar') }, h(RadarIcon, { size: 15 }), t('tab.radar')),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'daily', style: { ...css.tab, ...(tab === 'daily' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('daily') }, '📰', t('tab.daily'))),

        tab === 'radar' ? h(RadarContent, { nonce, onMonitor: setMonitor }) : h(DailyReport, { nonce }),

        h('div', { style: css.foot },
          t('foot.source'), h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: BASE, target: '_blank', rel: 'noreferrer' }, 'AIHOT', h('span', null, '↗')),
          h('span', { style: { marginLeft: 'auto' } }, t('foot.push'))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        LOCALE = ctx.locale
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'aihot-radar', order: 60, label: () => tr('meta.title', activeLang()), locale: 'aihot-radar',
        }, RadarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'aihot-radar', locale: 'aihot-radar',
        }, RadarPanel))
      },
    }
  },
})