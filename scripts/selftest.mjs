// Self-test for dsh-aihot-radar. No test framework — plain node:assert + a local
// fake webhook server. Run: node scripts/selftest.mjs  (Git Bash / PowerShell)
// Covers A1 (chunking + errcode), A3 (radar cap/dedup), A5 (addDays timezone),
// B1 (digest.time validation).

import assert from 'node:assert'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createNotifier, chunkContent, formatResetMessage, formatInferredMessage, withSignature, DEFAULT_SIGNATURE, toPlainText, toFeishuCard } from '../lib/notify.js'
import { scanProvider } from '../lib/radar.js'
import { validateTime, msUntilNext } from '../lib/digest.js'
import { isQuietNow, tzParts, resolveTz } from '../lib/time.js'
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
  await new Promise((r) => srv.close(r))
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
  await new Promise((r) => srv.close(r))
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
  stop(); await new Promise((r) => hook.close(r))
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
    stop(); await new Promise((r) => hook.close(r))
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
// Hard stop: a leaked listener must not make the run look hung. unref() so a
// clean run still exits naturally (and flushes stdout) before this fires.
setTimeout(() => process.exit(process.exitCode), 100).unref()