// Self-test for dsh-aihot-radar. No test framework — plain node:assert + a local
// fake webhook server. Run: node scripts/selftest.mjs  (Git Bash / PowerShell)
// Covers A1 (chunking + errcode), A3 (radar cap/dedup), A5 (addDays timezone),
// B1 (digest.time validation).

import assert from 'node:assert'
import http from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createNotifier, chunkContent, formatResetMessage, formatInferredMessage, withSignature, DEFAULT_SIGNATURE, toPlainText, toFeishuCard } from '../lib/notify.js'
import { scanProvider } from '../lib/radar.js'
import { createApi } from '../lib/api.js'
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
  const md = '### 标题\n数据来源：[AIHOT](https://aihot.news)\n\nvia AIHOT 雷达 · 安装：x'
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
  const note = card.elements.find((e) => e.tag === 'note')
  assert.ok(note && note.elements[0].content.includes('via AIHOT'), 'signature moves to the note')
  assert.ok(!div.text.content.includes('via AIHOT'), 'signature left the body')

  assert.ok(!telegram.body.text.includes('###') && telegram.body.text.includes('AIHOT https://aihot.news'), 'telegram is plain')
  assert.ok(wecom.body.markdown.content.includes('**标题**'), 'wecom keeps markdown')
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

// ---- S: push-card signature (on by default, opt-out, custom text) ----
test('S1 signature on by default in reset card', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'announced' } }
  assert.ok(formatResetMessage('codex', ev).text.endsWith(DEFAULT_SIGNATURE))
})
test('S2 signature on in inferred card', () => {
  const ev = { status: 'announced', title: 't', presentation: { status: 'likely_completed' } }
  const { text } = formatInferredMessage('claude', ev)
  assert.ok(text.endsWith(DEFAULT_SIGNATURE))
})
test('S3 notify.signature=false removes the line', () => {
  const ev = { status: 'confirmed', title: 't' }
  assert.ok(!formatResetMessage('codex', ev, { signature: false }).text.includes('via AIHOT'))
  assert.ok(!withSignature('body', { signature: false }).includes('via AIHOT'))
})
test('S4 custom signatureText wins over the default', () => {
  assert.equal(withSignature('body', { signatureText: 'via ACME' }), 'body\n\nvia ACME')
  assert.equal(withSignature('body', { signatureText: '   ' }), `body\n\n${DEFAULT_SIGNATURE}`)
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
const digestHarness = async (send) => {
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
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
// Hard stop: a leaked listener must not make the run look hung. unref() so a
// clean run still exits naturally (and flushes stdout) before this fires.
setTimeout(() => process.exit(process.exitCode), 100).unref()