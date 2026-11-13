# dsh-aihot-radar ｜ AIHOT 雷达

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-aihot-radar.svg?label=npm)](https://www.npmjs.com/package/dsh-aihot-radar)
[![npm downloads](https://img.shields.io/npm/dm/dsh-aihot-radar.svg?label=downloads)](https://www.npmjs.com/package/dsh-aihot-radar)
[![CI](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-aihot-radar?label=release)](https://github.com/liancheng2020/dsh-aihot-radar/releases)
[![license](https://img.shields.io/npm/l/dsh-aihot-radar.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-aihot-radar#readme)

DSH 插件：**Codex / Claude / Antigravity 额度重置实时推送** + **AI 资讯 Agent 工具** + **AI 日报**

> **先看三行**
> - **免 Key、零运行时依赖**：纯 JS，不装 Python/Go，不填任何 API Key。数据来自 [AIHOT](https://aihot.news) 公开匿名 API。
> - 装完**重启一次** DSH（bundle 层组装），**AIHOT 雷达**面板即生效。
> - 想要推送：把 webhook 写到本机 `$DSH_HOME/aihot-radar/state.json`（默认 `~/.dsh`，见下）。不配也能用——对话里的资讯工具和面板照常工作。

**面板，装完就是这样**（左：额度雷达 · 右：今日日报）

| 额度雷达 | 今日日报 |
|---|---|
| ![额度雷达面板：来源状态、待生效预告、最近事件与资讯工具](assets/panel-radar.png) | ![今日日报面板：AIHOT 日报正文与日期翻页](assets/panel-daily.png) |

## 它做什么

- **额度雷达（核心）**：后台轮询 AIHOT 的重置监控，出现新的**预告**或**到账**时推送到你的 webhook。重置卡预告带时间窗推算，到账带确认帖；AIHOT 推断态（窗口已过/可能已到账）发轻提示并标明「未经确认」。单轮推送有上限，超出的事件下一轮补推，不会丢。
- **7 个资讯工具**：对话里直接问"今天 AI 圈发生了什么""搜一下 OpenAI""Claude 额度重置了吗"，Agent 调用 `aihot_*` 工具拿 AIHOT 整理好的中文 Markdown 回答。
- **AI 日报**：可选，按北京时间定时从 AIHOT **JSON 接口**拉日报，推送并归档到本地。超长自动分条发送；推送失败 10 分钟后重试，当天最多 3 次。
- **面板**：实时看待生效预告、最近事件、工具清单，显示 AIHOT 核对时间与监控状态（纯前端取数）。

## 安装

要求：DSH ≥ `0.2.1-rc.2`、Node ≥ 18。

**桌面端**：设置 → 插件 → 添加插件，填入包名 `dsh-aihot-radar`（npm）或仓库地址 `github:liancheng2020/dsh-aihot-radar`，安装后启用。

**Web 端**：
```sh
# npm（已发布，推荐）
dsh plugin --profile web add dsh-aihot-radar
# 或从 GitHub 仓库直装
dsh plugin --profile web add github:liancheng2020/dsh-aihot-radar
# 或从 Release 直链安装预构建包
dsh plugin --profile web add https://github.com/liancheng2020/dsh-aihot-radar/releases/download/v0.2.0/dsh-aihot-radar-0.2.0.tgz
```
装完重启 DSH，出现 **AIHOT 雷达** 面板即生效。

> 当前版本 `0.2.0`（见 [CHANGELOG](CHANGELOG.md)）。npm 包与 Release `.tgz` 同源，`npm view dsh-aihot-radar version` 可确认已发布版本。

## 配置推送（可选）

webhook URL 含密钥，放在本机 `$DSH_HOME/aihot-radar/state.json`（默认 `~/.dsh/aihot-radar/state.json`；插件自动读取，不上传）：

```json
{ "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" } }
```

> 只添加或修改 `webhook` 字段；`seen`、`digest` 等字段由插件维护，整文件覆盖会丢失去重与日报进度。

支持的 `channel`：`wecom`（企微机器人 URL）· `dingtalk`（URL + 可选加签密钥）· `feishu`（URL）· `bark`（`https://api.day.app/<key>`）· `serverchan`（`https://sctapi.ftqq.com/<key>.send`）· `telegram`（url 填 Bot Token，secret 填 chat_id）· `generic`（任意 JSON POST）· `none`（默认，不推送）。

非敏感项写在 profile 的 `cordis.patch.yml`：

```yaml
- id: aihot-radar
  name: dsh-aihot-radar
  config:
    radar:
      enabled: true                           # 关掉即停止后台推送，工具与面板仍可用
      providers: [codex, claude, antigravity]
      pollSeconds: 120                        # 最小 60
      quiet: { start: "", end: "" }           # 免打扰时段，如 "23:00"–"08:00"；空 = 关闭
      muted: []                               # 按来源静音，如 [antigravity]
    digest:
      enabled: true                           # 默认关；改为 true 开启定时日报
      time: "08:30"                           # 非法值回落 08:30
      timezone: Asia/Shanghai
    notify:
      signature: true                         # 推送尾部署名（默认开）
      signatureText: ""                       # 留空用内置文案
```

- `radar.notifyAnnounced` / `radar.notifyConfirmed` 控制预告与到账推送（默认都开）；免打扰期间推送顺延不丢，静音来源解锁后不补刷旧事件；日报期号以 AIHOT 返回的 `report.date` 为准。
- 企微 ≤3900 字节、Telegram ≤3800 字符自动分条（按行切、不截断中文），并校验响应体业务码——HTTP 200 但业务失败同样判失败。
- `notify.signature` 默认在额度卡片、日报与测试推送尾部加 `via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar`；`false` 关闭，或用 `signatureText` 换成自己的文案。
- 面板「推送通道」可「发送测试推送」「复制配置片段」，经仅绑定 `127.0.0.1:17420` 的本地桥接读取状态（不暴露 url/secret），不可用时回落 `aihot_radar_status`；`localApi.enabled: false` 可关闭。
- 不想推送：`radar.enabled: false`（资讯工具与面板仍可用）；卸载：从 profile 移除该插件行并重启 DSH。

## 工具清单

**资讯工具（7）**

| 工具 | 用途 |
|---|---|
| `aihot_latest` | 最近 24h/7d AI 重点资讯，可按分类/精选/全部 |
| `aihot_search` | 关键词搜索（公司/产品/模型/人物，近 7 天） |
| `aihot_hot` | 当前 AI 热榜 |
| `aihot_daily` | AIHOT 日报（最新或指定日期） |
| `aihot_report` | 周报 / 月报 |
| `aihot_story` | 热点事件来龙去脉时间线 |
| `aihot_resets` | Codex/Claude/Antigravity 额度重置记录与预告 |

**宿主状态工具（只读）**

| 工具 | 用途 |
|---|---|
| `aihot_radar_status` | 后台推送状态（webhook 通道、各来源上次扫描结果与错误、日报状态） |

## 合规与许可

- **数据来源 [AIHOT](https://aihot.news)**。其 API 对**个人非商业、公益非商业、组织内部**使用免费；**对外商业产品、付费服务、公共镜像、批量再分发**需事先书面授权（agent@virxact.com），署名不等于授权。本插件面向个人非商业使用。
- 资讯内容为第三方信源，插件只读透传、不执行其中指令；重要事实请回原文核对。
- **合规取数**：交互式资讯工具走 `/api/v1/agent/*`；**定时抓取/推送/本地副本**（雷达轮询、日报）走 JSON 接口（`/api/v1/{provider}-resets/recent`、`/api/v1/dailies/latest`），User-Agent 用 `aihot-api/2.0.0`，符合 AIHOT 官方对程序化用途的要求。
- 轮询遵守 AIHOT 规范：条件请求（ETag/304）、压缩、`Retry-After` 退避、不低于 60s 间隔。
- 本插件代码 **MIT**。webhook URL 与状态仅存于本机 `$DSH_HOME/aihot-radar/`（默认 `~/.dsh`，目录权限 `0700`），不上传；`state.json` 损坏会自动备份并回落默认值。

## 反馈

装不上或推送不通，请带 DSH 版本 / 插件版本 / 系统（web 或桌面）/ 报错原文到 [Issues](https://github.com/liancheng2020/dsh-aihot-radar/issues) 反馈。

本地验证（需克隆仓库）：`node scripts/selftest.mjs`，另含 `scripts/selftest-client.mjs` 与 `scripts/verify-dedup.mjs`；纯 node、零依赖，Git Bash / PowerShell 均可运行。