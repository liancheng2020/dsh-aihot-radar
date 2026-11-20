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
> - **免 Key、零运行时依赖**：纯 JS，不装 Python/Go、不填 API Key；数据来自 [AIHOT](https://aihot.news) 公开匿名 API。
> - 装完**重启一次** DSH，**AIHOT 雷达**面板即生效；不配推送也能用，资讯工具与面板照常工作。
> - 要推送就在面板「推送配置」里选通道、粘地址、点「保存并发送测试」，即时生效。**后台提醒需要 DSH 保持运行**，且测试成功只说明通道连通。

**面板，装完就是这样**（左：额度雷达 · 右：今日日报；推送配置见下文）

| 额度雷达 | 今日日报 |
|---|---|
| ![额度雷达面板：来源状态、待生效预告、最近事件与资讯工具](assets/panel-radar.png) | ![今日日报面板：AIHOT 日报正文与日期翻页](assets/panel-daily.png) |

## 它做什么

- **额度重置提醒（核心）**：后台轮询 AIHOT 重置监控，出现新的**预告**或**到账**即推到你的 webhook，推断态会标明「未经确认」。首次配置静默跳过历史「已到账」，首条卡片就是新事件；失败最多重试 5 次，超时只记「送达不确定」、不重发——宁可漏一条，也不让群里收到两条。
- **7 个资讯工具**：对话里直接问「今天 AI 圈发生了什么」「Claude 额度重置了吗」，Agent 调 `aihot_*` 工具拿 AIHOT 整理好的中文回答。
- **AI 日报（可选）**：按 `digest.timezone`（默认北京时间）定时拉日报，推送并本地归档，面板可开关与改时间。超长自动分条，重试只补未送达的段；送达不确定当天不再自动重发。
- **面板**：实时看待生效预告、最近事件、工具清单，并直接配置通道与日报，同时显示 AIHOT 核对时间与监控状态。

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
dsh plugin --profile web add https://github.com/liancheng2020/dsh-aihot-radar/releases/download/v0.4.2/dsh-aihot-radar-0.4.2.tgz
```
装完重启 DSH，出现 **AIHOT 雷达** 面板即生效。

> 当前版本 `0.4.2`（见 [CHANGELOG](CHANGELOG.md)）。npm 包与 Release `.tgz` 同源，`npm view dsh-aihot-radar version` 可确认已发布版本。

## 配置推送（可选）

**面板（推荐）**：**AIHOT 雷达** → 「推送配置」→ 选通道、粘地址 → **保存并发送测试**。保存即生效，**无需重启**。

![推送配置面板：通道摘要与每日 AI 日报](assets/panel-push.png)

- 数据来自 **[AIHOT](https://aihot.news)** 公开接口，插件只做整理与转发；提醒是**后台任务**，关掉 DSH 就停止轮询与推送。
- **「测试推送成功」只代表通道连通**（当时的 URL、机器人、权限可用），不代表之后每条提醒都送达——断网、机器人被移除、DSH 退出都会让提醒停在本地。
- **每日 AI 日报**在同一区块：开关 + 发送时间（半小时预设，也可手输），**默认关闭**，保存后立即重排定时器；「发送测试日报」走真实日报的完整链路（含分条），不顶掉当天真正的推送。

**通道**：`wecom`（企微机器人 URL）· `dingtalk`（URL + 可选加签密钥）· `feishu`（URL）· `bark`（`https://api.day.app/<key>`）· `serverchan`（`https://sctapi.ftqq.com/<key>.send`）· `telegram`（url 填 Bot Token，secret 填 chat_id）· `generic`（任意 JSON POST）· `none`（默认，不推送）。

**手改配置**：通道写 `$DSH_HOME/aihot-radar/state.json`（默认 `~/.dsh/aihot-radar/state.json`，**只动 `webhook` 字段**；`seen`、`digest`、`delivery` 由插件维护，整文件覆盖会丢失去重与日报进度）；其余非敏感项写 profile 的 `cordis.patch.yml`。改完重启 DSH。

```json
{ "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" } }
```

```yaml
- id: aihot-radar
  name: dsh-aihot-radar
  config:
    radar:
      enabled: true                           # 关掉即停止后台推送，工具与面板仍可用
      providers: [codex, claude, antigravity]
      pollSeconds: 600                        # 最小 60；AIHOT 建议 ≤10 分钟一次（默认即 10 分钟）
      quiet: { start: "", end: "" }           # 免打扰时段，如 "23:00"–"08:00"；空 = 关闭
      muted: []                               # 按来源静音，如 [antigravity]
    digest:
      enabled: false                          # 默认关；面板里打开后以面板为准
      time: "08:30"                           # 非法值回落 08:30
      timezone: Asia/Shanghai
      catchUp: false                          # 启动时若今天已过点且未推送，补发一次
    notify:
      signatureText: ""                       # 自定义尾注：唯一能开启尾注的配置，留空 = 不加
      # signature: false                      # 想临时关掉上面的尾注时再取消注释
```

- **免打扰 / 静音 / 预告开关**：免打扰期间推送顺延不丢，静音来源解锁后不补刷旧事件；`radar.notifyAnnounced`、`radar.notifyConfirmed` 默认都开。
- **尾注**：没有内置推广尾注（不附安装链接），只有 `notify.signatureText` 会追加一行、`signature: false` 可关掉它，旧面板的勾选记录已失效。品牌始终在**标题**里（`AIHOT 雷达 · Codex 额度重置（预告）`）。
- **长内容自动分条**：企微 ≤3900 字节、Telegram ≤3800 字符，按行切、不截断中文，并校验回执业务码（HTTP 200 但业务失败仍算失败）。
- **多实例不重复推送**：桌面与 Web 共用 `DSH_HOME` 时同一事件、同一期日报只发一次；失败与「送达不确定」记在 `state.json` 的 `delivery`，`/status` 与 `aihot_radar_status` 可见。
- **日报不会被「配了 webhook」自动打开**；宿主晚于设定时间启动默认不补发，`catchUp: true` 可补一次；面板显示上次与下次推送时间。
- **桥接**只绑定 `127.0.0.1:17420`，不暴露 url/secret，`localApi.enabled: false` 可关闭。**不想推送**：`radar.enabled: false`（工具与面板仍可用）；**卸载**：从 profile 移除该插件行并重启 DSH。

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

同作者另一插件：[余额哨兵](https://github.com/liancheng2020/dsh-balance-sentinel)（DeepSeek 余额监控，低余额告警推送到飞书 / 钉钉）。