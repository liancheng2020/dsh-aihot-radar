// Self-test for dsh-aihot-radar. No test framework — plain node:assert + a local
// fake webhook server. Run: node scripts/selftest.mjs  (Git Bash / PowerShell)
// Covers A1 (chunking + errcode), A3 (radar cap/dedup), A5 (addDays timezone),
// B1 (digest.time validation).

import assert from 'node:assert'
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createNotifier, chunkContent, formatResetMessage, formatInferredMessage, withSignature, signatureEnabled, effectiveNotify, toPlainText, toFeishuCard } from '../lib/notify.js'
import { scanProvider } from '../lib/radar.js'
import { createApi, PROVIDERS } from '../lib/api.js'
import { effectiveDigest, renderReportText, assertReportDate, runDigest } from '../lib/digest.js'
import { validateTime, msUntilNext, isQuietNow, tzParts, resolveTz } from '../lib/time.js'
import { startLocalApi } from '../lib/localapi.js'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0, failed = 0
const test = (name, fn) => { try { fn(); console.log('PASS  ' + name); passed++ } catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ } }
// A hung socket must not stall the whole run: race every async case with a timer.
const atest = async (name, fn) => {
  let timer
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout 5s')), 5000) })
  try { await Promise.race([fn(), guard]); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ }
  finally { clearTimeout(timer) }
}
// Node 18's server.close() waits for idle keep-alive sockets, so a fetch-based
// fake server stalls until undici's 5s idle timeout (Node >=19 closes them for
// us). Drop the idle sockets explicitly, otherwise these cases look "hung".
const shutdown = (srv) => new Promise((r) => {
  srv.closeIdleConnections?.(); srv.closeAllConnections?.(); srv.close(r)
})

// ---- A5: addDays must be timezone-independent (extracted from client.js) ----
const src = readFileSync(join(here, '../client.js'), 'utf8')
const fnSrc = src.match(/function addDays\(dateStr, n\) \{[\s\S]*?\n    \}/)[0]
const addDays = new Function('dateStr', 'n', fnSrc.replace(/^function addDays\(dateStr, n\) \{/, '').replace(/\}$/, ''))
test('A5 addDays(-1) UTC-safe', () => assert.equal(addDays('2026-11-12', -1), '2026-11-11'))
test('A5 addDays(+1) UTC-safe', () => assert.equal(addDays('2026-11-12', 1), '2026-11-13'))
test('A5 addDays month boundary', () => assert.equal(addDays('2026-12-01', -1), '2026-11-30'))
test('A5 addDays year boundary', () => assert.equal(addDays('2027-01-01', -1), '2026-12-31'))

// ---- B1: digest.time validation ----
test('B1 99:99 falls back to 08:30', () => assert.equal(validateTime('99:99'), '08:30'))
test('B1 24:00 falls back to 08:30', () => assert.equal(validateTime('24:00'), '08:30'))
test('B1 23:59 valid', () => assert.equal(validateTime('23:59'), '23:59'))
test('B1 08:30 valid', () => assert.equal(validateTime('08:30'), '08:30'))
test('B1 msUntilNext(99:99) within 24h', () => { const ms = msUntilNext('99:99'); assert.ok(ms > 0 && ms <= 86400000) })

// ---- A3: radar per-cycle cap defers overflow; seen trimmed to snapshot ----
await atest('A3 7 announced -> round1 5/seen5, round2 2/seen7', async () => {
  const mk = (id) => ({ id, status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'announced' }, posts: [] })
  const notifier = { send: async () => ({ ok: true, chunks: 1 }) }
  const state = { seen: {}, webhook: { channel: 'generic', url: 'x' }, lastCheck: {} }
  const api = { resetsRecent: async () => ({ events: Array.from({ length: 7 }, (_, i) => mk('e' + i)) }) }
  let r = await scanProvider(api, 'codex', state, notifier)
  assert.equal(r.notified.length, 5); assert.equal(state.seen.codex.length, 5)
  r = await scanProvider(api, 'codex', state, notifier)
  assert.equal(r.notified.length, 2); assert.equal(state.seen.codex.length, 7)
})
await atest('A3b an expired announcement is history, not pending', async () => {
  const mk = (id, ps) => ({ id, status: 'announced', displayLabel: 'x', title: 't', presentation: { status: ps }, posts: [] })
  const notifier = { send: async () => ({ ok: true, chunks: 1 }) }
  const state = { seen: {}, webhook: { channel: 'generic', url: 'x' }, lastCheck: {} }
  const api = { resetsRecent: async () => ({ events: [mk('open1', 'announced'), mk('old1', 'likely_completed')] }) }
  const r = await scanProvider(api, 'codex', state, notifier)
  assert.equal(r.pending.length, 1, 'only the open announcement is pending')
  assert.equal(r.pending[0].id, 'open1')
  assert.equal(r.events.length, 2, 'history still carries both events')
})
await atest('A3 first run only announced; confirmed baselined', async () => {
  const mk = (id, status) => ({ id, status, displayLabel: 'x', title: 't', presentation: { status }, posts: [] })
  const sent = []
  const notifier = { send: async (c, t) => { sent.push(t); return { ok: true, chunks: 1 } } }
  const state = { seen: {}, webhook: { channel: 'generic', url: 'x' }, lastCheck: {} }
  const api = { resetsRecent: async () => ({ events: [mk('c1', 'confirmed'), mk('a1', 'announced')] }) }
  let r = await scanProvider(api, 'claude', state, notifier)
  assert.equal(r.notified.length, 1)
  r = await scanProvider(api, 'claude', state, notifier)
  assert.equal(r.notified.length, 0)
})

// ---- A1: wecom chunking <= 4096 bytes, content complete ----
await atest('A1 wecom 8000B -> >=2 chunks each <=4096B, complete', async () => {
  const received = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' })) })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + srv.address().port
  const n = createNotifier()
  const text = ('中文测试内容ABCDEF\n'.repeat(600)).slice(0, 8000)
  const r = await n.send({ channel: 'wecom', url }, '标题', text)
  assert.ok(r.chunks >= 2, 'chunks>=2'); assert.ok(received.length >= 2, 'POST>=2')
  for (const x of received) assert.ok(Buffer.byteLength(x.markdown.content, 'utf8') <= 4096, 'each <=4096B')
  const recon = received.map((x) => x.markdown.content.split('\n').slice(1).join('\n')).join('\n')
  assert.equal(recon, text, 'content complete')
  await shutdown(srv)
})
await atest('A1 HTTP200 + errcode93000 -> ok:false', async () => {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' })) })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const n = createNotifier()
  const r = await n.send({ channel: 'wecom', url: 'http://127.0.0.1:' + srv.address().port }, 't', 'short')
  assert.equal(r.ok, false); assert.ok(/invalid webhook/.test(r.error))
  await shutdown(srv)
})
test('A1 telegram char chunks <=3800', () => {
  const c = chunkContent('a'.repeat(9000), 3800, 'chars')
  assert.ok(c.length >= 3); assert.ok(c.every((x) => x.length <= 3800))
})
test('A1 chunkContent preserves UTF-8 (no garbled split)', () => {
  const text = '中'.repeat(2000)
  const c = chunkContent(text, 3900, 'bytes')
  assert.equal(c.join(''), text)
  assert.ok(c.every((x) => Buffer.byteLength(x, 'utf8') <= 3900))
})

// ---- A2: channels that render no markdown must not show the syntax ----
test('A2 toPlainText flattens heading/bold/link', () => {
  const out = toPlainText('### Codex 额度重置（预告）\n**粗体**\n- 时间：11-13\n数据来源：[AIHOT](https://aihot.news)')
  assert.equal(out, 'Codex 额度重置（预告）\n粗体\n- 时间：11-13\n数据来源：AIHOT https://aihot.news')
})

await atest('A2 feishu sends a card; telegram flattened; wecom keeps markdown', async () => {
  const sent = []
  const fetchImpl = async (url, opt) => {
    sent.push({ url, body: JSON.parse(opt.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, code: 0, ok: true }) }
  }
  const n = createNotifier({ fetchImpl })
  const md = '### 标题\n数据来源：[AIHOT](https://aihot.news)\n\nvia ACME 值班群'
  const plain = '### 标题\n数据来源：[AIHOT](https://aihot.news)'
  await n.send({ channel: 'feishu', url: 'https://open.feishu.cn/x' }, 'Codex 额度重置（预告）', md)
  await n.send({ channel: 'telegram', url: '123:abc', secret: '42' }, '标题', plain)
  await n.send({ channel: 'wecom', url: 'https://qyapi.weixin.qq.com/x' }, '标题', plain)
  const [feishu, telegram, wecom] = sent

  const card = feishu.body.card
  assert.equal(feishu.body.msg_type, 'interactive')
  assert.equal(card.header.template, 'orange')
  assert.equal(card.header.title.content, 'Codex 额度重置（预告）')
  const div = card.elements.find((e) => e.tag === 'div')
  assert.ok(!div.text.content.includes('###'), 'headings become bold, not "###"')
  assert.ok(div.text.content.includes('**标题**'))
  assert.ok(div.text.content.includes('[AIHOT](https://aihot.news)'), 'card keeps inline markdown links')
  assert.ok(div.text.content.includes('via ACME 值班群'), 'a custom footer stays part of the body')
  assert.equal(card.elements.length, 1, 'no note element: with no built-in footer there is nothing to lift out')

  assert.ok(!telegram.body.text.includes('###') && telegram.body.text.includes('AIHOT https://aihot.news'), 'telegram is plain')
  assert.ok(wecom.body.markdown.content.includes('**标题**'), 'wecom keeps markdown')

  // The text is the user's own now, so its link is not stripped the way the
  // removed built-in install line was.
  assert.ok(toPlainText('正文\n\nvia ACME [群公告](https://example.com/x)')
    .endsWith('via ACME 群公告 https://example.com/x'), 'a custom footer keeps its link')
  assert.ok(toPlainText('数据来源：[AIHOT](https://aihot.news)').includes('AIHOT https://aihot.news'),
    'body links keep their target in plain text')
})

test('A2 card colour follows the event state', () => {
  assert.equal(toFeishuCard('X 额度重置（AIHOT 推断）', 'a').header.template, 'grey')
  assert.equal(toFeishuCard('X 额度重置（已到账）', 'a').header.template, 'green')
  assert.equal(toFeishuCard('X 额度重置（预告）', 'a').header.template, 'orange')
  assert.equal(toFeishuCard('AIHOT 日报 · 2026-11-16', 'a').header.template, 'blue')
})

await atest('A2b feishu card rejected -> retried exactly once as text', async () => {
  const bodies = []
  const fetchImpl = async (url, opt) => {
    const b = JSON.parse(opt.body)
    bodies.push(b)
    const isCard = b.msg_type === 'interactive'
    return {
      ok: !isCard, status: isCard ? 400 : 200,
      text: async () => JSON.stringify(isCard ? { code: 19002, msg: 'invalid card' } : { code: 0 }),
    }
  }
  const n = createNotifier({ fetchImpl })
  const r = await n.send({ channel: 'feishu', url: 'https://open.feishu.cn/x' }, '标题', '正文')
  assert.equal(bodies.length, 2, 'one card attempt + one text retry, never more')
  assert.equal(bodies[0].msg_type, 'interactive')
  assert.equal(bodies[1].msg_type, 'text')
  assert.equal(r.ok, true, 'text fallback recovers the message')
})

