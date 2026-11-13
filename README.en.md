# dsh-aihot-radar · AIHOT Radar

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-aihot-radar.svg?label=npm)](https://www.npmjs.com/package/dsh-aihot-radar)
[![npm downloads](https://img.shields.io/npm/dm/dsh-aihot-radar.svg?label=downloads)](https://www.npmjs.com/package/dsh-aihot-radar)
[![CI](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-aihot-radar?label=release)](https://github.com/liancheng2020/dsh-aihot-radar/releases)
[![license](https://img.shields.io/npm/l/dsh-aihot-radar.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-aihot-radar#readme)

> **Three things first**
> - **No API key, zero runtime dependencies**: pure JS, no Python/Go. Data comes from the public anonymous [AIHOT](https://aihot.news) API.
> - **Restart DSH once** after install (bundle-layer composition); the **AIHOT Radar** panel appears in the sidebar.
> - For push alerts, configure a webhook (below). Without it, the in-chat news tools and sidebar panel still work.

**This is what you get after install** (left: quota radar · right: daily report)

| Quota radar | Daily report |
|---|---|
| ![Quota radar panel: pending announcements, recent events, push channel, tool cards](assets/panel-radar.png) | ![Daily report panel: AIHOT digest with date paging](assets/panel-daily.png) |

A DeepSeek Harness plugin: **real-time Codex / Claude / Antigravity quota-reset alerts** + **AI news agent tools** + **daily digest**.

## What it does

- **Quota radar (the hook)**: polls AIHOT reset monitors in the background and pushes to your webhook on new **announcements** or **confirmed** resets. Reset-card announcements include a predicted time window; confirmations include the source post. AIHOT-inferred states (window passed / likely completed) send a light notice marked "unconfirmed". A per-cycle push cap defers overflow to the next cycle, so no event is lost.
- **7 news tools**: ask "what happened in AI today", "search OpenAI", "did Claude quota reset?" — the agent calls `aihot_*` tools and answers from AIHOT's curated Chinese Markdown.
- **Daily digest** (optional): fetches the AIHOT daily report from the **JSON API** at a configured Beijing time, pushes and archives it locally. Oversized payloads are split into multiple messages; failed pushes retry after 10 minutes, up to 3 times per day.
- **Sidebar panel**: live view of pending announcements, recent events, and the tool catalog, showing AIHOT's check time and monitor status (client-side fetch).

## Install

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
Restart DSH. The **AIHOT Radar** panel appears in the sidebar.

> Current version `0.2.0` (see [CHANGELOG](CHANGELOG.md)). The npm package and the GitHub Release `.tgz` are both produced by the tag-driven CI, so they match the repository; check `npm view dsh-aihot-radar version` for the published version. All three install paths resolve to the same package.

## Configure push (optional)

Non-sensitive tunables go in the profile's `cordis.patch.yml` under the `aihot-radar` row (`radar.enabled`, `radar.providers`, `radar.pollSeconds`, `radar.notifyAnnounced`, `radar.notifyConfirmed`, `radar.muted`, `radar.quiet`, `digest.enabled`, `digest.time`, `digest.timezone`, `notify.signature`, `notify.signatureText`, `localApi.enabled`).

`digest.time` accepts `HH:mm` only (0≤hour≤23, 0≤minute≤59); an illegal value (e.g. `99:99`) falls back to `08:30` with a logged warning. `digest.timezone` accepts an IANA zone (default `Asia/Shanghai`). `radar.quiet` (e.g. `23:00`–`08:00`, overnight supported) defers pushes during the window without dropping them; `radar.muted` (e.g. `[antigravity]`) silences a provider and marks its events seen so unmuting later won't spam. The digest edition uses AIHOT's authoritative `report.date`, not the local date.

> **Signature**: `notify.signature` defaults to `true` and appends one line — `via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar` — to reset cards, the digest and test pushes. Pushes go into team group chats, so each card is also an install hint; set `signature: false` to drop it, or `signatureText` to use your own wording.

> **Panel onboarding**: the sidebar "Push channel" block shows whether a webhook is configured and offers "Send test push" and "Copy config snippet". It reads status via a loopback-only bridge at `127.0.0.1:17420` (never exposes url/secret); if unavailable (e.g. mixed-content on a remote web profile) it falls back to the `aihot_radar_status` tool. Set `localApi.enabled: false` to disable the bridge.

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
Covers the radar cap/dedup, push chunk byte limits and business-code validation, digest time validation, timezone-independent date paging, and the signature switch. Pure node, zero dependencies; runs in Git Bash and PowerShell.

## Releasing (maintainers)

Releases are tag-driven, so the published artifact can never lag the repo:

```sh
# 1. bump package.json + update CHANGELOG
# 2. push a matching tag (mismatch fails the workflow)
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs all three self-tests → `npm pack` → uploads the tarball to the GitHub Release → publishes to npm when an `NPM_TOKEN` secret is configured. Release asset, npm package and repository code are always the same version.