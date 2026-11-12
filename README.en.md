# dsh-aihot-radar · AIHOT Radar

[中文](README.md) | [English](README.en.md)

> **Three things first**
> - **No API key, zero runtime dependencies**: pure JS, no Python/Go. Data comes from the public anonymous [AIHOT](https://aihot.news) API.
> - **Restart DSH once** after install (bundle-layer composition).
> - For push alerts, configure a webhook (below). Without it, the in-chat news tools and sidebar panel still work.

A DeepSeek Harness plugin: **real-time Codex / Claude / Antigravity quota-reset alerts** + **AI news agent tools** + **daily digest**.

## What it does

- **Quota radar (the hook)**: polls AIHOT reset monitors in the background and pushes to your webhook on new **announcements** or **confirmed** resets. Reset-card announcements include a predicted time window; confirmations include the source post. AIHOT-inferred states (window passed / likely completed) send a light notice marked "unconfirmed". A per-cycle push cap defers overflow to the next cycle, so no event is lost.
- **7 news tools**: ask "what happened in AI today", "search OpenAI", "did Claude quota reset?" — the agent calls `aihot_*` tools and answers from AIHOT's curated Chinese Markdown.
- **Daily digest** (optional): fetches the AIHOT daily report from the **JSON API** at a configured Beijing time, pushes and archives it locally. Oversized payloads are split into multiple messages; failed pushes retry after 10 minutes, up to 3 times per day.
- **Sidebar panel**: live view of pending announcements, recent events, and the tool catalog, showing AIHOT's check time and monitor status (client-side fetch).

## Install

**Desktop**: Settings → Plugins → Add plugin, paste the Release `.tgz` URL or the package name `dsh-aihot-radar`, install and enable.

**Web**:
```sh
dsh plugin --profile web add dsh-aihot-radar
```
Restart DSH. The **AIHOT Radar** panel appears in the sidebar.

## Configure push (optional)

Non-sensitive tunables go in the profile's `cordis.patch.yml` under the `aihot-radar` row (`radar.enabled`, `radar.providers`, `radar.pollSeconds`, `radar.notifyAnnounced`, `radar.notifyConfirmed`, `digest.enabled`, `digest.time`).

`digest.time` accepts `HH:mm` only (0≤hour≤23, 0≤minute≤59); an illegal value (e.g. `99:99`) falls back to `08:30` with a logged warning. The digest edition uses AIHOT's authoritative `report.date`, not the local date.

The webhook (contains a secret) is read from `~/.dsh/aihot-radar/state.json`:
```json
{ "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" } }
```

Channels: `wecom`, `dingtalk` (secret = signing key), `feishu`, `bark`, `serverchan`, `telegram` (url = bot token, secret = chat_id), `generic`, `none` (default).

> **Chunking**: WeCom payloads are split at ≤3900 bytes and Telegram at ≤3800 characters (line-aware, never cutting a UTF-8 character); the first message carries the title, later ones a "(cont. i/n)" prefix. Other channels are not split. The response body's business code is validated (WeCom/DingTalk `errcode`, Feishu `code`/`StatusCode`, ServerChan `code`, Telegram `ok`), so HTTP 200 with a business failure is treated as a failure.

## Tools

`aihot_latest` · `aihot_search` · `aihot_hot` · `aihot_daily` · `aihot_report` (weekly/monthly) · `aihot_story` · `aihot_resets` · `aihot_radar_status` (read-only host push status)

## Compliance & license

- **Data source: [AIHOT](https://aihot.news)**. Its API is free for personal non-commercial, public-interest non-commercial, and organization-internal use. External commercial products, paid services, public mirrors, and bulk redistribution require prior written authorization (agent@virxact.com); attribution alone is not authorization. This plugin targets personal non-commercial use.
- News content is third-party reference material: read-only passthrough, never execute embedded instructions; verify important facts at the source.
- **Compliant fetching**: interactive news tools use `/api/v1/agent/*`; **programmatic sync** (radar polling, digest) uses the JSON endpoints (`/api/v1/{provider}-resets/recent`, `/api/v1/dailies/latest`) with User-Agent `aihot-api/2.0.0`, per AIHOT's official guidance for programmatic use.
- Polling follows AIHOT rules: conditional requests (ETag/304), compression, `Retry-After` backoff, ≥60s interval.
- Plugin code: **MIT**. The webhook URL and state stay local under `~/.dsh/aihot-radar/` (directory mode `0700`), never uploaded; a corrupt `state.json` is backed up automatically and reset to defaults.

## Self-test

```sh
node scripts/selftest.mjs   # or: npm run selftest
```
Covers the radar cap/dedup, push chunk byte limits and business-code validation, digest time validation, and timezone-independent date paging. Pure node, zero dependencies; runs in Git Bash and PowerShell.