// ---- Q: quiet hours (overnight wrap) + per-provider mute + defer ----
test('Q1 quiet overnight 23:00-08:00 active at 00:30, inactive at 12:00', () => {
  const q = { start: '23:00', end: '08:00' }
  assert.equal(isQuietNow(q, new Date('2026-11-13T00:30:00+08:00')), true)
  assert.equal(isQuietNow(q, new Date('2026-11-13T12:00:00+08:00')), false)
  assert.equal(isQuietNow({ start: '', end: '' }, new Date()), false)
})
await atest('Q2 muted provider suppresses + marks seen', async () => {
  const mk = (id) => ({ id, status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'announced' }, posts: [] })
  const notifier = { send: async () => ({ ok: true, chunks: 1 }) }
  const state = { seen: {}, webhook: { channel: 'generic', url: 'x' }, lastCheck: {} }
  const api = { resetsRecent: async () => ({ events: [mk('m1')] }) }
  const r = await scanProvider(api, 'codex', state, notifier, { muted: true })
  assert.equal(r.notified.length, 0)
  assert.ok(state.seen.codex.includes('m1:announced'))
})
await atest('Q3 quiet defers (unseen) then pushes after window', async () => {
  const mk = (id) => ({ id, status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'announced' }, posts: [] })
  const notifier = { send: async () => ({ ok: true, chunks: 1 }) }
  const state = { seen: {}, webhook: { channel: 'generic', url: 'x' }, lastCheck: {} }
  const api = { resetsRecent: async () => ({ events: [mk('q1')] }) }
  let r = await scanProvider(api, 'codex', state, notifier, { quiet: true })
  assert.equal(r.notified.length, 0)
  assert.ok(!state.seen.codex.includes('q1:announced'), 'left unseen during quiet')
  r = await scanProvider(api, 'codex', state, notifier, { quiet: false })
  assert.equal(r.notified.length, 1)
})

// ---- S: no built-in footer; only the user's own line, brand stays in title ----
const INSTALL_LINK = /github\.com\/liancheng2020|安装：github:|via AIHOT/
test('S1 no footer and no install link unless the user wrote one', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'announced' } }
  const { title, text } = formatResetMessage('codex', ev)
  assert.ok(!INSTALL_LINK.test(text), 'default config must not append the promo line')
  assert.ok(title.startsWith('AIHOT 雷达 · '), 'the brand must still identify the card: ' + title)
})
test('S2 signature:true alone no longer appends the removed built-in line', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'announced' } }
  const inferredEv = { status: 'announced', title: 't', presentation: { status: 'likely_completed' } }
  for (const notify of [{ signature: true }, { signature: true, signatureText: '   ' }]) {
    assert.equal(signatureEnabled(notify), false)
    assert.ok(!INSTALL_LINK.test(formatResetMessage('codex', ev, notify).text))
    const inferred = formatInferredMessage('claude', inferredEv, notify)
    assert.ok(!INSTALL_LINK.test(inferred.text))
    assert.ok(inferred.title.startsWith('AIHOT 雷达 · '), 'the title still carries the brand')
  }
})
test('S2b a stale panel record (state.notify.signature = true) adds nothing', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'announced' } }
  const legacy = effectiveNotify({}, { notify: { signature: true } })
  assert.equal(signatureEnabled(legacy), false, 'the old checkbox meant "install link", which is gone')
  assert.ok(!INSTALL_LINK.test(formatResetMessage('codex', ev, legacy).text))
  // …and it must not resurrect the line next to a profile that never set one.
  assert.equal(withSignature('body', effectiveNotify(undefined, { notify: { signature: true } })), 'body')
})
test('S2c a stored true cannot override an explicit signature: false', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'announced' } }
  // The profile says "never append", with a line configured but switched off; the
  // stale record says "add the install link". The profile is the current answer.
  const merged = effectiveNotify({ signature: false, signatureText: 'via ACME' }, { notify: { signature: true } })
  assert.equal(merged.signature, false, 'a stored true must be ignored, not merged in')
  assert.equal(signatureEnabled(merged), false)
  assert.equal(withSignature('body', merged), 'body')
  assert.ok(!formatResetMessage('codex', ev, merged).text.includes('via ACME'))

  // Same config, no stored value: false keeps working.
  assert.equal(withSignature('body', effectiveNotify({ signature: false, signatureText: 'via ACME' }, { notify: { signature: null } })), 'body')
  // A stored true next to an enabled profile line is a no-op, not a veto.
  assert.equal(withSignature('body', effectiveNotify({ signatureText: 'via ACME' }, { notify: { signature: true } })), 'body\n\nvia ACME')
})

test('S3 signatureText alone enables, signature:false wins over it', () => {
  assert.equal(withSignature('body', { signatureText: 'via ACME' }), 'body\n\nvia ACME')
  assert.equal(withSignature('body', { signatureText: 'via ACME', signature: false }), 'body')
  assert.equal(withSignature('body', { signatureText: '   ' }), 'body')
  assert.equal(withSignature('body', { signature: true, signatureText: '   ' }), 'body')
  assert.equal(withSignature('body'), 'body')
  assert.equal(withSignature('body', {}), 'body')
})
test('S4 signatureEnabled reports what the sender really does', () => {
  assert.equal(signatureEnabled(undefined), false)
  assert.equal(signatureEnabled({}), false)
  assert.equal(signatureEnabled({ signature: false }), false)
  assert.equal(signatureEnabled({ signature: true }), false, 'no built-in line to turn on')
  assert.equal(signatureEnabled({ signatureText: 'x' }), true)
  assert.equal(signatureEnabled({ signatureText: 'x', signature: false }), false)
})

// ---- TZ: configurable digest timezone ----
test('TZ1 tzParts respects zone (UTC vs Shanghai date)', () => {
  const now = new Date('2026-11-13T01:00:00Z') // Shanghai 09:00 same day; UTC 01:00
  assert.equal(tzParts(now, 'Asia/Shanghai').hour, 9)
  assert.equal(tzParts(now, 'UTC').hour, 1)
})
test('TZ2 resolveTz invalid falls back to Asia/Shanghai', () => {
  assert.equal(resolveTz('Not/Zone'), 'Asia/Shanghai')
  assert.equal(resolveTz('UTC'), 'UTC')
})
test('TZ3 msUntilNext within 24h for UTC', () => {
  const ms = msUntilNext('08:30', new Date('2026-11-13T01:00:00Z'), 'UTC')
  assert.ok(ms > 0 && ms <= 86400000)
})

// ---- L: loopback bridge /status + /test-push (no secret leakage) ----
await atest('L1 bridge status configured + test-push reaches webhook', async () => {
  const received = []
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ errcode: 0 })) })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const state = { webhook: { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: 's3cret' }, lastResult: {}, lastCheck: {}, digest: {} }
  const stop = startLocalApi({ port: 17421, state, notifier: createNotifier(), config: { radar: {}, digest: {} } })
  await new Promise((r) => setTimeout(r, 100))
  const st = await (await fetch('http://127.0.0.1:17421/status')).json()
  assert.equal(st.channel, 'wecom'); assert.equal(st.configured, true)
  assert.ok(!JSON.stringify(st).includes('s3cret'), 'no secret leakage')
  const tp = await (await fetch('http://127.0.0.1:17421/test-push', { method: 'POST' })).json()
  assert.equal(tp.ok, true); assert.ok(received.length >= 1, 'webhook received test push')
  const testBody = JSON.stringify(received[0])
  assert.ok(testBody.includes('AIHOT 雷达 · 测试推送'), 'test push keeps the brand in the title')
  assert.ok(testBody.includes('仅代表'), 'and says what success does (not) promise')
  assert.ok(!testBody.includes('via AIHOT'), 'no footer unless the user opted in')
  stop(); await shutdown(hook)
})

// ---- L2..L4: webhook writes (validation, persistence, cross-site denial) ----
const wait = () => new Promise((r) => setTimeout(r, 100))
const bridge = (port, state, extra = {}) =>
  startLocalApi({ port, state, notifier: createNotifier(), config: { radar: {}, digest: {} }, ...extra })

await atest('L2 bridge saves webhook and status reflects it without restart', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' } }
  let saved = 0
  const stop = bridge(17422, state, { save: () => { saved++; return true } })
  await wait()
  const j = await (await fetch('http://127.0.0.1:17422/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'bark', url: 'https://api.day.app/k', secret: 'ignored' }),
  })).json()
  assert.equal(j.ok, true); assert.equal(j.configured, true); assert.equal(j.urlHost, 'api.day.app')
  assert.equal(state.webhook.channel, 'bark'); assert.equal(state.webhook.secret, '')
  const st = await (await fetch('http://127.0.0.1:17422/status')).json()
  assert.equal(st.configured, true); assert.equal(st.secretSet, false); assert.equal(saved, 1)
  stop()
})

await atest('L3 bridge rejects bad channel/url and keeps the old config', async () => {
  const state = { webhook: { channel: 'wecom', url: 'https://qyapi.weixin.qq.com/x', secret: '' } }
  const stop = bridge(17423, state)
  await wait()
  const post = (b) => fetch('http://127.0.0.1:17423/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json())
  assert.equal((await post({ channel: 'nope', url: 'https://x.y' })).code, 'bad-channel')
  assert.equal((await post({ channel: 'feishu', url: 'ftp://x.y' })).code, 'bad-url')
  assert.equal((await post({ channel: 'telegram', url: '123456789:AAbbccdd' })).code, 'bad-secret')
  assert.equal(state.webhook.channel, 'wecom'); assert.equal(state.webhook.url, 'https://qyapi.weixin.qq.com/x')
  stop()
})

await atest('L4 bridge rejects cross-site writes (no repointing, no push spam)', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' } }
  const stop = bridge(17424, state)
  await wait()
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 17424, path: '/webhook', method: 'POST', headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject); req.end('{"channel":"generic","url":"https://evil.example/h"}')
  })
  assert.equal(await raw({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }), 403)
  assert.equal(await raw({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }), 403)
  assert.equal(state.webhook.channel, 'none')
  stop()
})

// Regression: the host shell (dsh-app://app) always looks cross-site when it
// calls 127.0.0.1, so the Sec-Fetch-Site rule must not block it.
await atest('L6 bridge accepts the app shell origin', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' } }
  const stop = bridge(17426, state)
  try {
    await wait()
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: 17426, path: '/webhook', method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'dsh-app://app', 'Sec-Fetch-Site': 'cross-site' },
      }, (r) => { const acao = r.headers['access-control-allow-origin']; r.resume(); r.on('end', () => resolve({ status: r.statusCode, acao })) })
      req.on('error', reject)
      req.end('{"channel":"feishu","url":"https://open.feishu.cn/open-apis/bot/v2/hook/x"}')
    })
    assert.equal(res.status, 200, 'shell origin must be accepted')
    assert.equal(res.acao, '*')
    assert.equal(state.webhook.channel, 'feishu')
  } finally { stop() }
})

await atest('L5 test-push failure carries an actionable hint', async () => {
  const hook = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' })) })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const state = { webhook: { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: '' } }
  const stop = bridge(17425, state)
  try {
    await wait()
    const j = await (await fetch('http://127.0.0.1:17425/test-push', { method: 'POST' })).json()
    assert.equal(j.ok, false)
    assert.equal(j.code, 93000, 'business code survives the response')
    assert.ok(String(j.hint).includes('Webhook'), 'hint explains the next step: ' + j.hint)
  } finally {
    // Close even when an assertion throws, or the listeners keep node alive.
    stop(); await shutdown(hook)
  }
})

// ---- L7..L10: digest schedule (panel prefs) + manual digest push ----
const postJson = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

