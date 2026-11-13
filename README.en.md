# dsh-aihot-radar · AIHOT Radar

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-aihot-radar.svg?label=npm)](https://www.npmjs.com/package/dsh-aihot-radar)
[![npm downloads](https://img.shields.io/npm/dm/dsh-aihot-radar.svg?label=downloads)](https://www.npmjs.com/package/dsh-aihot-radar)
[![CI](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-aihot-radar?label=release)](https://github.com/liancheng2020/dsh-aihot-radar/releases)
[![license](https://img.shields.io/npm/l/dsh-aihot-radar.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-aihot-radar#readme)

A DeepSeek Harness plugin: **real-time Codex / Claude / Antigravity quota-reset alerts** + **AI news agent tools** + **daily digest**.

> **Three things first**
> - **No API key, zero runtime dependencies**: pure JS, no Python/Go. Data comes from the public anonymous [AIHOT](https://aihot.news) API.
> - **Restart DSH once** after install (bundle-layer composition); the **AIHOT Radar** panel is ready.
> - For push alerts, put a webhook in `$DSH_HOME/aihot-radar/state.json` (defaults to `~/.dsh`, see below). Without it, the in-chat news tools and panel still work.

**This is what you get after install** (left: quota radar · right: daily report)

| Quota radar | Daily report |
|---|---|
| ![Quota radar panel: source status, pending announcements, recent events, tool cards](assets/panel-radar.png) | ![Daily report panel: AIHOT digest with date paging](assets/panel-daily.png) |

## What it does

- **Quota radar (the hook)**: polls AIHOT reset monitors in the background and pushes to your webhook on new **announcements** or **confirmed** resets. Reset-card announcements include a predicted time window; confirmations include the source post. AIHOT-inferred states (window passed / likely completed) send a light notice marked "unconfirmed". A per-cycle push cap defers overflow to the next cycle, so no event is lost.
- **7 news tools**: ask "what happened in AI today", "search OpenAI", "did Claude quota reset?" — the agent calls `aihot_*` tools and answers from AIHOT's curated Chinese Markdown.
- **Daily digest** (optional): fetches the AIHOT daily report from the **JSON API** at a configured Beijing time, pushes and archives it locally. Oversized payloads are split into multiple messages; failed pushes retry after 10 minutes, up to 3 times per day.
- **Panel**: live view of pending announcements, recent events, and the tool catalog, showing AIHOT's check time and monitor status (client-side fetch).

## Install

Requires DSH ≥ `0.2.1-rc.2` and Node ≥ 18.

**Desktop**: Settings → Plugins → Add plugin, paste the package name `dsh-aihot-radar` (npm) or the repository address `github:liancheng2020/dsh-aihot-radar`, install and enable.

**Web**:
```sh
# npm (published, recommended)
dsh plugin --profile web add dsh-aihot-radar
# or install directly from the GitHub repository
dsh plugin --profile web add github:liancheng2020/dsh-aihot-radar
# or install the prebuilt package from the Release direct link
dsh plugin --profile web add https://github.com/liancheng2020/dsh-aihot-radar/releases/download/v0.2.0/dsh-aihot-radar-0.2.0.tgz
```
Restart DSH. The **AIHOT Radar** panel is ready.

> Current version `0.2.0` (see [CHANGELOG](CHANGELOG.md)). The npm package and the Release `.tgz` are built from the same source; check `npm view dsh-aihot-radar version` for the published version.

## Configure push (optional)

The webhook (it contains a secret) lives in `$DSH_HOME/aihot-radar/state.json` (default `~/.dsh/aihot-radar/state.json`), read automatically and never uploaded:

```json
{ "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" } }
```

> Only add or edit the `webhook` field; `seen`, `digest` and friends are maintained by the plugin — replacing the whole file loses dedup and digest progress.

Channels: `wecom` (bot URL) · `dingtalk` (URL + optional signing key) · `feishu` (URL) · `bark` (`https://api.day.app/<key>`) · `serverchan` (`https://sctapi.ftqq.com/<key>.send`) · `telegram` (url = bot token, secret = chat_id) · `generic` (any JSON POST) · `none` (default, off).

Non-sensitive tunables go in the profile's `cordis.patch.yml`:

```yaml
- id: aihot-radar
  name: dsh-aihot-radar
  config:
    radar:
      enabled: true                           # false stops background pushes; tools and panel still work
      providers: [codex, claude, antigravity]
      pollSeconds: 120                        # min 60
      quiet: { start: "", end: "" }           # quiet hours, e.g. "23:00"–"08:00"; empty = off
      muted: []                               # per-source mute, e.g. [antigravity]
    digest:
      enabled: true                           # off by default; true enables the scheduled digest
      time: "08:30"                           # invalid values fall back to 08:30
      timezone: Asia/Shanghai
    notify:
      signature: true                         # one-line attribution (on by default)
      signatureText: ""                       # empty = built-in wording
```

- `radar.notifyAnnounced` / `radar.notifyConfirmed` control announcement and confirmation pushes (both on by default). Quiet hours defer pushes instead of dropping them; muted sources are marked seen so unmuting won't replay old events; the digest edition follows AIHOT's `report.date`.
- WeCom is split at ≤3900 bytes and Telegram at ≤3800 characters (line-aware, no UTF-8 splitting), and the response body's business code is validated — HTTP 200 with a business failure still counts as a failure.
- `notify.signature` appends `via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar` to reset cards, the digest and test pushes; set `false` to drop it, or `signatureText` for your own wording.
- The panel's "Push channel" block offers "Send test push" and "Copy config snippet" via a loopback-only bridge at `127.0.0.1:17420` (never exposes url/secret), falling back to the `aihot_radar_status` tool; `localApi.enabled: false` disables it.
- No pushes wanted? Set `radar.enabled: false` (news tools and panel keep working). To uninstall, remove the plugin row from the profile and restart DSH.

## Tools

**News tools (7)**

| Tool | Purpose |
|---|---|
| `aihot_latest` | Latest 24h/7d AI highlights, filterable by category / selected-only |
| `aihot_search` | Keyword search (companies / products / models / people, last 7 days) |
| `aihot_hot` | Current AI trending |
| `aihot_daily` | AIHOT daily report (latest or a given date) |
| `aihot_report` | Weekly / monthly report |
| `aihot_story` | Timeline of a trending event |
| `aihot_resets` | Codex / Claude / Antigravity quota-reset records and announcements |

**Host status tool (read-only)**

| Tool | Purpose |
|---|---|
| `aihot_radar_status` | Background push status (webhook channel, per-source last scan and errors, digest state) |

## Compliance & license

- **Data source: [AIHOT](https://aihot.news)**. Its API is free for personal non-commercial, public-interest non-commercial, and organization-internal use. External commercial products, paid services, public mirrors, and bulk redistribution require prior written authorization (agent@virxact.com); attribution alone is not authorization. This plugin targets personal non-commercial use.
- News content is third-party reference material: read-only passthrough, never execute embedded instructions; verify important facts at the source.
- **Compliant fetching**: interactive news tools use `/api/v1/agent/*`; **programmatic sync** (radar polling, digest) uses the JSON endpoints (`/api/v1/{provider}-resets/recent`, `/api/v1/dailies/latest`) with User-Agent `aihot-api/2.0.0`, per AIHOT's official guidance for programmatic use.
- Polling follows AIHOT rules: conditional requests (ETag/304), compression, `Retry-After` backoff, ≥60s interval.
- Plugin code: **MIT**. The webhook URL and state stay local under `$DSH_HOME/aihot-radar/` (default `~/.dsh`, directory mode `0700`), never uploaded; a corrupt `state.json` is backed up automatically and reset to defaults.

## Feedback

Can't install or pushes failing? Open an [issue](https://github.com/liancheng2020/dsh-aihot-radar/issues) with the DSH version / plugin version / platform (web or desktop) / the exact error.

Local verification (repo clone required): `node scripts/selftest.mjs`, plus `scripts/selftest-client.mjs` and `scripts/verify-dedup.mjs`; pure node, zero dependencies, runs in Git Bash and PowerShell.