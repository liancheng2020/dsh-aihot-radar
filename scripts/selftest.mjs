// Self-test for dsh-aihot-radar. No test framework — plain node:assert + a local
// fake webhook server. Run: node scripts/selftest.mjs  (Git Bash / PowerShell)
// Covers A1 (chunking + errcode), A3 (radar cap/dedup), A5 (addDays timezone),
// B1 (digest.time validation).

import assert from 'node:assert'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createNotifier, chunkContent, formatResetMessage, formatInferredMessage, withSignature, DEFAULT_SIGNATURE } from '../lib/notify.js'
import { scanProvider } from '../lib/radar.js'
import { validateTime, msUntilNext } from '../lib/digest.js'
import { isQuietNow, tzParts, resolveTz } from '../lib/time.js'
import { startLocalApi } from '../lib/localapi.js'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0, failed = 0
const test = (name, fn) => { try { fn(); console.log('PASS  ' + name); passed++ } catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ } }
const atest = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); passed++ } catch (e) { console.log('FAIL  ' + name + '  ' + e.message); failed++ } }

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

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0