await atest('L7 bridge saves digest pref and status reflects it', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' }, digestPref: { enabled: null, time: null }, digest: {} }
  let saved = 0, rescheduled = 0
  const stop = bridge(17427, state, {
    save: () => { saved++; return true },
    digestCtl: () => ({ reschedule: () => { rescheduled++ }, nextRunAt: () => 1700000000000 }),
  })
  try {
    await wait()
    const j = await postJson(17427, '/digest', { enabled: true, time: '07:15' })
    assert.equal(j.ok, true); assert.equal(j.enabled, true); assert.equal(j.time, '07:15')
    assert.equal(j.nextRunAt, 1700000000000, 'next run comes from the host timer')
    assert.equal(state.digestPref.enabled, true); assert.equal(state.digestPref.time, '07:15')
    assert.equal(saved, 1, 'persisted once')
    assert.equal(rescheduled, 1, 'timer rescheduled without a restart')
    const st = await (await fetch('http://127.0.0.1:17427/status')).json()
    assert.equal(st.digestCfg.enabled, true); assert.equal(st.digestCfg.time, '07:15')
  } finally { stop() }
})

await atest('L8 bridge rejects a bad digest time / wrong content-type', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' }, digestPref: { enabled: null, time: null } }
  const stop = bridge(17428, state)
  try {
    await wait()
    const bad = await postJson(17428, '/digest', { enabled: true, time: '9:99' })
    assert.equal(bad.code, 'bad-time')
    assert.equal(state.digestPref.enabled, null, 'rejected write leaves the pref untouched')
    const badType = await postJson(17428, '/digest', { enabled: 'true' })
    assert.equal(badType.code, 'bad-enabled', 'a string "true" must not be coerced')
    const ct = await fetch('http://127.0.0.1:17428/digest', { method: 'POST', body: 'x' })
    assert.equal(ct.status, 415)
    // Partial updates keep what was not sent.
    await postJson(17428, '/digest', { enabled: true, time: '06:45' })
    await postJson(17428, '/digest', { time: '07:00' })
    assert.equal(state.digestPref.enabled, true, 'time-only update keeps the switch')
    assert.equal(state.digestPref.time, '07:00')
  } finally { stop() }
})

test('L9 effectiveDigest: panel pref wins, config decides otherwise', () => {
  const hook = { channel: 'wecom', url: 'https://x' }
  // A configured webhook must NOT switch the digest on by itself (upgrade safety).
  assert.equal(effectiveDigest({ webhook: hook, digestPref: {} }, { digest: { enabled: false } }).enabled, false)
  assert.equal(effectiveDigest({ digestPref: { enabled: true } }, { digest: { enabled: false } }).enabled, true)
  assert.equal(effectiveDigest({ digestPref: { enabled: false } }, { digest: { enabled: true } }).enabled, false)
  assert.equal(effectiveDigest({ digestPref: { time: '09:05' } }, { digest: { time: '08:30' } }).time, '09:05')
})

await atest('L10 manual digest push sends the report and never marks today done', async () => {
  const received = []
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c)
    req.on('end', () => { received.push(b); res.setHeader('Content-Type', 'application/json'); res.end('{"errcode":0}') })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  const state = { webhook: { channel: 'wecom', url: 'http://127.0.0.1:' + hook.address().port, secret: '' }, digestPref: {}, digest: { lastDate: null } }
  const api = { dailyJson: async () => ({ report: { date: '2026-11-16', lead: { title: 'T' }, sections: [{ label: 'S', items: [{ title: 'I' }] }] } }) }
  const stop = bridge(17429, state, { api })
  try {
    await wait()
    const j = await postJson(17429, '/digest/test', {})
    assert.equal(j.ok, true); assert.equal(j.date, '2026-11-16')
    assert.ok(received.length >= 1, 'webhook received the digest')
    assert.equal(state.digest.lastDate, null, 'a manual test must not swallow the real 08:30 push')
  } finally {
    stop(); await shutdown(hook)
  }
})

// ---- N: delivery bookkeeping — a failed push must not vanish, a timed-out one
// ---- must not be re-sent, and HTTP 200 alone must never count as delivered ----
const mkEvent = (id, status = 'announced') => ({
  id, status, displayLabel: 'x', title: 't', presentation: { status }, posts: [],
})
const notiState = () => ({ seen: {}, webhook: { channel: 'wecom', url: 'https://x' }, lastCheck: {}, delivery: {} })

await atest('N1 definite failure stays unseen and retries on the next cycle', async () => {
  const state = notiState()
  const api = { resetsRecent: async () => ({ events: [mkEvent('e1')] }) }
  let calls = 0
  const notifier = {
    send: async () => {
      calls++
      return calls === 1
        ? { ok: false, status: 500, code: 500, retryable: true, error: 'HTTP 500' }
        : { ok: true, status: 200, code: null, chunks: 1 }
    },
  }
  const first = await scanProvider(api, 'codex', state, notifier)
  assert.equal(first.notified.length, 1)
  assert.equal(first.retrying.length, 1, 'reported as waiting for a retry')
  assert.deepEqual(state.seen.codex, [], 'a failed push must not be marked seen')
  assert.equal(state.delivery.codex['e1:announced'].state, 'retrying')

  const second = await scanProvider(api, 'codex', state, notifier)
  assert.equal(second.notified.length, 1, 'same event is pushed again')
  assert.deepEqual(state.seen.codex, ['e1:announced'], 'seen only after the channel accepted it')
  assert.equal(state.delivery.codex['e1:announced'], undefined, 'bookkeeping cleared on success')

  const third = await scanProvider(api, 'codex', state, notifier)
  assert.equal(third.notified.length, 0, 'never pushed twice after success')
})

await atest('N2 timeout marks delivery uncertain and is not resent', async () => {
  const state = notiState()
  const api = { resetsRecent: async () => ({ events: [mkEvent('e2')] }) }
  let calls = 0
  const notifier = { send: async () => { calls++; return { ok: false, status: 0, code: 0, timeout: true, retryable: false, error: '请求超时' } } }
  const first = await scanProvider(api, 'codex', state, notifier)
  assert.equal(first.uncertain.length, 1, 'surfaced as uncertain')
  assert.deepEqual(state.seen.codex, ['e2:announced'], 'marked seen so it cannot double-push')
  assert.equal(state.delivery.codex['e2:announced'].state, 'uncertain')
  const second = await scanProvider(api, 'codex', state, notifier)
  assert.equal(second.notified.length, 0)
  assert.equal(calls, 1, 'a maybe-delivered card is never sent twice')
})

await atest('N3 retries are bounded, then the key is retired', async () => {
  const state = notiState()
  const api = { resetsRecent: async () => ({ events: [mkEvent('e3')] }) }
  let calls = 0
  const notifier = { send: async () => { calls++; return { ok: false, status: 400, code: 400, retryable: true, error: 'HTTP 400' } } }
  for (let i = 0; i < 6; i++) await scanProvider(api, 'codex', state, notifier)
  assert.equal(calls, 5, 'stops at MAX_SEND_ATTEMPTS instead of retrying forever')
  assert.deepEqual(state.seen.codex, ['e3:announced'])
  assert.equal(state.delivery.codex['e3:announced'].state, 'gave-up')
})

const fakeRes = (status, body, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => body,
})

await atest('N4 HTTP 200 with an HTML page is not a success', async () => {
  const n = createNotifier({ fetchImpl: async () => fakeRes(200, '<html><body>proxy auth</body></html>', 'text/html') })
  const r = await n.send({ channel: 'wecom', url: 'https://x' }, 't', 'body')
  assert.equal(r.ok, false)
  assert.ok(/HTML|JSON/.test(r.error), 'explains why: ' + r.error)
  assert.equal(r.retryable, true)
})

await atest('N5 HTTP 200 with an empty body is not a success', async () => {
  const n = createNotifier({ fetchImpl: async () => fakeRes(200, '   ') })
  const r = await n.send({ channel: 'wecom', url: 'https://x' }, 't', 'body')
  assert.equal(r.ok, false)
  assert.ok(/为空/.test(r.error), r.error)
})

await atest('N5b a self-hosted 204 with no body counts as delivered (generic only)', async () => {
  const n = createNotifier({ fetchImpl: async () => fakeRes(204, '') })
  const r = await n.send({ channel: 'generic', url: 'https://hooks.example/x' }, 't', 'body')
  assert.equal(r.ok, true, '204 is the documented "accepted" shape for a self-hosted hook')
  assert.equal(r.retryable, false)

  // The exception must not leak: a known platform without a receipt is unknown.
  const im = createNotifier({ fetchImpl: async () => fakeRes(200, '') })
  const r2 = await im.send({ channel: 'wecom', url: 'https://x' }, 't', 'body')
  assert.equal(r2.ok, false)
  assert.equal(r2.retryable, true)
})

await atest('N6 known channel without its success field is not a success', async () => {
  const n = createNotifier({ fetchImpl: async () => fakeRes(200, '{"msg":"ok"}') })
  const r = await n.send({ channel: 'wecom', url: 'https://x' }, 't', 'body')
  assert.equal(r.ok, false)
  assert.ok(/errcode/.test(r.error), r.error)
})

await atest('N7 feishu timeout does not fall back to text (no duplicate card)', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    const e = new Error('This operation was aborted')
    e.name = 'AbortError'
    throw e
  }
  const n = createNotifier({ fetchImpl, timeoutMs: 50 })
  const r = await n.send({ channel: 'feishu', url: 'https://open.feishu.cn/x' }, 't', 'body')
  assert.equal(calls, 1, 'exactly one attempt: a timeout may have been delivered')
  assert.equal(r.ok, false)
  assert.equal(r.timeout, true)
})

await atest('N8 feishu rate limit or 5xx does not fall back to text', async () => {
  for (const res of [fakeRes(429, '{"code":9499,"msg":"too many"}'), fakeRes(503, '{"code":1}')]) {
    let calls = 0
    const n = createNotifier({ fetchImpl: async () => { calls++; return res } })
    const r = await n.send({ channel: 'feishu', url: 'https://open.feishu.cn/x' }, 't', 'body')
    assert.equal(calls, 1, `HTTP ${res.status} must not be retried as text`)
    assert.equal(r.ok, false)
  }
})

await atest('N9 api timeout covers the body read, not only the headers', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"report":') // headers arrive, the body never completes
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const api = createApi({ baseUrl: 'http://127.0.0.1:' + srv.address().port, timeoutMs: 300 })
  const t0 = Date.now()
  let err = null
  try { await api.dailyJson() } catch (e) { err = e }
  const ms = Date.now() - t0
  await shutdown(srv)
  assert.ok(err, 'a stalled body must reject')
  assert.equal(err.timeout, true, 'reported as a timeout: ' + (err && err.message))
  assert.ok(ms < 3000, 'aborted by the timeout instead of hanging: ' + ms + 'ms')
})

