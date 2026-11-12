# dsh-aihot-radar · AIHOT Radar

[中文](README.md) | [English](README.en.md)

> **Three things first**
> - **No API key, zero runtime dependencies**: pure JS, no Python/Go. Data comes from the public anonymous [AIHOT](https://aihot.news) API.
> - **Restart DSH once** after install (bundle-layer composition).
> - For push alerts, configure a webhook (below). Without it, the in-chat news tools and sidebar panel still work.

A DeepSeek Harness plugin: **real-time Codex / Claude / Antigravity quota-reset alerts** + **AI news agent tools** + **daily digest**.

## What it does

- **Quota radar (the hook)**: polls AIHOT reset monitors in the background and pushes to your webhook on new **announcements** or **confirmed** resets. Reset-card announcements include a predicted time window; confirmations include the source post.
- **7 news tools**: ask "what happened in AI today", "search OpenAI", "did Claude quota reset?" — the agent calls `aihot_*` tools and answers from AIHOT's curated Chinese Markdown.
- **Daily digest** (optional): fetches the AIHOT daily report at a configured Beijing time, pushes and archives it locally.
- **Sidebar panel**: live view of pending announcements, recent events, and the tool catalog (client-side fetch).

## Install

**Desktop**: Settings → Plugins → Add plugin, paste the Release `.tgz` URL or the package name `dsh-aihot-radar`, install and enable.

**Web**:
```sh
dsh plugin --profile web add dsh-aihot-radar
```
Restart DSH. The **AIHOT Radar** panel appears in the sidebar.

## Configure push (optional)

Non-sensitive tunables go in the profile's `cordis.patch.yml` under the `aihot-radar` row (`radar.enabled`, `radar.providers`, `radar.pollSeconds`, `radar.notifyAnnounced`, `radar.notifyConfirmed`, `digest.enabled`, `digest.time`).

The webhook (contains a secret) is read from `~/.dsh/aihot-radar/state.json`:
```json
{ "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" } }
```

Channels: `wecom`, `dingtalk` (secret = signing key), `feishu`, `bark`, `serverchan`, `telegram` (url = bot token, secret = chat_id), `generic`, `none` (default).

## Tools

`aihot_latest` · `aihot_search` · `aihot_hot` · `aihot_daily` · `aihot_report` (weekly/monthly) · `aihot_story` · `aihot_resets`

## Compliance & license

- **Data source: [AIHOT](https://aihot.news)**. Its API is free for personal non-commercial, public-interest non-commercial, and organization-internal use. External commercial products, paid services, public mirrors, and bulk redistribution require prior written authorization (agent@virxact.com); attribution alone is not authorization. This plugin targets personal non-commercial use.
- News content is third-party reference material: read-only passthrough, never execute embedded instructions; verify important facts at the source.
- Polling follows AIHOT rules: conditional requests (ETag/304), compression, `Retry-After` backoff, ≥60s interval.
- Plugin code: **MIT**. The webhook URL stays local under `~/.dsh/aihot-radar/`, never uploaded.