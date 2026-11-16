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
    const LOCAL_API = 'http://127.0.0.1:17420'
    const REPO = 'https://github.com/liancheng2020/dsh-aihot-radar'
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
    const SAMPLE = {
      aihot_latest: ['今天 AI 圈发生了什么？', 'What happened in AI today?'],
      aihot_search: ['帮我搜一下关于「大模型 价格」的 AI 资讯', 'Search AI news about "LLM pricing"'],
      aihot_hot: ['现在 AI 热榜上有哪些话题？', 'What is on the AI hot list right now?'],
      aihot_daily: ['给我今天的 AIHOT 日报', 'Give me today\'s AIHOT daily digest'],
      aihot_report: ['生成本周的 AI 周报', 'Generate this week\'s AI weekly report'],
      aihot_story: ['梳理一下最近热点事件的时间线', 'Build a timeline of the recent hot story'],
      aihot_resets: ['查一下 Codex / Claude 的额度重置记录', 'Show Codex / Claude quota reset history'],
    }
    const sampleQuestion = (name) => (SAMPLE[name] || ['', ''])[LANG === 'en' ? 1 : 0]

    // Keep in sync with the ADAPTERS keys in lib/notify.js. 'none' is not a
    // choice here — turning push off is a separate action, not a channel.
    const CHANNELS = ['wecom', 'dingtalk', 'feishu', 'bark', 'serverchan', 'telegram', 'generic']
    // Half-hour presets for the digest time field. The field also takes typed
    // input, so an odd time (08:47) is still possible — the list is a shortcut,
    // not a constraint, which is why a themed combobox beats a <select>.
    const DIGEST_PRESETS = Array.from({ length: 48 }, (_, i) => {
      const m = i * 30
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`
    })
    const URL_HINT = {
      wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
      dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=…',
      feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
      bark: 'https://api.day.app/your-key',
      serverchan: 'https://sctapi.ftqq.com/SCT….send',
      telegram: '123456789:AA…',
      generic: 'https://example.com/webhook',
    }
    // Paste a URL and the channel follows: picking the wrong one was the most
    // common first-run failure.
    const CHANNEL_BY_HOST = {
      'qyapi.weixin.qq.com': 'wecom',
      'oapi.dingtalk.com': 'dingtalk',
      'open.feishu.cn': 'feishu',
      'api.day.app': 'bark',
      'sctapi.ftqq.com': 'serverchan',
      'api.telegram.org': 'telegram',
    }
    const detectChannel = (raw) => {
      const s = String(raw || '').trim()
      if (!s) return ''
      if (/^\d+:[\w-]{10,}$/.test(s)) return 'telegram' // bot token, not a url
      try {
        return CHANNEL_BY_HOST[new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).host] || ''
      } catch { return '' }
    }
    // Fallback for when the loopback bridge is unreachable (https page or
    // remote host): a snippet to paste into state.json by hand.
    const WEBHOOK_SNIPPET = '{ "webhook": { "channel": "wecom", "url": "<你的 webhook 地址>", "secret": "" } }'

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
        'tools.hint': '点击卡片复制示例问句，去对话粘贴即可调用；也可直接提问，例如「今天 AI 圈发生了什么」',
        'status.checkedAt': 'AIHOT 核对于 {t}', 'status.refreshedAt': '面板刷新于 {t}', 'status.tz': '（北京时间）',
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
        'tools.copiedTitle': '已复制示例问句，', 'tools.copiedBody': '去对话粘贴即可调用', 'tools.copiedShort': '已复制 ✓', 'tools.copyFail': '复制失败，请手动复制：',
        'sec.push': '推送配置', 'push.channel': '推送通道：{c}', 'push.on': '已配置', 'push.off': '未配置',
        'chan.none': '未配置', 'chan.wecom': '企业微信', 'chan.dingtalk': '钉钉', 'chan.feishu': '飞书',
        'chan.bark': 'Bark', 'chan.serverchan': 'Server酱', 'chan.telegram': 'Telegram', 'chan.generic': '通用 Webhook',
        'push.hint': '预告/到账与 AI 日报将推送到这里，保存即生效，无需重启。',
        'push.empty': '还没有配置推送通道。填好地址保存，就能收到额度重置与日报。',
        'push.banner': '推送还没配置：配好后重置预告与日报会自动推到你的 IM。',
        'push.bannerCta': '现在配置', 'push.retry': '重试',
        'push.snippet': '复制 webhook 配置', 'push.snippetCopied': '配置片段已复制，粘到 state.json 的 webhook 字段',
        'push.bridgePath': '或手动编辑：',
        'push.copyDiag': '复制诊断信息', 'push.diagCopied': '诊断信息已复制',
        'push.diag.https': '当前面板页面是 {o}（https），浏览器禁止它访问 http://127.0.0.1（混合内容拦截）——这种环境下面板无法直连宿主。',
        'push.diag.cors': '宿主可达，但面板来源 {o} 没有被放行（安全白名单）。请复制诊断信息反馈给作者。',
        'push.diag.down': '连不上 127.0.0.1:17420：本地桥接未启动、端口被占用，或页面 CSP 拦了该请求。查宿主日志有无「本地桥接已监听 127.0.0.1:17420」。',
        'push.current': '当前地址：{h}',
        'push.field.channel': '推送通道', 'push.field.url': 'Webhook 地址', 'push.field.token': 'Bot Token',
        'push.field.secret': '加签密钥（可选）', 'push.field.chat': 'chat_id',
        'push.saveTest': '保存并发送测试', 'push.save': '仅保存', 'push.saving': '保存中…',
        'push.edit': '修改', 'push.cancel': '取消', 'push.saved': '已保存，下一轮推送即生效。',
        'push.disable': '关闭推送', 'push.disableConfirm': '确认关闭？', 'push.disabled': '已关闭推送，可随时重新配置。',
        'push.test': '发送测试推送', 'push.testing': '发送中…',
        'push.testOk': '测试推送成功：{c} 通道正常，发出 {n} 条。',
        'push.bridge': '面板拿不到宿主状态，所以这里配不了。具体原因见下一行；也可以复制下面的配置手填到 state.json 的 webhook 字段，保存后重启 DSH。',
        'push.digest.title': '每日 AI 日报',
        'push.digest.desc': '到点把当天 AI 日报推到上面的通道，并在本地归档一份 Markdown。',
        'push.digest.onBadge': '已启用', 'push.digest.offBadge': '未启用',
        'push.digest.on': '启用定时推送', 'push.digest.time': '推送时间',
        'push.digest.save': '保存日报设置',
        'push.digest.saved': '日报已改为每天 {t} 推送。', 'push.digest.next': '下次推送：{t}（{z}）',
        'push.digest.tzCst': '北京时间',
        'push.digest.needPush': '还没配置推送通道：日报只会归档到本地，不会推出去。',
        'push.digest.off': '已关闭定时推送，日报只做本地归档。',
        'push.digest.stale': '宿主还在跑旧版桥接（/status 里没有 digest 字段），这里改不了。重启 DSH 后再设置。',
        'push.digest.badTime': '时间格式需为 HH:MM（24 小时制，可点开下拉选半小时整点）。',
        'push.digest.lastOk': '上次推送：{d} 已送达。',
        'push.digest.lastFail': '上次推送失败（{d}）：{e}',
        'push.digest.test': '发送测试日报', 'push.digest.testing': '发送中…',
        'push.digest.testOk': '测试日报已发出：{d} · {n} 条。',
        'foot.feedback': '反馈/报障',
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
        'tools.hint': 'Click a card to copy a sample question, then paste it in chat; or just ask, e.g. "what happened in AI today"',
        'status.checkedAt': 'AIHOT checked at {t}', 'status.refreshedAt': 'Panel refreshed at {t}', 'status.tz': ' (Beijing time)',
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
        'tools.copiedTitle': 'Sample question copied, ', 'tools.copiedBody': 'paste it in chat to invoke', 'tools.copiedShort': 'Copied ✓', 'tools.copyFail': 'Copy failed, copy manually: ',
        'sec.push': 'Push settings', 'push.channel': 'Push channel: {c}', 'push.on': 'Configured', 'push.off': 'Not set',
        'chan.none': 'Not set', 'chan.wecom': 'WeCom', 'chan.dingtalk': 'DingTalk', 'chan.feishu': 'Feishu',
        'chan.bark': 'Bark', 'chan.serverchan': 'ServerChan', 'chan.telegram': 'Telegram', 'chan.generic': 'Generic webhook',
        'push.hint': 'Reset announcements / confirmations and the AI digest push here. Saving applies immediately.',
        'push.empty': 'No push channel yet. Fill in the URL and save to receive reset alerts and the digest.',
        'push.banner': 'Push is not configured yet — reset alerts and the digest will go to your IM once it is.',
        'push.bannerCta': 'Set it up', 'push.retry': 'Retry',
        'push.snippet': 'Copy webhook config', 'push.snippetCopied': 'Snippet copied; paste it into the webhook field of state.json',
        'push.bridgePath': 'Or edit it yourself:',
        'push.copyDiag': 'Copy diagnostics', 'push.diagCopied': 'Diagnostics copied',
        'push.diag.https': 'This panel is served over {o} (https), so the browser blocks http://127.0.0.1 (mixed content) — the panel cannot reach the host here.',
        'push.diag.cors': 'The host is reachable but does not accept requests from {o}. Send the diagnostics to the author.',
        'push.diag.down': 'Cannot reach 127.0.0.1:17420: the bridge is not running, the port is taken, or the page CSP blocks it. Check host logs for "本地桥接已监听 127.0.0.1:17420".',
        'push.current': 'Endpoint: {h}',
        'push.field.channel': 'Channel', 'push.field.url': 'Webhook URL', 'push.field.token': 'Bot Token',
        'push.field.secret': 'Sign secret (optional)', 'push.field.chat': 'chat_id',
        'push.saveTest': 'Save and send test', 'push.save': 'Save only', 'push.saving': 'Saving…',
        'push.edit': 'Edit', 'push.cancel': 'Cancel', 'push.saved': 'Saved; applies from the next push.',
        'push.disable': 'Turn off', 'push.disableConfirm': 'Confirm?', 'push.disabled': 'Push turned off; configure it again anytime.',
        'push.test': 'Send test push', 'push.testing': 'Sending…',
        'push.testOk': 'Test push via {c} succeeded, {n} message(s) sent.',
        'push.bridge': 'The panel cannot read host state, so it cannot save here. See the cause on the next line; you can also copy the config below into the webhook field of state.json and restart DSH.',
        'push.digest.title': 'Daily AI digest',
        'push.digest.desc': 'Sends the day\'s AI digest to the channel above at the set time, and archives a Markdown copy locally.',
        'push.digest.onBadge': 'Enabled', 'push.digest.offBadge': 'Off',
        'push.digest.on': 'Scheduled push', 'push.digest.time': 'Send time',
        'push.digest.save': 'Save digest settings',
        'push.digest.saved': 'Digest now goes out daily at {t}.', 'push.digest.next': 'Next run: {t} ({z})',
        'push.digest.tzCst': 'Beijing time',
        'push.digest.needPush': 'No push channel yet: the digest is only archived locally.',
        'push.digest.off': 'Scheduled push off; the digest is archived locally only.',
        'push.digest.stale': 'The host is still running an older bridge (no digest field in /status), so this cannot be changed here. Restart DSH first.',
        'push.digest.badTime': 'Time must be HH:MM (24-hour); open the list to pick a half-hour slot.',
        'push.digest.lastOk': 'Last delivered: {d}.',
        'push.digest.lastFail': 'Last push failed ({d}): {e}',
        'push.digest.test': 'Send test digest', 'push.digest.testing': 'Sending…',
        'push.digest.testOk': 'Test digest sent: {d} · {n} chunk(s).',
        'foot.feedback': 'Feedback',
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
      // Outlined variant: same frame as css.btn, no fill. Used for the 修改 button
      // so it reads as a button without competing with the filled actions.
      btnOutline: { fontSize: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${T.border}`, background: 'transparent', color: T.sub, cursor: 'pointer', transition: 'all .15s ease', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' },
      btnPrimary: { fontSize: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(91,140,255,0.45)', background: 'rgba(91,140,255,0.16)', color: T.brand, fontWeight: 600, cursor: 'pointer', transition: 'all .15s ease', display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' },
      field: { marginBottom: 9 },
      fieldLabel: { display: 'block', fontSize: 11.5, color: T.tertiary, marginBottom: 4 },
      input: { boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.base, color: T.text, outline: 'none' },
      // Native <select> popups ignore most styling; colorScheme: 'dark' is what
      // makes Chromium render the list dark instead of grey-on-grey.
      select: { boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: 12, padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.base, color: T.text, outline: 'none', colorScheme: 'dark', cursor: 'pointer' },
      option: { background: T.layer1, color: T.text },
      banner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '9px 12px', marginBottom: 16, borderRadius: 10, border: `1px solid ${T.borderSoft}`, borderLeft: `3px solid ${T.brand}`, background: 'rgba(91,140,255,0.10)' },
      bannerText: { fontSize: 12, color: T.sub },
      bridgeBox: { padding: '12px 14px', background: T.layer1, border: `1px dashed ${T.border}`, borderRadius: 10 },
      pathLine: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: T.brand, marginTop: 6, wordBreak: 'break-all' },
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
      // Section titles share one token with their count pills (T.sub): at
      // T.tertiary a pill-less title like "推送通道" reads dimmer than the
      // section titles followed by a count badge.
      h2: { fontSize: 12, fontWeight: 600, margin: '0 0 10px', color: T.sub, textTransform: 'uppercase', letterSpacing: '0.6px', display: 'flex', alignItems: 'center', gap: 8 },
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
      tool: { display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', background: T.layer1, border: `1px solid ${T.borderSoft}`, borderRadius: 8, transition: 'all .15s ease', cursor: 'pointer', textAlign: 'left', font: 'inherit', width: '100%' },
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

    // Toast anchor: floats at the top of the panel, centered. Fixed positioning
    // keeps it out of the panel's layout flow, so it never shifts content.
    function toastAnchor() {
      const fallback = { position: 'fixed', left: '50%', top: 16, transform: 'translateX(-50%)', zIndex: 999, pointerEvents: 'none' }
      if (typeof document === 'undefined' || typeof window === 'undefined') return fallback
      try {
        const panel = document.querySelector('.aihot-radar-panel')
        const pr = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : null
        if (!pr || !pr.width) return fallback
        return {
          position: 'fixed',
          left: Math.round(pr.left + pr.width / 2),
          top: Math.max(8, Math.round(pr.top + 14)),
          maxWidth: Math.max(200, Math.round(pr.width - 28)),
          transform: 'translateX(-50%)',
          zIndex: 999,
          pointerEvents: 'none',
        }
      } catch { return fallback }
    }

    function RadarIcon({ size = 20, scale = 1 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
        h('g', { transform: `translate(12 12) scale(${scale}) translate(-12 -12)` },
          h('path', { d: 'M12 20 A8 8 0 0 1 4 12', opacity: 0.55 }),
          h('path', { d: 'M12 16 A4 4 0 0 1 8 12', opacity: 0.85 }),
          h('circle', { cx: 12, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }),
          h('line', { x1: 12, y1: 12, x2: 18, y2: 6 }),
          h('circle', { cx: 18, cy: 6, r: 1.7, fill: 'currentColor', stroke: 'none' })))
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

    // One place that reads wall-clock fields for a zone: the report cutoff and
    // the digest "next run" used to each roll their own formatToParts dance.
    const tzParts = (ms, tz) => {
      try {
        const g = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
        const hour = g.hour === '24' ? '00' : g.hour
        return { date: `${g.year}-${g.month}-${g.day}`, hour, minute: g.minute, minutes: Number(hour) * 60 + Number(g.minute) }
      } catch { return null }
    }

    function latestReportDate() {
      const p = tzParts(Date.now())
      const today = p ? p.date : new Date().toISOString().slice(0, 10)
      return p && p.minutes >= 480 ? today : addDays(today, -1)
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
    // "8:5" / "08:05" / "10:30:00" / " 8:05 " → "08:05"; out of range → ''. The
    // host requires a zero-padded HH:MM, so tolerate what people actually paste
    // (trailing seconds are dropped, not rejected).
    const normHm = (raw) => {
      const m = /^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/.exec(String(raw == null ? '' : raw).trim())
      if (!m) return ''
      const h = Number(m[1]), mm = Number(m[2])
      if (h > 23 || mm > 59) return ''
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
    // Minute precision only: "下次推送 08:30" reads better than 08:30:00.
    // The zone comes from digest.timezone — the digest is not always Beijing.
    const fmtHm = (ms, tz) => {
      if (!Number.isFinite(ms)) return ''
      const p = tzParts(ms, tz)
      return p ? `${p.hour}:${p.minute}` : ''
    }
    // Beijing is the default zone for this data set, so it gets a human label.
    const tzLabel = (tz) => (tz === 'Asia/Shanghai' ? t('push.digest.tzCst') : (tz || 'Asia/Shanghai'))

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
      const [copied, setCopied] = useState(null)
      const [toast, setToast] = useState(null)
      const [host, setHost] = useState(null)
      const [editing, setEditing] = useState(false)
      const [form, setForm] = useState({ channel: 'wecom', url: '', secret: '' })
      const [busy, setBusy] = useState('')       // '' | 'save' | 'test'
      const [result, setResult] = useState(null) // { ok, message, hint }
      const [retry, setRetry] = useState(0)
      const [offConfirm, setOffConfirm] = useState(false)
      const [bridgeErr, setBridgeErr] = useState('')
      const [bridgeDiag, setBridgeDiag] = useState('')
      const [digOn, setDigOn] = useState(true)
      const [digTime, setDigTime] = useState('08:30')
      const [digNext, setDigNext] = useState(null)  // ms, from the host timer
      const [digOpen, setDigOpen] = useState(false) // half-hour preset list visible
      const [digActive, setDigActive] = useState(-1) // keyboard cursor inside that list

      useEffect(() => {
        if (!toast) return
        const id = setTimeout(() => { setToast(null); setCopied(null) }, 2000)
        return () => clearTimeout(id)
      }, [toast])

      const copyText = (text) => new Promise((resolve) => {
        const fallback = () => {
          try {
            if (!document.body) return resolve(false)
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            const ok = document.execCommand('copy')
            ta.remove()
            resolve(ok)
          } catch { resolve(false) }
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => resolve(true), fallback)
        } else fallback()
      })

      const copyQuestion = (name) => {
        const q = sampleQuestion(name)
        copyText(q).then((ok) => {
          setCopied(ok ? name : null)
          setToast({
            ok,
            title: ok ? t('tools.copiedTitle') : t('tools.copyFail'),
            body: ok ? t('tools.copiedBody') : q,
            n: Date.now(),
          })
        })
      }

      const copySnippet = () => {
        copyText(WEBHOOK_SNIPPET).then((ok) => {
          setToast({ ok, title: ok ? t('push.snippetCopied') : t('tools.copyFail'), body: ok ? '' : WEBHOOK_SNIPPET, n: Date.now() })
        })
      }

      const pageOrigin = () => {
        try { return (typeof location !== 'undefined' && location.origin) || 'unknown' } catch { return 'unknown' }
      }

      // "Failed to fetch" covers three different problems. Classify it so the
      // user knows which one they hit, and support gets one pasteable line:
      // https page = browser blocks http://127.0.0.1; a no-cors probe that
      // resolves = host is up but rejecting us; rejects = nothing listening.
      const diagnoseBridge = async () => {
        if (typeof location !== 'undefined' && location.protocol === 'https:') return t('push.diag.https', { o: pageOrigin() })
        try {
          await fetch(LOCAL_API + '/status', { mode: 'no-cors', cache: 'no-store' })
          return t('push.diag.cors', { o: pageOrigin() })
        } catch { return t('push.diag.down') }
      }

      // The host may still be activating when the panel mounts: retry briefly
      // instead of parking the push block in "bridge unavailable" forever.
      useEffect(() => {
        let cancelled = false
        let timer = null
        let attempt = 0
        const load = async () => {
          try {
            const res = await fetch(LOCAL_API + '/status', { headers: { Accept: 'application/json' } })
            if (!res.ok) throw new Error('http ' + res.status)
            const j = await res.json()
            if (cancelled) return
            setBridgeErr(''); setBridgeDiag(''); setHost(j); if (!j.configured) setEditing(true)
            // Effective digest settings (panel preference > config default), so
            // the switch reflects what the host will actually do.
            if (j.digestCfg) {
              setDigOn(!!j.digestCfg.enabled)
              setDigTime(j.digestCfg.time || '08:30')
              setDigNext(Number(j.digestCfg.nextRunAt) || null)
            }
          } catch (e) {
            if (cancelled) return
            if (attempt < 2) { attempt++; timer = setTimeout(load, attempt * 500); return }
            const diag = await diagnoseBridge()
            if (cancelled) return
            setBridgeErr(String(e?.message || e)); setBridgeDiag(diag); setHost(null)
          }
        }
        load()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [nonce, retry])

      const copyDiag = () => {
        const payload = `origin=${pageOrigin()}\nbridge=${LOCAL_API}/status\nfetch=${bridgeErr || 'n/a'}\ndiag=${bridgeDiag || 'n/a'}`
        copyText(payload).then((ok) => {
          setToast({ ok, title: ok ? t('push.diagCopied') : t('tools.copyFail'), body: ok ? '' : payload, n: Date.now() })
        })
      }

      const post = async (path, body) => {
        const res = await fetch(LOCAL_API + path, body === undefined
          ? { method: 'POST' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        return res.json()
      }

      const testPush = async () => {
        setBusy('test'); setResult(null)
        try {
          const j = await post('/test-push')
          setResult(j.ok
            ? { ok: true, message: t('push.testOk', { c: j.channel || '', n: j.chunks || 1 }) }
            : { ok: false, message: j.message || j.error || '', hint: j.hint || '' })
        } catch (e) { setResult({ ok: false, message: String(e?.message || e) }) }
        setBusy('')
      }

      // Save first, then test: a failure tells the user which step broke.
      const saveWebhook = async (thenTest) => {
        setBusy('save'); setResult(null)
        try {
          const j = await post('/webhook', form)
          if (!j.ok) { setResult({ ok: false, message: j.message || '' }); return }
          setHost((prev) => ({ ...(prev || {}), channel: j.channel, configured: j.configured, urlHost: j.urlHost, secretSet: j.secretSet }))
          setEditing(false)
          setForm({ channel: j.channel, url: '', secret: '' })
          resyncDigest()
          if (thenTest) { setBusy(''); return testPush() }
          setResult({ ok: true, message: t('push.saved') })
        } catch (e) { setResult({ ok: false, message: String(e?.message || e) }) }
        setBusy('')
      }

      // Digest preference lives in state.json too, so saving applies at once and
      // the host reschedules its timer without a restart.
      const saveDigest = async () => {
        setBusy('digest'); setResult(null)
        try {
          const j = await post('/digest', { enabled: digOn, time: normHm(digTime) })
          // Old host builds have no /digest route: say "restart DSH" instead of
          // echoing the bridge's bare "未知接口".
          if (!j.ok) { setResult({ ok: false, message: j.code === 'not-found' ? t('push.digest.stale') : (j.message || '') }); return }
          setDigOn(!!j.enabled); setDigTime(j.time); setDigNext(Number(j.nextRunAt) || null)
          setHost((prev) => (prev ? { ...prev, digestCfg: { ...(prev.digestCfg || {}), enabled: j.enabled, time: j.time, nextRunAt: j.nextRunAt || null } } : prev))
          setResult({ ok: true, message: j.enabled ? t('push.digest.saved', { t: j.time }) : t('push.digest.off') })
        } catch (e) { setResult({ ok: false, message: String(e?.message || e) }) }
        setBusy('')
      }

      // Only a real report proves the long, multi-chunk path works (/test-push
      // sends one short canned line). Never marks today as delivered.
      const testDigest = async () => {
        setBusy('digestTest'); setResult(null)
        try {
          const j = await post('/digest/test')
          setResult(j.ok
            ? { ok: true, message: t('push.digest.testOk', { d: j.date || '', n: j.chunks || 1 }) }
            : { ok: false, message: j.code === 'not-found' ? t('push.digest.stale') : (j.message || j.error || ''), hint: j.hint || '' })
        } catch (e) { setResult({ ok: false, message: String(e?.message || e) }) }
        setBusy('')
      }

      // The host derives the digest defaults from config and keeps its own run
      // state, so a webhook change can change what applies. Re-read that block
      // instead of guessing locally and showing a switch that lies.
      const resyncDigest = async () => {
        try {
          const res = await fetch(LOCAL_API + '/status', { headers: { Accept: 'application/json' } })
          if (!res.ok) return
          const j = await res.json()
          if (j.digestCfg) {
            setDigOn(!!j.digestCfg.enabled)
            setDigTime(j.digestCfg.time || '08:30')
            setDigNext(Number(j.digestCfg.nextRunAt) || null)
          }
          setHost((prev) => (prev ? { ...prev, digestCfg: j.digestCfg || prev.digestCfg, digest: j.digest || prev.digest } : prev))
        } catch { /* keep the local view; the next refresh fixes it */ }
      }

      // A panel left open across the scheduled time keeps showing a past "next
      // run"; coming back to the window re-reads just the digest block (no
      // polling, and it must not touch an in-progress webhook edit).
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
        const onVisible = () => { if (document.visibilityState === 'visible') resyncDigest() }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [])

      const openForm = () => {
        setForm({ channel: host?.channel && host.channel !== 'none' ? host.channel : 'wecom', url: '', secret: '' })
        setResult(null); setOffConfirm(false); setEditing(true)
      }

      // Turning push off is a deliberate two-step action, not a dropdown value:
      // "未配置" as a channel was confusing (it reads like a choice to make).
      const disablePush = async () => {
        if (!offConfirm) { setOffConfirm(true); return }
        setOffConfirm(false); setBusy('save'); setResult(null)
        try {
          const j = await post('/webhook', { channel: 'none' })
          if (!j.ok) { setResult({ ok: false, message: j.message || '' }); return }
          setHost((prev) => ({ ...(prev || {}), channel: 'none', configured: false, urlHost: '', secretSet: false }))
          setEditing(false)
          setResult({ ok: true, message: t('push.disabled') })
          resyncDigest()
        } catch (e) { setResult({ ok: false, message: String(e?.message || e) }) }
        setBusy('')
      }

      // The push block sits below the fold; the top banner scrolls to it.
      const scrollToPush = () => setTimeout(() => {
        try { document.getElementById('aihot-push')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch { /* noop */ }
      }, 60)

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

      const pushForm = () => h('div', { style: css.card },
        host?.configured ? null : h('div', { style: { ...css.metaDim, marginBottom: 10 } }, t('push.empty')),
        h('div', { style: css.field },
          h('label', { style: css.fieldLabel, htmlFor: 'aihot-chan' }, t('push.field.channel')),
          h('select', {
            id: 'aihot-chan', style: css.select, value: form.channel,
            onChange: (e) => setForm({ channel: e.target.value, url: '', secret: '' }),
          }, CHANNELS.map((c) => h('option', { key: c, value: c, style: css.option }, t('chan.' + c))))),
        form.channel === 'none' ? null : h('div', null,
          h('div', { style: css.field },
            h('label', { style: css.fieldLabel, htmlFor: 'aihot-url' }, form.channel === 'telegram' ? t('push.field.token') : t('push.field.url')),
            h('input', {
              id: 'aihot-url', style: css.input, value: form.url, spellCheck: false, autoComplete: 'off',
              placeholder: URL_HINT[form.channel] || '',
              onChange: (e) => {
                const url = e.target.value
                setForm({ ...form, url, channel: detectChannel(url) || form.channel })
              },
            })),
          (form.channel === 'dingtalk' || form.channel === 'telegram') ? h('div', { style: css.field },
            h('label', { style: css.fieldLabel, htmlFor: 'aihot-secret' }, t(form.channel === 'telegram' ? 'push.field.chat' : 'push.field.secret')),
            h('input', {
              id: 'aihot-secret', style: css.input, value: form.secret, spellCheck: false, autoComplete: 'off',
              onChange: (e) => setForm({ ...form, secret: e.target.value }),
            })) : null),
        // One action-order rule for the whole panel: exit/destructive first
        // (取消 → 关闭推送), then the conservative commit (仅保存), then the main
        // commit (保存并发送测试) last, at the right edge. Only committing actions
        // get btnPrimary, so order and visual weight stay two separate rules.
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          host?.configured ? h('button', {
            type: 'button', style: css.btn, disabled: !!busy,
            onClick: () => { setEditing(false); setOffConfirm(false); setResult(null) },
          }, t('push.cancel')) : null,
          host?.configured ? h('button', {
            type: 'button', disabled: !!busy,
            style: { ...css.btn, color: offConfirm ? T.error : T.sub, borderColor: offConfirm ? T.error : T.border },
            onClick: disablePush,
          }, offConfirm ? t('push.disableConfirm') : t('push.disable')) : null,
          h('button', { type: 'button', style: css.btn, disabled: !!busy, onClick: () => saveWebhook(false) }, t('push.save')),
          h('button', {
            type: 'button', disabled: !!busy,
            style: busy ? { ...css.btnPrimary, opacity: 0.6, cursor: 'not-allowed' } : css.btnPrimary,
            onClick: () => saveWebhook(true),
          }, busy === 'test' ? t('push.testing') : busy === 'save' ? t('push.saving') : t('push.saveTest'))))

      const pushSummary = () => h('div', { style: css.card },
        h('div', { style: css.row },
          h('span', { style: css.cardTitle }, h('span', { style: css.dot(host.configured ? T.success : T.warn) }), t('push.channel', { c: t('chan.' + host.channel) })),
          h('span', { style: css.badgeSoft(host.configured ? T.success : T.warn) }, host.configured ? t('push.on') : t('push.off'))),
        host.urlHost ? h('div', { style: css.metaDim }, t('push.current', { h: host.urlHost })) : null,
        h('div', { style: css.metaDim }, host.configured ? t('push.hint') : t('push.empty')),
        // Same rule as the form footer: 测试 (light, reversible) first, the
        // action that commits (修改 / 去配置) last, at the right edge.
        // 修改 is an outlined (not filled) button: it only opens the editor, so
        // it keeps the same frame as its neighbours without the filled body that
        // made it read like the card's main action. When nothing is configured
        // that slot says 保存 and leads into the form, so it stays filled.
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', disabled: !!busy || !host.configured, className: 'aihot-btn',
            style: busy || !host.configured ? { ...css.btn, opacity: 0.5, cursor: 'not-allowed' } : css.btn,
            onClick: testPush,
          }, busy === 'test' ? t('push.testing') : t('push.test')),
          h('button', {
            type: 'button', disabled: !!busy, className: 'aihot-btn',
            style: host.configured ? css.btnOutline : css.btn,
            onClick: openForm,
          }, host.configured ? t('push.edit') : t('push.save'))))

      const digHm = normHm(digTime) // '' while the typed text is not a valid time
      const digestDirty = () => {
        const d = host?.digestCfg || {}
        return digOn !== !!d.enabled || digHm !== (d.time || '08:30')
      }

      // Themed combobox: type any HH:MM, or pick one of the half-hour presets.
      // A <select> cannot take typed input, and input[type=time] opens an OS
      // dialog that ignores the theme (white/blue, as reported).
      // ARIA: real combobox pattern — the options are role="option" children of
      // a listbox (not buttons, which is invalid inside a listbox), the input
      // owns aria-activedescendant, and arrow keys/Enter work.
      const pick = (v) => { setDigTime(v); setDigOpen(false); setDigActive(-1) }
      const timePicker = () => h('div', { style: { position: 'relative', flex: 'none' } },
        h('input', {
          id: 'aihot-digest-time', value: digTime, placeholder: 'HH:MM', maxLength: 8,
          role: 'combobox', 'aria-label': t('push.digest.time'),
          'aria-expanded': digOpen, 'aria-controls': 'aihot-digest-list',
          'aria-autocomplete': 'list', 'aria-invalid': !digHm,
          'aria-activedescendant': digActive >= 0 ? 'aihot-digest-opt-' + digActive : undefined,
          spellCheck: false, autoComplete: 'off',
          // Never disabled: setting the time before switching the schedule on is
          // a legitimate order of operations.
          style: { ...css.input, width: 88, opacity: digOn ? 1 : 0.72, borderColor: digHm ? T.border : T.error },
          onChange: (e) => { setDigTime(e.target.value); setDigOpen(true); setDigActive(-1) },
          // Normalise on blur so "8:5" becomes "08:05"; the host needs HH:MM.
          onBlur: () => { setDigOpen(false); setDigActive(-1); const n = normHm(digTime); if (n) setDigTime(n) },
          onFocus: () => setDigOpen(true),
          onKeyDown: (e) => {
            if (e.key === 'Escape') { setDigOpen(false); setDigActive(-1); return }
            if (e.key === 'Enter') {
              if (digOpen && digActive >= 0) { e.preventDefault(); pick(DIGEST_PRESETS[digActive]) }
              else setDigOpen(false)
              return
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            setDigOpen(true)
            const step = e.key === 'ArrowDown' ? 1 : -1
            setDigActive((cur) => {
              const next = cur + step
              if (next < 0) return DIGEST_PRESETS.length - 1
              return next >= DIGEST_PRESETS.length ? 0 : next
            })
          },
        }),
        digOpen ? h('div', {
          id: 'aihot-digest-list', role: 'listbox', className: 'aihot-digest-menu', 'aria-label': t('push.digest.time'),
        }, DIGEST_PRESETS.map((v, i) => h('div', {
          key: v, id: 'aihot-digest-opt-' + i, role: 'option', 'aria-selected': v === digHm,
          // Styling lives in the injected sheet: 48 inline style objects per
          // render bought nothing the classes don't already do.
          className: 'aihot-digest-item'
            + (v === digHm ? ' aihot-digest-item-on' : '')
            + (i === digActive ? ' aihot-digest-item-active' : ''),
          // Keep focus in the input, otherwise blur closes the list before the
          // click lands and preset picks never fire.
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => pick(v),
        }, v))) : null)

      // The digest is saved on its own: changing the send time must not require
      // re-entering the webhook (and re-saving a webhook must not reset it).
      const digestCard = () => {
        const cfg = host.digestCfg || {}
        const tz = cfg.timezone || 'Asia/Shanghai'
        const run = host.digest || {}
        const saveOff = !!busy || !digHm || !digestDirty()
        return h('div', { style: { ...css.card, marginTop: 10 } },
          h('div', { style: css.row },
            h('span', { style: css.cardTitle }, t('push.digest.title')),
            // Same badge language as the channel card above (已配置/未配置),
            // driven by the draft switch so toggling gives instant feedback.
            host.digestCfg
              ? h('span', { style: css.badgeSoft(digOn ? T.success : T.warn) }, digOn ? t('push.digest.onBadge') : t('push.digest.offBadge'))
              : null),
          h('div', { style: css.metaDim }, t('push.digest.desc')),
          digNext ? h('div', { style: { ...css.metaDim, marginTop: 4 } }, t('push.digest.next', { t: fmtHm(digNext, tz), z: tzLabel(tz) })) : null,
          // The description no longer claims "off by default"; the off state is
          // stated here instead, only when it is actually true.
          digOn ? null : h('div', { style: { ...css.metaDim, marginTop: 4 } }, t('push.digest.off')),
          // No digestCfg in /status = the host is still running an older bridge.
          // Say so up front rather than letting the save fail with "未知接口".
          host.digestCfg ? null : h('div', { style: { ...css.metaDim, color: T.warn, marginTop: 6 } }, t('push.digest.stale')),
          host.configured ? null : h('div', { style: { ...css.metaDim, color: T.warn, marginTop: 4 } }, t('push.digest.needPush')),
          // A 3-times-failed digest is otherwise silent (log only).
          run.lastError
            ? h('div', { style: { ...css.metaDim, color: T.warn, marginTop: 6 } }, t('push.digest.lastFail', { d: run.retryDate || '—', e: run.lastError }))
            : run.lastDate ? h('div', { style: { ...css.metaDim, marginTop: 6 } }, t('push.digest.lastOk', { d: run.lastDate })) : null,
          host.digestCfg ? [
            h('div', { key: 'ctl', style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.sub, cursor: 'pointer' } },
                // accentColor makes the tick use the theme brand instead of the
                // browser's default blue.
                h('input', { id: 'aihot-digest-on', type: 'checkbox', style: { accentColor: T.brand, margin: 0, cursor: 'pointer' }, checked: digOn, onChange: (e) => setDigOn(e.target.checked) }),
                t('push.digest.on')),
              timePicker(),
              h('span', { key: 'tz', style: { ...css.metaDim, fontSize: 11.5 } }, tzLabel(tz))),
            // Actions live in their own row under the controls, 测试 first and
            // 保存 (the commit) last — the same order as the card above and the
            // form footer, so the panel has one action layout, not three.
            h('div', { key: 'act', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', {
                type: 'button', disabled: !!busy || !host.configured,
                style: (busy || !host.configured) ? { ...css.btn, opacity: 0.5, cursor: 'not-allowed' } : css.btn,
                onClick: testDigest,
              }, busy === 'digestTest' ? t('push.digest.testing') : t('push.digest.test')),
              h('button', {
                type: 'button', disabled: saveOff,
                style: saveOff ? { ...css.btnPrimary, opacity: 0.5, cursor: 'not-allowed' } : css.btnPrimary,
                onClick: saveDigest,
              }, busy === 'digest' ? t('push.saving') : t('push.digest.save'))),
            digHm ? null : h('div', { key: 'bad', style: { ...css.metaDim, color: T.error, marginTop: 6 } }, t('push.digest.badTime')),
          ] : null)
      }

      return h('div', null,
        failed.length ? h('div', { style: css.error }, t('err.partial', { p: failed.join('、') })) : null,
        // The push block sits below the fold; surface it here so a first run
        // does not stall on "there is nothing to see".
        host && !host.configured ? h('div', { style: css.banner, className: 'aihot-banner' },
          h('span', { style: css.bannerText }, t('push.banner')),
          h('button', { type: 'button', style: css.btn, onClick: () => { openForm(); scrollToPush() } }, t('push.bannerCta'))) : null,
        h('div', { style: css.strip }, PROVIDERS.map((p) => h(ProviderChip, { key: p.id, provider: p, resp: data[p.id] }))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.pending'), h('span', { style: css.count }, pending.length)),
          pending.length ? pending.map((x, i) => h(PendingCard, { key: 'p' + i, ...x })) : h('div', { style: css.empty }, loading ? t('empty.loading') : t('empty.pending'))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.recent'), h('span', { style: css.count }, recent.length)),
          recent.length ? h('div', { style: css.grid }, recent.slice(0, 10).map((x, i) => h(EventCard, { key: 'r' + i, ...x }))) : h('div', { style: css.empty }, loading ? t('empty.loading') : t('empty.recent'))),
        h('div', { style: css.section },
          h('div', { style: css.h2 }, t('sec.tools'), h('span', { style: css.count }, TOOLS.length)),
          h('div', { style: css.tools }, TOOLS.map(([name, key]) => h('button', { type: 'button', style: css.tool, className: 'aihot-tool' + (copied === name ? ' aihot-tool-copied' : ''), key: name, onClick: () => copyQuestion(name), title: sampleQuestion(name) }, h('span', { style: { ...css.toolDot, ...(copied === name ? { background: T.success, width: 7, height: 7 } : {}) } }), h('span', { style: css.code }, name), h('span', { style: css.toolDesc }, copied === name ? t('tools.copiedShort') : t(key))))),
          h('div', { style: { ...css.metaDim, marginTop: 10 } }, t('tools.hint'))),
        h('div', { id: 'aihot-push', style: css.section },
          h('div', { style: css.h2 }, t('sec.push')),
          !host ? h('div', { style: css.bridgeBox },
            h('div', { style: css.metaDim }, t('push.bridge')),
            // Keep the failure reason visible: it is what separates "https
            // blocked" from "host not running", and both need a different fix.
            h('div', { style: css.pathLine }, `GET ${LOCAL_API}/status${bridgeErr ? ' → ' + bridgeErr : ''}`),
            bridgeDiag ? h('div', { style: { ...css.metaDim, color: T.warn, marginTop: 4 } }, bridgeDiag) : null,
            h('div', { style: { ...css.metaDim, marginTop: 6 } }, t('push.bridgePath')),
            h('div', { style: css.pathLine }, '~/.dsh/aihot-radar/state.json'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: css.btn, onClick: () => setRetry((n) => n + 1) }, t('push.retry')),
              h('button', { type: 'button', style: css.btn, onClick: copySnippet }, t('push.snippet')),
              h('button', { type: 'button', style: css.btn, onClick: copyDiag }, t('push.copyDiag'))))
            : h('div', null,
              editing ? pushForm() : pushSummary(),
              digestCard(),
              result ? h('div', { style: { marginTop: 8 } },
                h('div', { style: { color: result.ok ? T.success : T.error, fontSize: 12 } }, result.message),
                result.hint ? h('div', { style: { ...css.metaDim, marginTop: 4 } }, result.hint) : null) : null)),
        h('div', { style: { ...css.metaDim, marginTop: -8, marginBottom: 8 } },
          ((apiCheckedAt ? t('status.checkedAt', { t: fmtTime(apiCheckedAt) }) : '') + (apiCheckedAt && updatedAt ? ' · ' : '') + (updatedAt ? t('status.refreshedAt', { t: updatedAt.toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) }) : '')) + (apiCheckedAt || updatedAt ? t('status.tz') : '')),
        h('div', { style: { ...css.metaDim, marginBottom: 16 } }, t('status.askAgent')),
        // Floating toast: fixed positioning keeps it out of the panel's layout
        // flow, then it fades out after 2s.
        toast ? h('div', {
          className: 'aihot-toast ' + (toast.ok ? 'aihot-toast-ok' : 'aihot-toast-err'),
          role: 'status',
          'aria-live': 'polite',
          style: toastAnchor(),
        },
        h('span', { className: 'aihot-toast-icon' }, toast.ok ? '✓' : '!'),
        h('span', { className: 'aihot-toast-body' },
          h('span', { className: 'aihot-toast-title' }, toast.title),
          toast.body ? h('span', { className: 'aihot-toast-sub' }, toast.body) : null)) : null)
    }

    function RadarPanel() {
      LANG = useActiveLang()
      const [tab, setTab] = useState('radar')
      const [nonce, setNonce] = useState(0)
      const [monitor, setMonitor] = useState('unknown')

      useEffect(() => {
        const sheet = `
          @keyframes aihot-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,199,89,0.5); } 70% { box-shadow: 0 0 0 6px rgba(52,199,89,0); } 100% { box-shadow: 0 0 0 0 rgba(52,199,89,0); } }
          @media (prefers-reduced-motion: reduce) { .aihot-pulse { animation: none !important; } .aihot-toast { animation: none !important; } }
          .aihot-radar-panel::-webkit-scrollbar { width: 8px; }
          .aihot-radar-panel::-webkit-scrollbar-track { background: transparent; }
          .aihot-radar-panel::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 8px; }
          .aihot-radar-panel::-webkit-scrollbar-thumb:hover { background: ${T.tertiary}; }
          .aihot-card:hover { border-color: ${T.border}; background: ${T.layer2}; }
          .aihot-btn:hover { border-color: ${T.brand}; color: ${T.text}; background: ${T.hover}; }
          .aihot-tool:hover { border-color: ${T.border}; background: ${T.layer2}; }
          .aihot-link:hover { opacity: 0.75; }
          .aihot-tab:hover { color: ${T.sub}; background: ${T.hover}; }
          .aihot-tool:active { transform: scale(0.98); }
          .aihot-tool-copied { border-color: ${T.success}; background: ${T.layer2}; }
          .aihot-digest-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; width: 88px; max-height: 172px; overflow-y: auto; padding: 4px; border-radius: 8px; border: 1px solid ${T.border}; background: ${T.layer1}; box-shadow: 0 10px 24px rgba(0,0,0,0.35); }
          .aihot-digest-item { display: block; width: 100%; text-align: left; padding: 5px 8px; margin: 0; border: 0; border-radius: 6px; background: transparent; color: ${T.sub}; font: inherit; font-size: 12px; cursor: pointer; }
          .aihot-digest-item:hover { background: ${T.hover}; color: ${T.text}; }
          .aihot-digest-item-on, .aihot-digest-item-on:hover { color: ${T.brand}; font-weight: 600; }
          .aihot-digest-item-active { background: ${T.hover}; color: ${T.text}; }
          .aihot-digest-menu::-webkit-scrollbar { width: 8px; }
          .aihot-digest-menu::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 8px; }
          .aihot-toast { position: fixed; z-index: 999; pointer-events: none; display: flex; align-items: flex-start; gap: 8px; box-sizing: border-box; max-width: 80vw; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; transform: translateX(-50%); animation: aihot-toast-in .2s ease; }
          /* Alpha tints + theme label tokens, so both light and dark themes stay readable. */
          .aihot-toast-ok { background: rgba(52,199,89,0.16); border: 1px solid rgba(52,199,89,0.65); color: ${T.text}; box-shadow: 0 8px 22px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.10); }
          .aihot-toast-err { background: rgba(255,77,79,0.14); border: 1px solid rgba(255,77,79,0.65); color: ${T.text}; box-shadow: 0 8px 22px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.10); }
          .aihot-toast-icon { width: 18px; height: 18px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #0e0e11; background: ${T.success}; margin-top: 1px; }
          .aihot-toast-err .aihot-toast-icon { background: ${T.error}; color: #fff; }
          .aihot-toast-body { min-width: 0; }
          .aihot-toast-title { font-weight: 650; font-size: 12.5px; }
          .aihot-toast-sub { font-size: 12.5px; color: ${T.sub}; word-break: break-word; }
          @keyframes aihot-toast-in { from { opacity: 0; transform: translate(-50%, 8px) scale(0.98); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
        `
        let el = document.getElementById('aihot-radar-style')
        if (!el) {
          el = document.createElement('style')
          el.id = 'aihot-radar-style'
          document.head.appendChild(el)
        }
        // Always resync: a plugin hot-reload reuses the previous <style> node,
        // and a stale sheet would leave new classes (e.g. .aihot-toast) unstyled.
        if (el.textContent !== sheet) el.textContent = sheet
      }, [])

      return h('div', { style: css.panel, className: 'aihot-radar-panel' },
        h('div', { style: css.head },
          h('div', { style: css.titleWrap },
            h('div', { style: css.iconBadge }, h(RadarIcon, { size: 21, scale: 1.2 })),
            h('div', null,
              h('div', { style: css.h1 }, t('meta.title'), h('span', { className: 'aihot-pulse', style: { ...css.live, background: monitorColor(monitor) }, title: monitorTitle(monitor), 'aria-hidden': true })),
              h('div', { style: css.sub }, t('sub')))),
          h('button', { type: 'button', style: css.btn, className: 'aihot-btn', onClick: () => setNonce((n) => n + 1) }, t('refresh'))),

        h('div', { style: css.tabs, role: 'tablist' },
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'radar', style: { ...css.tab, ...(tab === 'radar' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('radar') }, h(RadarIcon, { size: 18, scale: 1.2 }), t('tab.radar')),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'daily', style: { ...css.tab, ...(tab === 'daily' ? css.tabActive : {}) }, className: 'aihot-tab', onClick: () => setTab('daily') }, '📰', t('tab.daily'))),

        tab === 'radar' ? h(RadarContent, { nonce, onMonitor: setMonitor }) : h(DailyReport, { nonce }),

        h('div', { style: css.foot },
          t('foot.source'), h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: BASE, target: '_blank', rel: 'noreferrer' }, 'AIHOT', h('span', null, '↗')),
          h('a', { style: { ...css.link, marginTop: 0 }, className: 'aihot-link', href: REPO + '/issues', target: '_blank', rel: 'noreferrer' }, t('foot.feedback'), h('span', null, '↗')),
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