await atest('N13 the cache window follows s-maxage, and a hint-free response clears it', async () => {
  // Scripted responses, one per request, so each case below is about one header set.
  const responses = []
  const inm = [] // what If-None-Match each request carried
  const srv = http.createServer((req, res) => {
    inm.push(req.headers['if-none-match'] ?? null)
    const next = responses.shift() || {}
    res.writeHead(next.status || 200, next.headers || {})
    res.end(next.body ?? '{"events":[]}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const api = createApi({ baseUrl: 'http://127.0.0.1:' + srv.address().port, timeoutMs: 1000 })
  const path = '/api/v1/codex-resets/recent'
  assert.equal(api.cacheMaxAgeMs(path), 0, 'no hint before the first response')

  // AIHOT sends both: s-maxage is the shared window and wins.
  responses.push({ headers: { 'Content-Type': 'application/json', ETag: '"v1"', 'Cache-Control': 'public, max-age=60, s-maxage=600' } })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 600000, 's-maxage is read first')
  assert.equal(inm[0], null, 'nothing to revalidate yet')

  // max-age is the fallback when s-maxage is absent…
  responses.push({ headers: { 'Content-Type': 'application/json', ETag: '"v2"', 'Cache-Control': 'public, max-age=42' } })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 42000, 'falls back to max-age')
  assert.equal(inm[1], '"v1"', 'the previous ETag is revalidated')

  // …and the window is recorded even when there is no ETag to cache.
  responses.push({ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=90' } })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 90000, 'no ETag still records the window')

  // An explicit 0 on a 304 is information: the cached copy is no longer fresh.
  responses.push({ status: 304, headers: { 'Cache-Control': 'public, max-age=0' }, body: '' })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 0, 'an explicit zero overwrites the old value')

  // A 304 without any cache header means "unchanged", not "zero".
  responses.push({ status: 304, headers: { 'Cache-Control': 'public, s-maxage=900' }, body: '' })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 900000)
  responses.push({ status: 304, body: '' })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 900000, 'a missing header keeps the previous value')

  // no-cache on a 304 is explicit too: drop the window instead of keeping it.
  responses.push({ status: 304, headers: { 'Cache-Control': 'no-cache' }, body: '' })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 0, 'no-cache clears the remembered window')

  // A 200 that is neither revalidatable nor timed drops the whole entry: the old
  // window must not survive, and the dead ETag must not be sent again.
  responses.push({ headers: { 'Content-Type': 'application/json', ETag: '"v3"', 'Cache-Control': 'public, max-age=120' } })
  await api.resetsRecent('codex')
  assert.equal(api.cacheMaxAgeMs(path), 120000)
  responses.push({ headers: { 'Content-Type': 'application/json' } }) // no ETag, no Cache-Control
  await api.resetsRecent('codex')
  assert.equal(inm[8], '"v3"', 'the last entry was still conditional')
  assert.equal(api.cacheMaxAgeMs(path), 0, 'a hint-free 200 clears the window')
  responses.push({ headers: { 'Content-Type': 'application/json' } })
  await api.resetsRecent('codex')
  assert.equal(inm[9], null, 'and the dropped ETag is not sent again')
  await shutdown(srv)
})

await atest('N10 a truncated digest still carries the full-text link', async () => {
  const url = 'https://aihot.news/daily/2026-11-16'
  const report = { date: '2026-11-16', lead: { title: 'T', leadParagraph: '长'.repeat(4000) }, sections: [], links: { aihot: url } }
  const text = renderReportText(report)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 3000, 'stays inside the budget: ' + Buffer.byteLength(text, 'utf8'))
  assert.ok(/已截断/.test(text), 'says it was truncated')
  assert.ok(text.includes(url), 'and still includes the link it points at')
})

test('N11 report.date must be a plain calendar date', () => {
  assert.throws(() => assertReportDate('../../etc/passwd'))
  assert.throws(() => assertReportDate('2026-11-16/../x'))
  assert.throws(() => assertReportDate('2026-13-40'))
  assert.throws(() => assertReportDate(''))
  assert.equal(assertReportDate('2026-11-16'), '2026-11-16')
})

await atest('N12 runDigest refuses a traversal date before touching the disk', async () => {
  const api = { dailyJson: async () => ({ report: { date: '../../evil', sections: [] } }) }
  let threw = null
  try {
    await runDigest(api, { webhook: { channel: 'none' }, digest: {} }, { send: async () => ({ ok: true }) })
  } catch (e) { threw = e }
  assert.ok(threw && /report\.date/.test(threw.message), 'rejects instead of writing outside digest/: ' + (threw && threw.message))
})

// ---- P: shared-file honesty — every writer merges, no writer publishes a stale
// ---- snapshot, and a holder that lost the lock must not touch the file ----
const renderState = (state) => JSON.parse(JSON.stringify(state))
const withTempHome = async (fn) => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'aihot-state-'))
  try { return await fn(process.env.DSH_HOME) } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

await atest('P1 a stale snapshot cannot wipe seen or revert the webhook', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async () => {
    const live = loadState()
    live.seen.codex = ['e1:announced']
    live.webhook = { channel: 'wecom', url: 'https://a', secret: '' }
    assert.equal(saveState(live), true, 'radar-style save')

    // A second instance opened the panel before that write: its copy has no seen
    // keys, and it only changes the webhook.
    const stale = renderState(live)
    stale.seen = {}
    stale.webhook = { channel: 'dingtalk', url: 'https://b', secret: '' }
    assert.equal(saveState(stale, undefined, { own: ['webhook'] }), true)

    const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'aihot-radar', 'state.json'), 'utf8'))
    assert.deepEqual(disk.seen.codex, ['e1:announced'], 'seen survived a panel save')
    assert.equal(disk.webhook.channel, 'dingtalk', 'the section it owned did win')
  })
})

await atest('P2 a digest save cannot revert the webhook or the seen keys', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async () => {
    const live = loadState()
    live.seen.claude = ['c1:announced']
    live.webhook = { channel: 'feishu', url: 'https://open.feishu.cn/x', secret: '' }
    saveState(live)

    const digestSide = renderState(live)
    digestSide.webhook = { channel: 'none', url: '', secret: '' } // stale copy from before
    digestSide.seen = {}
    digestSide.digest = { ...digestSide.digest, lastDate: '2026-11-16' }
    assert.equal(saveState(digestSide, undefined, { own: ['digest'] }), true)

    const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'aihot-radar', 'state.json'), 'utf8'))
    assert.equal(disk.webhook.channel, 'feishu', 'digest must not revert the webhook')
    assert.deepEqual(disk.seen.claude, ['c1:announced'], 'nor the dedupe keys')
    assert.equal(disk.digest.lastDate, '2026-11-16', 'but it does own lastDate')
  })
})

await atest('P3 a holder that lost the lock refuses to write or delete it', async () => {
  const { loadState, saveState, acquireStateLock, touchStateLock } = await import('../lib/state.js')
  await withTempHome(async (home) => {
    const state = loadState()
    const release = acquireStateLock()
    assert.ok(release, 'acquired')

    // Another process took over (e.g. ours was suspended past the TTL).
    writeFileSync(join(home, 'aihot-radar', 'state.json.lock'), JSON.stringify({ pid: 999999, ts: Date.now(), token: 'foreign' }))
    assert.equal(touchStateLock(), false, 'renewing a lost lock is refused')

    state.seen.codex = ['x:announced']
    assert.equal(saveState(state), false, 'must not clobber the new holder')
    assert.equal(existsSync(join(home, 'aihot-radar', 'state.json')), false, 'nothing written')

    release()
    const left = JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json.lock'), 'utf8'))
    assert.equal(left.token, 'foreign', 'releasing must not delete someone else lock')
  })
})

await atest('P4 an unconfigured channel pauses instead of burning the retry budget', async () => {
  const state = { seen: {}, webhook: { channel: 'none', url: '', secret: '' }, lastCheck: {}, delivery: {} }
  const api = { resetsRecent: async () => ({ events: [mkEvent('p4')] }) }
  let calls = 0
  const notifier = { send: async () => { calls++; return { ok: false, skipped: true, error: 'no webhook configured', chunks: 0 } } }
  for (let i = 0; i < 8; i++) await scanProvider(api, 'codex', state, notifier)
  assert.equal(calls, 8, 'still checked every cycle')
  assert.deepEqual(state.seen.codex, [], 'the event is still pending, not retired')
  assert.deepEqual(state.delivery.codex, {}, 'no retry budget was spent')

  const r = await scanProvider(api, 'codex', state, notifier)
  assert.equal(r.paused.length, 1, 'reported as paused')
  assert.equal(r.gaveUp.length, 0)
})

await atest('P5 a body that dies after the headers is delivery-unknown, not retryable', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    text: async () => { const e = new Error('terminated'); e.name = 'AbortError'; throw e },
  })
  const n = createNotifier({ fetchImpl })
  const r = await n.send({ channel: 'wecom', url: 'https://x' }, 't', 'body')
  assert.equal(r.ok, false)
  assert.equal(r.timeout, true, 'classified as uncertain')
  assert.equal(r.retryable, false, 'and never auto-resent')
  assert.ok(/送达不确定/.test(r.error), r.error)
})

// ---- LK: a leftover lock must never stall the radar; a live one is honoured --
await atest('LK1 a half-written lock created a moment ago is not stolen', async () => {
  const { acquireStateLock, dataDir } = await import('../lib/state.js')
  await withTempHome(async () => {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    const lock = join(dataDir(), 'state.json.lock')
    writeFileSync(lock, '{"pid": 4321, "ts":', 'utf8') // crashed mid-write
    assert.equal(acquireStateLock(), null, 'a fresh unparseable lock may still be filling in')
    assert.equal(readFileSync(lock, 'utf8'), '{"pid": 4321, "ts":', 'and must not be overwritten')
  })
})

await atest('LK2 a stale corrupt lock is recovered instead of wedging every cycle', async () => {
  const { acquireStateLock, dataDir } = await import('../lib/state.js')
  await withTempHome(async () => {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    const lock = join(dataDir(), 'state.json.lock')
    const old = (Date.now() - 120000) / 1000 // past the 60s TTL, no waiting in the test
    writeFileSync(lock, 'garbage', 'utf8')
    utimesSync(lock, old, old)
    const release = acquireStateLock()
    assert.ok(release, 'an unreadable lock older than the TTL is taken over')
    assert.ok(JSON.parse(readFileSync(lock, 'utf8')).ts > 0, 'rewritten with a live stamp')
    release()
    assert.equal(existsSync(lock), false, 'and released normally, so the next cycle runs')
  })
})

await atest('LK3 a live lock wins over an old mtime, and a corrupt guard does not block', async () => {
  const { acquireStateLock, dataDir } = await import('../lib/state.js')
  await withTempHome(async () => {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    const lock = join(dataDir(), 'state.json.lock')
    const guard = join(dataDir(), 'state.json.lock.takeover')
    const old = (Date.now() - 120000) / 1000
    // Heartbeat says it is alive even though the file looks old (e.g. a copied
    // state dir): the stamp is the evidence, the mtime only a fallback.
    writeFileSync(lock, JSON.stringify({ pid: 999, ts: Date.now(), token: 'other' }))
    utimesSync(lock, old, old)
    assert.equal(acquireStateLock(), null, 'a live holder is never preempted')

    // A takeover that crashed between creating its guard and unlinking it must
    // not block the next one forever.
    writeFileSync(guard, 'half-writ')
    utimesSync(guard, old, old)
    writeFileSync(lock, 'garbage')
    utimesSync(lock, old, old)
    const release = acquireStateLock()
    assert.ok(release, 'the stale guard is cleared and the stale lock taken over')
    release()
  })
})

// ---- B: the first push after configuring a channel must not replay history --
const inferredEvent = (id) => ({
  id, status: 'announced', displayLabel: 'x', title: 't', presentation: { status: 'expired_unconfirmed' }, posts: [],
})

