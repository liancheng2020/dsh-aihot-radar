// Loopback-only HTTP bridge so the sidebar panel can show host push status and
// trigger a test push. Binds 127.0.0.1; never exposes webhook url/secret.
// Degrades gracefully: if the port is taken or the client can't reach it (e.g.
// mixed-content on a remote web profile), the panel falls back to the
// aihot_radar_status agent tool.

import http from 'node:http'
import { withSignature } from './notify.js'

export const LOCAL_API_PORT = 17420

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

export function startLocalApi({ port = LOCAL_API_PORT, state, notifier, config, logger }) {
  let lastTest = 0
  const server = http.createServer(async (req, res) => {
    cors(res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const path = (req.url || '').split('?')[0]
    try {
      if (req.method === 'GET' && path === '/status') {
        const wh = state.webhook || {}
        const configured = !!wh.channel && wh.channel !== 'none' && (!!wh.url || wh.channel === 'telegram')
        return json(res, 200, {
          channel: wh.channel || 'none',
          configured,
          lastResult: state.lastResult || {},
          lastCheck: state.lastCheck || {},
          digest: state.digest || {},
          radar: {
            enabled: config.radar?.enabled !== false,
            quiet: config.radar?.quiet || { start: '', end: '' },
            muted: config.radar?.muted || [],
          },
          digestCfg: {
            enabled: config.digest?.enabled === true,
            time: config.digest?.time || '08:30',
            timezone: config.digest?.timezone || 'Asia/Shanghai',
          },
          notify: { signature: config.notify?.signature !== false },
        })
      }
      if (req.method === 'POST' && path === '/test-push') {
        const now = Date.now()
        if (now - lastTest < 3000) return json(res, 200, { ok: false, error: 'too-frequent', skipped: true })
        lastTest = now
        const r = await notifier.send(state.webhook, 'AIHOT 雷达 · 测试推送',
          withSignature('这是一条测试消息：webhook 通道工作正常。\n数据来源：[AIHOT](https://aihot.news)', config.notify))
        return json(res, 200, r)
      }
      return json(res, 404, { error: 'not-found' })
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  })
  server.on('error', (err) => logger?.warn?.(`本地桥接端口 ${port} 不可用（${err.code || err.message}），面板将回落 aihot_radar_status`))
  server.listen(port, '127.0.0.1', () => logger?.debug?.(`本地桥接已监听 127.0.0.1:${port}`))
  return () => { try { server.close() } catch { /* already closed */ } }
}