await atest('B1 first cycle after configuring a channel baselines 已到账, keeps 预告', async () => {
  const state = notiState()
  const api = { resetsRecent: async () => ({ events: [mkEvent('old', 'confirmed'), mkEvent('live'), inferredEvent('gone')] }) }
  const sent = []
  const notifier = { send: async (wh, title) => { sent.push(title); return { ok: true, status: 200, chunks: 1 } } }
  const r = await scanProvider(api, 'codex', state, notifier, { baselineBefore: new Date().toISOString() })
  assert.equal(r.notified.length, 1, 'only the still-open announcement is pushed')
  assert.ok(sent[0].includes('预告'), sent[0])
  // Pushed events are marked seen as usual; the two stale ones are retired without
  // a push, which is what `sent` being backlogs-free proves.
  assert.deepEqual(state.seen.codex.sort(), ['gone:announced:expired_unconfirmed', 'live:announced', 'old:confirmed'].sort(),
    'history retires silently: ' + JSON.stringify(state.seen.codex))
})

await atest('B2 the baseline is one-shot: anything arriving later is news', async () => {
  const state = notiState()
  let events = [mkEvent('old', 'confirmed')]
  const api = { resetsRecent: async () => ({ events }) }
  let sent = 0
  const notifier = { send: async () => { sent++; return { ok: true, status: 200, chunks: 1 } } }
  await scanProvider(api, 'codex', state, notifier, { baselineBefore: new Date().toISOString() })
  assert.equal(sent, 0, 'the backlog stays silent')
  events = [mkEvent('old', 'confirmed'), mkEvent('fresh', 'confirmed')]
  await scanProvider(api, 'codex', state, notifier)
  assert.equal(sent, 1, 'a confirmation that arrives afterwards pushes normally')
  assert.deepEqual(state.seen.codex.sort(), ['fresh:confirmed', 'old:confirmed'].sort())
})

// ---- B4..B6: the baseline is a cutoff, not "whichever scan happens first" ----
const stamped = (id, at, status = 'confirmed') => ({
  id, status, displayLabel: 'x', title: 't', presentation: { status }, confirmedAt: at, posts: [],
})

await atest('B4 an event confirmed after the channel was configured still pushes on the first scan', async () => {
  const state = notiState()
  const sent = []
  const api = {
    resetsRecent: async () => ({
      events: [
        stamped('backlog', '2026-11-20T07:55:00.000Z'),
        stamped('between', '2026-11-20T08:06:00.000Z'), // after the save, before the first scan
      ],
    }),
  }
  const notifier = { send: async (wh, title) => { sent.push(title); return { ok: true, status: 200, chunks: 1 } } }
  await scanProvider(api, 'codex', state, notifier, { baselineBefore: '2026-11-20T08:05:00.000Z' })
  assert.equal(sent.length, 1, 'only the pre-configuration backlog is retired')
  assert.ok(sent[0].includes('已到账'), sent[0])
  assert.deepEqual(state.seen.codex.sort(), ['backlog:confirmed', 'between:confirmed'].sort())
})

await atest('B5 a provider whose first scan failed cannot replay the backlog later', async () => {
  await withTempHome(async () => {
    const { loadState, saveState } = await import('../lib/state.js')
    const { scanCycle } = await import('../lib/radar.js')
    const cutoff = '2026-11-20T08:05:00.000Z'
    const state = loadState()
    state.webhook = { channel: 'wecom', url: 'https://x', secret: '' }
    state.baselineConfirmed = cutoff
    const sent = []
    const notifier = { send: async (wh, title) => { sent.push(title); return { ok: true, status: 200, chunks: 1 } } }
    let claudeFails = true
    const api = {
      PROVIDERS: ['codex', 'claude'],
      resetsRecent: async (p) => {
        if (p === 'claude' && claudeFails) throw new Error('HTTP 500')
        return { events: [stamped(`${p}-old`, '2026-11-20T07:00:00.000Z')] }
      },
    }

    let out = await scanCycle({ api, state, notifier, save: (s) => saveState(s) })
    assert.equal(out.results.filter((r) => r.error).length, 1)
    assert.equal(sent.length, 0)
    assert.equal(state.baselineConfirmed, cutoff, 'kept while a provider has not scanned yet')

    claudeFails = false
    out = await scanCycle({ api, state, notifier, save: (s) => saveState(s) })
    assert.equal(sent.length, 0, 'the retried provider retires the backlog instead of pushing it')
    assert.equal(state.baselineConfirmed, null, 'and the cutoff is consumed by the clean cycle')
    const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'aihot-radar', 'state.json'), 'utf8'))
    assert.equal(disk.baselineConfirmed, null, 'the consumption is persisted, not just in memory')
  })
})

await atest('B6 another instance saving the footer cannot erase a pending baseline', async () => {
  await withTempHome(async (home) => {
    const { loadState, saveState } = await import('../lib/state.js')
    const panel = loadState()          // opened before the channel was configured
    const radar = loadState()
    radar.baselineConfirmed = '2026-11-20T08:05:00.000Z'
    saveState(radar, undefined, { own: ['baselineConfirmed'] })

    panel.notify = { signature: true }
    saveState(panel, undefined, { own: ['notify'] })

    const disk = JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json'), 'utf8'))
    assert.equal(disk.baselineConfirmed, '2026-11-20T08:05:00.000Z', 'a footer save owns only the footer')
    assert.equal(disk.notify.signature, true)
  })
})

await atest('B7 a consumed baseline cannot be restored by an instance holding it', async () => {
  await withTempHome(async (home) => {
    const { loadState, saveState, mergeStateFromDisk } = await import('../lib/state.js')
    const marker = '2026-11-20T08:05:00.000Z'
    const radar = loadState()
    radar.baselineConfirmed = marker
    saveState(radar, undefined, { own: ['baselineConfirmed'] })

    const stale = loadState()               // still holds the marker
    assert.equal(stale.baselineConfirmed, marker)

    radar.baselineConfirmed = null          // the radar consumes it
    saveState(radar, undefined, { own: ['baselineConfirmed'] })

    stale.notify = { signature: true }
    saveState(stale, undefined, { own: ['notify'] })
    const disk = JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json'), 'utf8'))
    assert.equal(disk.baselineConfirmed, null, 'the explicit null on disk wins over the stale copy')

    // And a merge must follow the file too, not the in-memory value.
    const memory = { baselineConfirmed: marker, seen: {}, webhook: {}, lastCheck: {}, lastResult: {}, delivery: {}, digest: {}, notify: {}, digestPref: {} }
    mergeStateFromDisk(memory)
    assert.equal(memory.baselineConfirmed, null, 'a stale in-memory marker must not survive a merge')
  })
})

await atest('B3 the bridge flags the first configuration only', async () => {
  const state = { webhook: { channel: 'none', url: '', secret: '' }, baselineConfirmed: null }
  const stop = bridge(17435, state, { save: () => true })
  await wait()
  const post = (b) => fetch('http://127.0.0.1:17435/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json())
  assert.equal((await post({ channel: 'bark', url: 'https://api.day.app/k' })).ok, true)
  const first = state.baselineConfirmed
  assert.ok(typeof first === 'string' && first.length > 10, 'first configuration schedules a baseline')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await post({ channel: 'bark', url: 'https://api.day.app/k2' })).ok, true)
  assert.equal(state.baselineConfirmed, first, 'editing an existing channel must not re-baseline')
  stop()
})

// ---- K: the stored footer preference can only suppress the user's own line --
await atest('K1 effectiveNotify: a stored off suppresses, a stored on adds nothing', async () => {
  const { effectiveNotify, signatureEnabled } = await import('../lib/notify.js')
  assert.equal(signatureEnabled(effectiveNotify(undefined, undefined)), false, 'default is off')
  assert.equal(signatureEnabled(effectiveNotify({}, { notify: { signature: true } })), false,
    'the old switch meant "install link", which no longer exists')
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: 'via X' }, { notify: { signature: false } })), false,
    'a stored off still wins over custom text')
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: 'via X' }, { notify: { signature: null } })), true, 'null hands control back')
  assert.equal(signatureEnabled(effectiveNotify({ signatureText: 'via X' }, { notify: { signature: true } })), true,
    'a stored on neither adds a built-in line nor removes the custom one')
  assert.equal(signatureEnabled(effectiveNotify({ signature: false, signatureText: 'via X' }, { notify: { signature: true } })), false,
    'a stored on must not beat the profile\'s explicit off')
})

await atest('B8 a bridge restarted on the same port answers from the new instance', async () => {
  // Node 18 keeps kept-alive sockets alive after server.close(), so a pooled
  // connection would still be served by the stopped instance — a reloaded bridge
  // would then report the previous webhook/digest state.
  const first = { webhook: { channel: 'none', url: '', secret: '' } }
  const stopFirst = bridge(17439, first)
  await wait()
  assert.equal((await (await fetch('http://127.0.0.1:17439/status')).json()).configured, false)
  stopFirst()

  const second = { webhook: { channel: 'wecom', url: 'https://x', secret: '' } }
  const stopSecond = bridge(17439, second)
  try {
    await wait()
    const st = await (await fetch('http://127.0.0.1:17439/status')).json()
    assert.equal(st.configured, true, 'the new instance answers, not the stopped one')
    assert.equal(st.channel, 'wecom')
  } finally { stopSecond() }
})

await atest('K2 /notify can only suppress a custom line; /status reports the truth', async () => {
  const state = { webhook: { channel: 'wecom', url: 'https://x', secret: '' }, notify: { signature: null } }
  let saves = 0
  const stop = bridge(17436, state, {
    config: { notify: { signatureText: 'via 值班群' } },
    save: () => { saves++; return true },
  })
  await wait()
  const post = (b) => fetch('http://127.0.0.1:17436/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json())
  const status = () => fetch('http://127.0.0.1:17436/status').then((r) => r.json())

  assert.equal((await status()).signature, true, 'the configured custom line is what decides')
  const off = await post({ signature: false })
  assert.equal(off.ok, true); assert.equal(off.signature, false, 'a stored off suppresses it')
  assert.equal(state.notify.signature, false, 'stored in state, not the profile YAML')
  assert.equal((await status()).signature, false, 'and visible without a restart')
  assert.equal(saves, 1)

  assert.equal((await post({ signature: 'yes' })).code, 'bad-signature', 'only true / false / null')
  const back = await post({ signature: null })
  assert.equal(back.ok, true); assert.equal(back.signature, true, 'null follows the profile')
  stop()
})

await atest('K4 saving a webhook never fires the digest', async () => {
  const state = {
    webhook: { channel: 'none', url: '', secret: '' },
    notify: { signature: null }, digest: {}, digestPref: {},
  }
  const calls = { tick: 0, reschedule: 0 }
  const stop = startLocalApi({
    port: 17438, state, notifier: createNotifier(),
    config: { radar: {}, digest: {} }, save: () => true,
    digestCtl: () => ({
      tick: () => { calls.tick++ },
      reschedule: () => { calls.reschedule++ },
      nextRunAt: () => null,
    }),
  })
  await wait()
  const res = await fetch('http://127.0.0.1:17438/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wecom', url: 'https://x', secret: '' }),
  }).then((r) => r.json())
  assert.equal(res.ok, true)
  assert.equal(calls.tick, 0, 'configuring a channel must not push a digest')
  assert.equal(calls.reschedule, 0, 'nor move the next scheduled run')
  stop()
})

await atest('K3 a profile custom line is honoured until a stored off overrides it', async () => {
  const state = { webhook: { channel: 'wecom', url: 'https://x', secret: '' }, notify: { signature: null } }
  const stop = startLocalApi({
    port: 17437, state, notifier: createNotifier(),
    config: { radar: {}, digest: {}, notify: { signatureText: 'via ACME' } }, save: () => true,
  })
  await wait()
  const status = () => fetch('http://127.0.0.1:17437/status').then((r) => r.json())
  assert.equal((await status()).signature, true, 'a profile custom line shows as on')
  const off = await fetch('http://127.0.0.1:17437/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: false }),
  }).then((r) => r.json())
  assert.equal(off.signature, false, 'a stored off beats the profile text')
  stop()
})

// ---- R: digest delivery semantics + config that arrives from another instance --
await atest('R1 a timed-out digest is recorded uncertain and never retried', async () => {
  const { digestOutcome, alreadyHandledToday } = await import('../lib/digest.js')
  const state = { digest: {} }
  const out = digestOutcome(
    state,
    { ok: false, date: '2026-11-16', result: { ok: false, timeout: true, error: '请求超时（15000ms），送达不确定' } },
    '2026-11-16',
  )
  assert.equal(out.retry, false, 'no 10-minute resend of a maybe-delivered card')
  assert.equal(out.uncertain, true)
  assert.equal(state.digest.retries, 0, 'and it does not burn the retry budget')
  assert.equal(state.digest.uncertain.date, '2026-11-16')
  assert.equal(alreadyHandledToday(state, '2026-11-16'), true, 'a restart must not catch it up either')
  assert.equal(alreadyHandledToday(state, '2026-11-17'), false, 'tomorrow is a fresh day')

  const definite = { digest: {} }
  const out2 = digestOutcome(definite, { ok: false, date: '2026-11-16', result: { ok: false, status: 500, error: 'HTTP 500' } }, '2026-11-16')
  assert.equal(out2.retry, true, 'a definite failure still retries')
  assert.equal(definite.digest.retries, 1)
  assert.equal(alreadyHandledToday(definite, '2026-11-16'), false)
})

await atest('R5 a chunked send reports which pieces landed and honours skip', async () => {
  let attempts = 0
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push(String(init.body))
    attempts++
    if (attempts === 2) return { ok: false, status: 500, headers: { get: () => 'application/json' }, text: async () => 'boom' }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ errcode: 0 }) }
  }
  const n = createNotifier({ fetchImpl })
  const cfg = { channel: 'wecom', url: 'https://x' }
  const long = 'x'.repeat(9000) // wecom caps at 3900 bytes, so this is three pieces
  const r1 = await n.send(cfg, 'T', long)
  assert.equal(r1.chunks, 3)
  assert.deepEqual(r1.delivered, [0, 2], 'pieces 1 and 3 landed')
  assert.deepEqual(r1.failed, [1], 'piece 2 did not')
  assert.equal(r1.timeout, false, 'and its fate is known, so a resume is safe')

  bodies.length = 0
  const r2 = await n.send(cfg, 'T', long, { skip: r1.delivered })
  assert.equal(bodies.length, 1, 'only the missing piece is posted again')
  assert.ok(bodies[0].includes('续 2/3'), 'the resumed piece keeps its original numbering')
  assert.equal(r2.ok, true)
  assert.deepEqual([...r2.delivered].sort((a, b) => a - b), [0, 1, 2])
})

await atest('R6 a long digest retry only re-sends the pieces that failed', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    const calls = []
    let first = true
    const notifier = {
      send: async (wh, title, text, opts = {}) => {
        calls.push(Array.isArray(opts.skip) ? opts.skip.slice() : [])
        if (first) {
          first = false
          return { ok: false, chunks: 3, total: 3, delivered: [0, 2], failed: [1], timeout: false, error: 'piece 2 failed' }
        }
        return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] }
      },
    }
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digest: {} }
    const r1 = await runDigest(api, state, notifier)
    assert.equal(r1.ok, false)
    assert.deepEqual(state.digest.partial.delivered, [0, 2], 'delivered pieces are recorded')
    assert.equal(state.digest.partial.total, 3)

    const r2 = await runDigest(api, state, notifier)
    assert.equal(r2.ok, true)
    assert.deepEqual(calls[1], [0, 2], 'the retry resumes instead of re-sending the whole report')
    assert.equal(state.digest.partial, null, 'progress is cleared once the report is complete')
  })
})

await atest('R7 a changed report is not re-sent over the pieces that already landed', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    let sections = []
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections } }) }
    const skips = []
    let first = true
    const notifier = {
      send: async (wh, title, text, opts = {}) => {
        skips.push(Array.isArray(opts.skip) ? opts.skip.slice() : [])
        if (first) {
          first = false
          return { ok: false, chunks: 3, total: 3, delivered: [0], failed: [1, 2], timeout: false, error: 'HTTP 500' }
        }
        return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] }
      },
    }
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digest: {} }
    await runDigest(api, state, notifier)
    // Different content re-chunks differently: index-based resumption would leave
    // a hole, and re-sending everything would duplicate the piece that landed. So
    // neither happens — the partial stays, and a human decides.
    sections = [{ title: 'changed', items: ['z'] }]
    const r = await runDigest(api, state, notifier)
    assert.equal(r.blocked, true)
    assert.equal(skips.length, 1, 'nothing was posted again')
    assert.deepEqual(state.digest.partial.delivered, [0], 'the landed piece is still recorded')
  })
})

await atest('R8 an uncertain piece stops the resume and reports progress', async () => {
  const { runDigest, digestOutcome } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    const notifier = {
      send: async () => ({ ok: false, chunks: 3, total: 3, delivered: [0], failed: [1, 2], timeout: true, error: '请求超时（15000ms），送达不确定' }),
    }
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digest: {} }
    const r = await runDigest(api, state, notifier)
    assert.equal(state.digest.partial, null, 'nothing is queued: a timed-out piece may have landed')
    const out = digestOutcome(state, r, '2026-11-19')
    assert.equal(out.retry, false, 'and the day is not retried automatically')
    assert.equal(out.uncertain, true)
    assert.equal(state.digest.uncertain.delivered, 1, 'but the known progress is reported')
    assert.equal(state.digest.uncertain.total, 3)
  })
})

await atest('R10 a second bot of the same channel must not resume the first one\'s pieces', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    const skips = []
    let first = true
    const notifier = {
      send: async (wh, t, text, opts = {}) => {
        skips.push(Array.isArray(opts.skip) ? opts.skip.slice() : [])
        if (first) {
          first = false
          return { ok: false, chunks: 3, total: 3, delivered: [0], failed: [1, 2], timeout: false, error: 'HTTP 500' }
        }
        return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] }
      },
    }
    const state = { webhook: { channel: 'wecom', url: 'https://qyapi.weixin.qq.com/a' }, digest: {} }
    await runDigest(api, state, notifier)
    assert.deepEqual(state.digest.partial.delivered, [0])

    // Same channel type, different bot: it never received piece 1.
    state.webhook = { channel: 'wecom', url: 'https://qyapi.weixin.qq.com/b' }
    await runDigest(api, state, notifier)
    assert.deepEqual(skips[1], [], 'the new bot is sent the whole report')
    assert.equal(state.digest.partial, null, 'and is only marked delivered once it has all of it')
  })
})

await atest('R11 editing the footer before the retry must not re-send the landed pieces', async () => {
  const { runDigest, digestOutcome } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    let sends = 0
    let first = true
    const notifier = {
      send: async () => {
        sends++
        if (first) {
          first = false
          return { ok: false, chunks: 3, total: 3, delivered: [0, 1], failed: [2], timeout: false, error: 'HTTP 500' }
        }
        return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] }
      },
    }
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digest: {}, notify: { signature: null } }
    await runDigest(api, state, notifier)
    assert.deepEqual(state.digest.partial.delivered, [0, 1])

    // The footer changes between the failure and the retry: the text (and so the
    // chunk boundaries) is no longer the one the first two pieces came from.
    const r = await runDigest(api, state, notifier, { notify: { signatureText: 'via my group' } })
    assert.equal(r.blocked, true, 'no automatic resume, and no blind re-send')
    assert.equal(sends, 1, 'nothing is posted again')
    assert.deepEqual(state.digest.partial.delivered, [0, 1], 'the partial record is kept')
    assert.match(r.error, /内容与上次不同/)

    const out = digestOutcome(state, r, '2026-11-19')
    assert.equal(out.retry, false, 'a retry would only hit the same wall')
    assert.equal(out.blocked, true)
    assert.equal(state.digest.lastDate, undefined, 'and the day is not marked delivered')
  })
})

await atest('R12 a legacy partial with no receiver is never resumed by channel type alone', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    let sends = 0
    const notifier = { send: async () => { sends++; return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] } } }
    const partial = { date: '2026-11-19', hash: 'whatever', channel: 'wecom', delivered: [0], total: 3 }
    const state = { webhook: { channel: 'wecom', url: 'https://new-bot' }, digest: { partial } }

    const r = await runDigest(api, state, notifier)
    assert.equal(r.blocked, true)
    assert.match(r.error, /接收端/)
    assert.equal(sends, 0, 'neither resumed nor re-sent')
    assert.deepEqual(state.digest.partial, partial, 'the partial record survives unchanged')
  })
})

await atest('R13 digest: a stale footer record adds nothing, a custom footer survives the chunk retry', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    const PROMO = /via AIHOT|github\.com\/liancheng2020|安装：github:/

    // A stale panel record (the removed "install link" checkbox) must not sneak a
    // promo line into the digest either.
    const legacyTexts = []
    const legacyNotifier = {
      send: async (wh, t, text) => { legacyTexts.push(text); return { ok: true, chunks: 1, total: 1, delivered: [0], failed: [] } },
    }
    await runDigest(
      api,
      { webhook: { channel: 'wecom', url: 'https://x' }, digest: {}, notify: { signature: true } },
      legacyNotifier,
    )
    assert.ok(!PROMO.test(legacyTexts[0]), 'no built-in footer from a stale checked record')

    // The user's own line is appended once, and a chunked retry still resumes only
    // the pieces that failed (the text — footer included — is unchanged).
    const calls = []
    let first = true
    const notifier = {
      send: async (wh, t, text, opts = {}) => {
        calls.push({ text, skip: Array.isArray(opts.skip) ? opts.skip.slice() : [] })
        if (first) {
          first = false
          return { ok: false, chunks: 3, total: 3, delivered: [0, 2], failed: [1], timeout: false, error: 'HTTP 500' }
        }
        return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] }
      },
    }
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digest: {}, notify: { signature: null } }
    const config = { notify: { signatureText: 'via ACME 值班群' } }
    const r1 = await runDigest(api, state, notifier, config)
    assert.equal(r1.ok, false)
    assert.equal(calls[0].text.match(/via ACME 值班群/g).length, 1, 'the custom footer appears exactly once')
    assert.ok(!PROMO.test(calls[0].text), 'and no install link got appended next to it')

    const r2 = await runDigest(api, state, notifier, config)
    assert.equal(r2.ok, true)
    assert.deepEqual(calls[1].skip, [0, 2], 'only the missing piece is posted again')
    assert.ok(calls[1].text.includes('via ACME 值班群'), 'the retry keeps the same footer')
    assert.equal(state.digest.lastDate, '2026-11-19')
  })
})

await atest('R14 a digest with no channel is archived, not marked delivered', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async (home) => {
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    let asked = 0
    const notifier = {
      send: async () => { asked++; return { ok: false, skipped: true, error: '未配置推送通道', chunks: 0 } },
    }
    const state = { webhook: { channel: 'none', url: '', secret: '' }, digest: {} }
    const r = await runDigest(api, state, notifier)
    assert.equal(r.noChannel, true)
    assert.equal(asked, 1, 'the notifier is asked once and declines')
    assert.equal(state.digest.lastDate, undefined, 'nothing was delivered, so the period stays pending')
    assert.equal(state.digest.archived.date, '2026-11-19', 'the local archive is recorded on its own key')
    assert.ok(existsSync(join(home, 'aihot-radar', 'digest', '2026-11-19.md')), 'and the file really is on disk')

    // Configure the bot afterwards: the period is still deliverable, not skipped.
    state.webhook = { channel: 'wecom', url: 'https://x', secret: '' }
    let delivered = 0
    const real = {
      send: async () => { delivered++; return { ok: true, chunks: 1, total: 1, delivered: [0], failed: [] } },
    }
    const r2 = await runDigest(api, state, real)
    assert.equal(r2.ok, true)
    assert.equal(delivered, 1, 'the archived-only period goes out once a channel exists')
    assert.equal(state.digest.lastDate, '2026-11-19')
  })
})

await atest('R16 a failed archive is a failure, not a "delivered" or "archived" claim', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async (home) => {
    // A plain file where the archive directory must go makes mkdirSync fail.
    mkdirSync(join(home, 'aihot-radar'), { recursive: true })
    writeFileSync(join(home, 'aihot-radar', 'digest'), 'not a directory', 'utf8')
    const api = { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) }
    const notifier = { send: async () => ({ ok: false, skipped: true, error: 'no webhook configured', chunks: 0 }) }
    const state = { webhook: { channel: 'none', url: '', secret: '' }, digest: {} }
    const warns = []
    const r = await runDigest(api, state, notifier, {}, {
      warn: (m) => warns.push(m), info: () => {}, debug: () => {}, error: () => {},
    })
    assert.equal(r.archived, false, 'the write really failed')
    assert.equal(r.noChannel, true)
    assert.equal(state.digest.lastDate, undefined, 'nothing was delivered')
    assert.equal(state.digest.archived, undefined, 'and nothing claims an archive that does not exist')
    assert.ok(warns.some((m) => /归档失败/.test(m)), warns.join(' | '))
  })
})

await atest('R15 the poll cycle reports the largest upstream cache window as a floor', async () => {
  await withTempHome(async () => {
    const { loadState } = await import('../lib/state.js')
    const { scanCycle } = await import('../lib/radar.js')
    const state = loadState()
    state.webhook = { channel: 'none', url: '', secret: '' }
    const api = {
      PROVIDERS: ['codex', 'claude'],
      resetsRecent: async () => ({ events: [] }),
      cacheMaxAgeMs: (p) => (p.includes('claude') ? 900000 : 120000),
    }
    const out = await scanCycle({ api, state, notifier: { send: async () => ({ ok: true }) } })
    assert.equal(out.minDelayMs, 900000, 'the slowest document decides the next interval')
  })
})

await atest('R9 digest titles carry the same brand prefix as reset cards', async () => {
  const { runDigest } = await import('../lib/digest.js')
  await withTempHome(async () => {
    let title = null
    const notifier = { send: async (wh, t) => { title = t; return { ok: true, chunks: 1, total: 1, delivered: [0], failed: [] } } }
    await runDigest(
      { dailyJson: async () => ({ report: { date: '2026-11-19', sections: [] } }) },
      { webhook: { channel: 'wecom', url: 'https://x' }, digest: {} },
      notifier,
    )
    assert.ok(String(title).startsWith('AIHOT 雷达 · 日报 '), title)
  })
})

await atest('R2 a digest switched off by another instance is not sent', async () => {
  const { startDigest } = await import('../lib/digest.js')
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async () => {
    // The other instance already saved "off" into the shared file.
    const disk = loadState()
    disk.digestPref = { enabled: false, time: null }
    saveState(disk, undefined, { own: ['digestPref'] })

    // This instance still holds the old in-memory switch (on).
    const state = { webhook: { channel: 'wecom', url: 'https://x' }, digestPref: { enabled: true, time: null }, digest: {} }
    let sent = 0
    const ctl = startDigest({
      api: { dailyJson: async () => ({ report: { date: '2026-11-16', sections: [], links: {} } }) },
      state,
      notifier: { send: async () => { sent++; return { ok: true, chunks: 1 } } },
      config: { digest: { enabled: false, time: '08:30', catchUp: false } },
      save: (s) => saveState(s, undefined, { own: ['digest'] }),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })
    try {
      await ctl.tick()
      assert.equal(sent, 0, 'the switch must be re-read after merging the disk config')
      assert.equal(state.digest.lastDate, undefined, 'and nothing is marked as sent')
    } finally { ctl.stop() }
  })
})

await atest('R3 a config-only save keeps the newest delivery records', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async () => {
    const live = loadState()
    live.delivery = { codex: { 'e1:announced': { attempts: 2, state: 'retrying', at: '2026-11-16T07:00:00.000Z', error: 'HTTP 500' } } }
    saveState(live, undefined, { own: ['delivery'] })

    // Older instance: knows the provider key but has no records under it.
    const stale = renderState(live)
    stale.delivery = { codex: {} }
    stale.webhook = { channel: 'bark', url: 'https://bark/x', secret: '' }
    saveState(stale, undefined, { own: ['webhook'] })

    const disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'aihot-radar', 'state.json'), 'utf8'))
    assert.equal(disk.delivery.codex['e1:announced']?.attempts, 2, 'delivery survived a config-only save')
    assert.equal(disk.webhook.channel, 'bark')
  })
})

await atest('R4 a cleared delivery record must not be resurrected by a config save', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async (home) => {
    const file = () => JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json'), 'utf8'))

    const live = loadState()
    live.delivery = { codex: { 'e1:announced': { attempts: 2, state: 'retrying', at: '2026-11-16T07:00:00.000Z', error: 'HTTP 500' } } }
    saveState(live, undefined, { own: ['delivery'] })
    assert.equal(file().delivery.codex['e1:announced'].attempts, 2)

    // The radar retries, the push succeeds, the record is cleared.
    const radar = renderState(live)
    radar.delivery = { codex: {} }
    saveState(radar, undefined, { own: ['delivery'] })
    assert.deepEqual(file().delivery.codex, {}, 'the owner deleted the record')

    // An older panel instance still holds it and saves an unrelated webhook.
    const stale = renderState(live)
    stale.webhook = { channel: 'bark', url: 'https://bark/x', secret: '' }
    saveState(stale, undefined, { own: ['webhook'] })

    assert.equal(file().delivery.codex['e1:announced'], undefined, 'a cleared record must stay cleared')
    assert.equal(file().webhook.channel, 'bark', 'the owned section still applies')
  })
})

await atest('R5 a stale instance cannot resurrect trimmed seen keys either', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async (home) => {
    const file = () => JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json'), 'utf8'))
    const live = loadState()
    live.seen = { codex: ['e1:announced', 'e2:announced'] }
    saveState(live, undefined, { own: ['seen'] })

    // Radar trims seen to the current API snapshot (e2 rolled out of the window).
    const radar = renderState(live)
    radar.seen = { codex: ['e1:announced'] }
    saveState(radar, undefined, { own: ['seen'] })
    assert.deepEqual(file().seen.codex, ['e1:announced'])

    const stale = renderState(live) // still has both keys
    stale.webhook = { channel: 'wecom', url: 'https://qyapi.weixin.qq.com/x', secret: '' }
    saveState(stale, undefined, { own: ['webhook'] })

    assert.deepEqual(file().seen.codex, ['e1:announced'], 'trimmed keys must not come back')
  })
})

await atest('R6 radar retry-then-success: a stale panel save cannot revive the record', async () => {
  const { loadState, saveState } = await import('../lib/state.js')
  await withTempHome(async (home) => {
    const file = () => JSON.parse(readFileSync(join(home, 'aihot-radar', 'state.json'), 'utf8'))
    const state = loadState()
    const api = { resetsRecent: async () => ({ events: [mkEvent('r6')] }) }
    let fail = true
    const notifier = {
      send: async () => (fail
        ? { ok: false, status: 500, code: 500, retryable: true, error: 'HTTP 500' }
        : { ok: true, status: 200, chunks: 1 }),
    }

    await scanProvider(api, 'codex', state, notifier)
    saveState(state)
    assert.equal(file().delivery.codex['r6:announced'].state, 'retrying')
    const stale = renderState(state) // a panel instance opened before the retry

    fail = false
    await scanProvider(api, 'codex', state, notifier)
    saveState(state)
    assert.equal(file().delivery.codex['r6:announced'], undefined, 'cleared once the push succeeded')

    stale.webhook = { channel: 'bark', url: 'https://bark/x', secret: '' }
    saveState(stale, undefined, { own: ['webhook'] })
    assert.equal(file().delivery.codex['r6:announced'], undefined, 'an unrelated save must not revive it')
    assert.equal(file().webhook.channel, 'bark')
  })
})

// ---- T: the whole digest schedule, not just the classifier. Each case drives
// ---- real ticks through startDigest (lock + merge + dedupe + send + save).
const NOOP_LOG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const digestHarness = async (send, logger = NOOP_LOG) => {
  const { startDigest } = await import('../lib/digest.js')
  const { loadState, saveState } = await import('../lib/state.js')
  const state = loadState()
  state.webhook = { channel: 'wecom', url: 'https://x', secret: '' }
  state.digestPref = { enabled: true, time: null }
  const today = tzParts(new Date(), 'Asia/Shanghai').date
  const ctl = startDigest({
    api: { dailyJson: async () => ({ report: { date: today, sections: [], links: {} } }) },
    state,
    notifier: { send },
    config: { digest: { enabled: true, time: '08:30', timezone: 'Asia/Shanghai' } },
    save: (s) => saveState(s, undefined, { own: ['digest'] }),
    logger,
  })
  return { ctl, state, today }
}

await atest('T1 a timed-out digest is not re-sent by a later tick or a reschedule', async () => {
  await withTempHome(async () => {
    let calls = 0
    const h = await digestHarness(async () => {
      calls++
      return { ok: false, status: 0, code: 0, timeout: true, retryable: false, error: '请求超时，送达不确定' }
    })
    try {
      await h.ctl.tick()
      assert.equal(calls, 1)
      assert.equal(h.state.digest.uncertain.date, h.today, 'recorded as uncertain')
      assert.equal(h.state.digest.lastDate, null, 'uncertain is not "delivered"')

      // Same period, again: another instance's queued timer, then a reschedule
      // after the panel edited the send time. Neither may push it twice.
      await h.ctl.tick()
      h.ctl.reschedule()
      await h.ctl.tick()
      assert.equal(calls, 1, 'a timed-out digest must not be re-sent the same day')
    } finally { h.ctl.stop() }
  })
})

await atest('T2 a delivered digest is not re-sent by tick or reschedule either', async () => {
  await withTempHome(async () => {
    let calls = 0
    const h = await digestHarness(async () => { calls++; return { ok: true, status: 200, chunks: 1 } })
    try {
      await h.ctl.tick()
      assert.equal(calls, 1)
      assert.equal(h.state.digest.lastDate, h.today)
      await h.ctl.tick()
      h.ctl.reschedule()
      await h.ctl.tick()
      assert.equal(calls, 1, 'lastDate blocks the repeat')
    } finally { h.ctl.stop() }
  })
})

await atest('T3 a definite failure still retries on the next tick', async () => {
  await withTempHome(async () => {
    let calls = 0
    const h = await digestHarness(async () => { calls++; return { ok: false, status: 500, code: 500, error: 'HTTP 500' } })
    try {
      await h.ctl.tick()
      assert.equal(calls, 1)
      assert.equal(h.state.digest.retries, 1)
      await h.ctl.tick()
      assert.equal(calls, 2, 'the uncertain guard must not swallow real failures')
      assert.equal(h.state.digest.uncertain, undefined)
    } finally { h.ctl.stop() }
  })
})

// ---- C: host Config defaults. index.js cannot be imported here — it pulls the
// host's schemastery/dsh-tools peer deps, which a bare checkout does not have —
// so the default objects are read from source and checked against the same
// helpers the runtime uses. A drifting default is invisible at runtime (the
// schema just hands it to the code), which is exactly why it needs a test.
const indexSrc = readFileSync(join(here, '../index.js'), 'utf8')
// Lazily resolved so a parse miss fails one case instead of killing the run.
// Only PROVIDERS is in scope for these literals; spreading it there keeps the
// default list from drifting away from the radar's own list.
const defaultsOf = (name) => {
  // One-liner literals first, otherwise the cross-line pattern would run on into
  // the next declaration and swallow it.
  const m = indexSrc.match(new RegExp(`const ${name} = (\\{[^\\n]*\\})`))
    || indexSrc.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\})`))
  assert.ok(m, `${name} must stay a plain object literal so the defaults can be checked here`)
  return new Function('PROVIDERS', `return (${m[1]})`)(PROVIDERS)
}
let cfgRadar, cfgDigest, cfgNotify
const configDefaults = () => {
  cfgRadar ??= defaultsOf('DEFAULT_RADAR')
  cfgDigest ??= defaultsOf('DEFAULT_DIGEST')
  cfgNotify ??= defaultsOf('DEFAULT_NOTIFY')
  return { cfgRadar, cfgDigest, cfgNotify }
}

test('C1 default digest time passes the validator the panel uses', () => {
  const { cfgDigest } = configDefaults()
  assert.equal(validateTime(cfgDigest.time), cfgDigest.time, 'a default that fails validation is silently rewritten')
})
test('C2 default digest timezone resolves to Asia/Shanghai', () => {
  const { cfgDigest } = configDefaults()
  assert.equal(resolveTz(cfgDigest.timezone), 'Asia/Shanghai')
})
test('C3 the footer stays opt-in by default', () => {
  const { cfgNotify } = configDefaults()
  assert.equal(signatureEnabled(cfgNotify), false, 'default config must not append the promo line')
  assert.equal(withSignature('x', cfgNotify), 'x')
})
test('C4 the default provider list covers every provider', () => {
  const { cfgRadar } = configDefaults()
  assert.deepEqual([...cfgRadar.providers].sort(), [...PROVIDERS].sort(), 'a provider missing from the default is never scanned')
})
test('C5 the default poll interval follows the upstream guidance', () => {
  const { cfgRadar } = configDefaults()
  assert.ok(Number.isInteger(cfgRadar.pollSeconds) && cfgRadar.pollSeconds >= 60 && cfgRadar.pollSeconds <= 3600, 'the schema would silently clamp an out-of-range default')
  assert.equal(cfgRadar.pollSeconds, 600, 'AIHOT asks for at most one request per 10 minutes on the reset endpoints')
})
test('C6 the default quiet window mutes nothing', () => {
  const { cfgRadar, cfgDigest } = configDefaults()
  assert.deepEqual(cfgRadar.quiet, { start: '', end: '' })
  assert.equal(isQuietNow(cfgRadar.quiet, new Date('2026-11-20T03:00:00Z'), cfgDigest.timezone), false)
})
// The schema resolves defaults before notify.js sees the object, so a default on
// `signature` silently rewrites "the user left it out" into an explicit "off" —
// which beats signatureText and turns a custom footer into a no-op. Only a source
// check can catch that here: the schema itself needs the host's schemastery.
test('C7 notify.signature must have no schema default', () => {
  const { cfgNotify } = configDefaults()
  assert.ok(!('signature' in cfgNotify), 'DEFAULT_NOTIFY must not pin signature')
  const m = indexSrc.match(/signature:\s*z\.boolean\(([^)]*)\)/)
  assert.ok(m, 'notify.signature must stay a plain boolean schema')
  assert.ok(!/default/i.test(m[1]), 'a default here would disable a custom signatureText')
})

await atest('T4 a partial that cannot be resumed is not retried on a timer', async () => {
  await withTempHome(async () => {
    let calls = 0
    const h = await digestHarness(async () => { calls++; return { ok: true, chunks: 3, total: 3, delivered: [0, 1, 2], failed: [] } })
    // Legacy record: same channel, but no receiver identity to compare against.
    h.state.digest.partial = { date: h.today, hash: 'x', channel: 'wecom', delivered: [0], total: 3 }
    try {
      await h.ctl.tick()
      assert.equal(calls, 0, 'nothing is sent: neither resumed nor re-sent')
      assert.deepEqual(h.state.digest.partial.delivered, [0], 'the partial record is kept')
      assert.equal(h.state.digest.lastDate, null, 'and the day is not claimed as delivered')
      await h.ctl.tick()
      h.ctl.reschedule()
      await h.ctl.tick()
      assert.equal(calls, 0, 'later ticks and a reschedule do not walk into the same wall')
    } finally { h.ctl.stop() }
  })
})

await atest('T5 a digest that could not be sent stays pending until a channel exists', async () => {
  await withTempHome(async () => {
    const { saveState } = await import('../lib/state.js')
    let calls = 0
    let delivered = false
    const h = await digestHarness(async () => {
      calls++
      return delivered
        ? { ok: true, chunks: 1, total: 1, delivered: [0], failed: [] }
        : { ok: false, skipped: true, error: '未配置推送通道', chunks: 0 }
    })
    h.state.webhook = { channel: 'none', url: '', secret: '' }
    try {
      await h.ctl.tick()
      assert.equal(calls, 1)
      assert.equal(h.state.digest.lastDate, null, 'the panel must not claim a delivery that never happened')
      assert.equal(h.state.digest.archived.date, h.today, 'the archive is recorded on its own key')

      // The user configures the bot later in the day (and the state file learns it).
      h.state.webhook = { channel: 'wecom', url: 'https://x', secret: '' }
      saveState(h.state, undefined, { own: ['webhook'] })
      delivered = true
      await h.ctl.tick()
      assert.equal(h.state.digest.lastDate, h.today, 'the same period is still delivered afterwards')
    } finally { h.ctl.stop() }
  })
})

// ---- W: the deprecate workflow validates the whole input, not one line of it --
test('W1 the workflow takes the spec from env and validates it as one full SemVer', () => {
  const yml = readFileSync(join(here, '..', '.github', 'workflows', 'deprecate.yml'), 'utf8')
  assert.ok(/SPEC: \$\{\{ inputs\.spec \}\}/.test(yml), 'the spec must arrive as an env var, not as script text')
  assert.ok(/MESSAGE: \$\{\{ inputs\.message \}\}/.test(yml), 'same for the message')
  const script = yml.slice(yml.indexOf('run: |'))
  assert.ok(script.length > 0, 'the workflow must keep its script step')
  assert.ok(!/\$\{\{\s*inputs\./.test(script), 'no input may be interpolated into the script body')
  // grep matches line by line, so "junk<newline>dsh-aihot-radar@1.2.3" would pass.
  assert.ok(!/\$SPEC[^\n]*grep/.test(yml), 'grep cannot validate the spec as a whole')
  assert.ok(/\[\[ "\$SPEC" == \*\$'\\n'\*/.test(yml), 'a multi-line value must be rejected outright')

  // Rebuild the shell's own pattern from the file and decide real versions with it,
  // so the rule that runs in CI is the one under test.
  const shellVar = (name) => {
    const m = new RegExp(`^\\s*${name}=(['"])(.*)\\1$`, 'm').exec(yml)
    return m ? m[2] : null
  }
  const parts = { NUM: shellVar('NUM'), IDENT: shellVar('IDENT'), CORE: shellVar('CORE'), PRE: shellVar('PRE'), BUILD: shellVar('BUILD') }
  for (const [k, v] of Object.entries(parts)) assert.ok(v, `${k} must stay a shell variable`)
  const expand = (s) => {
    let out = s
    for (let i = 0; i < 5 && /\$\{/.test(out); i++) {
      out = out.replace(/\$\{(NUM|IDENT|CORE|PRE|BUILD)\}/g, (_, n) => parts[n])
    }
    return out
  }
  assert.ok(/\[\[ ! "\$SPEC" =~ \^dsh-aihot-radar@\$\{CORE\}\$\{PRE\}\$\{BUILD\}\$ \]\]/.test(yml),
    'the anchored pattern must be matched against the whole value')
  const re = new RegExp(expand('^dsh-aihot-radar@${CORE}${PRE}${BUILD}$'))

  for (const good of [
    'dsh-aihot-radar@0.4.0',
    'dsh-aihot-radar@0.0.0-stage',
    'dsh-aihot-radar@1.2.3-rc.1',
    'dsh-aihot-radar@1.2.3-alpha.beta-2',
    'dsh-aihot-radar@1.2.3+build.7',
  ]) assert.ok(re.test(good), `should allow ${good}`)

  for (const bad of [
    'dsh-aihot-radar@0.4.1-rc..1',   // empty prerelease identifier
    'dsh-aihot-radar@01.2.3',        // leading zero in a numeric identifier
    'dsh-aihot-radar@1.2.3-rc.01',   // leading zero in a prerelease number
    'dsh-aihot-radar@1.2',           // not a full version
    'dsh-aihot-radar@1.2.3-',        // empty prerelease
    'dsh-aihot-radar@1.2.3+',        // empty build metadata
    'dsh-aihot-radar@1.2.3.4',
    'dsh-aihot-radar@>=0.0.0',       // a range is not a version
    '@scope/pkg@1.0.0',              // not this package
    'junk\ndsh-aihot-radar@1.2.3',
    'dsh-aihot-radar@1.2.3\njunk',
    'dsh-aihot-radar@1.2.3\n',
  ]) assert.ok(!re.test(bad), `should reject ${JSON.stringify(bad)}`)
})

await atest('T6 no channel: the log states whether the archive happened', async () => {
  const send = async () => ({ ok: false, skipped: true, error: 'no webhook configured', chunks: 0 })
  // Writable home: archived and unsent.
  await withTempHome(async () => {
    const lines = []
    const log = { debug: () => {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
    const h = await digestHarness(send, log)
    h.state.webhook = { channel: 'none', url: '', secret: '' }
    try {
      await h.ctl.tick()
      assert.equal(h.state.digest.lastDate, null)
      assert.ok(lines.some((m) => /已归档到本地，未推送/.test(m)), lines.join(' | '))
      assert.ok(!lines.some((m) => /归档失败/.test(m)), 'a good archive is not reported as failed')
    } finally { h.ctl.stop() }
  })
  // Broken archive path: the same run must not claim an archive.
  await withTempHome(async (home) => {
    mkdirSync(join(home, 'aihot-radar'), { recursive: true })
    writeFileSync(join(home, 'aihot-radar', 'digest'), 'not a directory', 'utf8')
    const lines = []
    const log = { debug: () => {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
    const h = await digestHarness(send, log)
    h.state.webhook = { channel: 'none', url: '', secret: '' }
    try {
      await h.ctl.tick()
      assert.equal(h.state.digest.lastDate, null)
      assert.ok(lines.some((m) => /归档失败，未推送/.test(m)), lines.join(' | '))
      assert.ok(!lines.some((m) => /已归档到本地，未推送/.test(m)), 'must not claim an archive that failed')
    } finally { h.ctl.stop() }
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
// Hard stop: a leaked listener must not make the run look hung. unref() so a
// clean run still exits naturally (and flushes stdout) before this fires.
setTimeout(() => process.exit(process.exitCode), 100).unref()