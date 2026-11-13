# dsh-aihot-radar ｜ AIHOT 雷达

[中文](README.md) | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-aihot-radar.svg?label=npm)](https://www.npmjs.com/package/dsh-aihot-radar)
[![npm downloads](https://img.shields.io/npm/dm/dsh-aihot-radar.svg?label=downloads)](https://www.npmjs.com/package/dsh-aihot-radar)
[![CI](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/liancheng2020/dsh-aihot-radar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liancheng2020/dsh-aihot-radar?label=release)](https://github.com/liancheng2020/dsh-aihot-radar/releases)
[![license](https://img.shields.io/npm/l/dsh-aihot-radar.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](https://github.com/liancheng2020/dsh-aihot-radar#readme)

> **先看三行**
> - **免 Key、零运行时依赖**：纯 JS，不装 Python/Go，不填任何 API Key。数据来自 [AIHOT](https://aihot.news) 公开匿名 API。
> - 装完**重启一次** DSH（bundle 层组装），侧边栏即出现 **AIHOT 雷达** 面板。
> - 想要推送：在 profile 的 `cordis.patch.yml` 给本插件配一个 webhook（见下）。不配也能用——对话里的资讯工具和侧边栏面板照常工作。

**侧边栏面板，装完就是这样**（左：额度雷达 · 右：今日日报）

| 额度雷达 | 今日日报 |
|---|---|
| ![额度雷达面板：待生效预告、最近事件、推送通道与工具卡片](assets/panel-radar.png) | ![今日日报面板：AIHOT 日报正文与日期翻页](assets/panel-daily.png) |

DSH 插件：**Codex / Claude / Antigravity 额度重置实时推送** + **AI 资讯 Agent 工具** + **AI 日报**

## 它做什么

- **额度雷达（核心）**：后台轮询 AIHOT 的重置监控，出现新的**预告**或**到账**时推送到你的 webhook。重置卡预告带时间窗推算，到账带确认帖；AIHOT 推断态（窗口已过/可能已到账）发轻提示并标明「未经确认」。单轮推送有上限，超出的事件下一轮补推，不会丢。
- **7 个资讯工具**：对话里直接问"今天 AI 圈发生了什么""搜一下 OpenAI""Claude 额度重置了吗"，Agent 调用 `aihot_*` 工具拿 AIHOT 整理好的中文 Markdown 回答。
- **AI 日报**：可选，按北京时间定时从 AIHOT **JSON 接口**拉日报，推送并归档到本地。超长自动分条发送；推送失败 10 分钟后重试，当天最多 3 次。
- **侧边栏面板**：实时看待生效预告、最近事件、工具清单，显示 AIHOT 核对时间与监控状态（纯前端取数）。

## 安装

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
装完重启 DSH，侧边栏出现 **AIHOT 雷达** 面板即生效。

> 当前版本 `0.2.0`（见 [CHANGELOG](CHANGELOG.md)）。npm 包与 GitHub Release 的 `.tgz` 都由打 tag 的 CI 生成，与仓库内容同源；`npm view dsh-aihot-radar version` 可确认已发布版本。三行都指向同一个包，装哪个都行。

## 配置推送（可选）

编辑 profile 的 `cordis.patch.yml`，给 `aihot-radar` 行加 `config`。webhook URL 含密钥，建议放在本机 `~/.dsh/aihot-radar/state.json` 的 `webhook` 字段（插件自动读取），或在 patch 里配置非敏感项：

```yaml
- id: aihot-radar
  name: dsh-aihot-radar
  config:
    radar:
      enabled: true
      providers: [codex, claude, antigravity]
      pollSeconds: 120          # 轮询间隔，最小 60
      notifyAnnounced: true     # 预告时推送
      notifyConfirmed: true     # 到账时推送
      muted: []                 # 按来源静音，如 [antigravity]；解除后不补刷旧事件
      quiet: { start: "", end: "" }  # 免打扰时段（时区同 digest.timezone），如 23:00–08:00；空=关闭，期间推送顺延不丢
    digest:
      enabled: true             # 开启 AI 日报
      time: "08:30"             # 触发时间，合法范围 00:00–23:59；非法值回落 08:30
      timezone: Asia/Shanghai   # IANA 时区，非法值回落 Asia/Shanghai
    notify:
      signature: true           # 推送卡片尾部加一行轻量署名（默认开）
      signatureText: ""         # 自定义署名；留空用内置「via AIHOT 雷达 · 安装：…」
```

> `digest.time` 只接受 `HH:mm`（0≤时≤23、0≤分≤59），写错（如 `99:99`）会回落 `08:30` 并在日志告警。日报期号以 AIHOT 返回的 `report.date` 为准，不用本机日期猜测。`digest.timezone` 接受 IANA 时区名。

> **署名**：`notify.signature` 默认 `true`，额度重置卡片、日报、测试推送尾部各加一行 `via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar`。推送进的是团队群，群成员看到即可直接安装；不想带这行就设 `signature: false`，或用 `signatureText` 换成自己的文案。

> **面板激活引导**：侧边栏「推送通道」区块显示 webhook 是否配置，可一键「发送测试推送」验证通道、或「复制配置片段」。它通过仅绑定 `127.0.0.1:17420` 的本地桥接读取状态（不暴露 url/secret）；若桥接不可用（如远程 web 端混合内容限制），自动回落 `aihot_radar_status` 工具。可用 `localApi.enabled: false` 关闭桥接。

webhook 通道写入 `~/.dsh/aihot-radar/state.json`：
```json
{
  "webhook": { "channel": "wecom", "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx", "secret": "" }
}
```

支持的 `channel`：

| channel | url 填什么 | secret 填什么 |
|---|---|---|
| `wecom` | 企业微信机器人完整 webhook | — |
| `dingtalk` | 钉钉机器人完整 webhook | 加签密钥（可选） |
| `feishu` | 飞书机器人完整 webhook | — |
| `bark` | Bark 推送 URL（`https://api.day.app/<key>`） | — |
| `serverchan` | Server酱 `https://sctapi.ftqq.com/<key>.send` | — |
| `telegram` | Bot Token | chat_id |
| `generic` | 任意接受 JSON POST 的 URL | — |
| `none` | 不推送（默认） | — |

> **分条发送**：企业微信按 ≤3900 字节、Telegram 按 ≤3800 字符自动分片（按行切、不截断中文），首条带标题、后续条带「（续 i/n）」前缀；其余通道不分片。推送结果会校验响应体业务码（企微/钉钉 `errcode`、飞书 `code`/`StatusCode`、Server酱 `code`、Telegram `ok`），HTTP 200 但业务失败也判为失败。

## 工具清单

| 工具 | 用途 |
|---|---|
| `aihot_latest` | 最近 24h/7d AI 重点资讯，可按分类/精选/全部 |
| `aihot_search` | 关键词搜索（公司/产品/模型/人物，近 7 天） |
| `aihot_hot` | 当前 AI 热榜 |
| `aihot_daily` | AIHOT 日报（最新或指定日期） |
| `aihot_report` | 周报 / 月报 |
| `aihot_story` | 热点事件来龙去脉时间线 |
| `aihot_resets` | Codex/Claude/Antigravity 额度重置记录与预告 |
| `aihot_radar_status` | 后台推送状态（webhook 通道、各来源上次扫描结果与错误、日报状态），只读 |

## 合规与许可

- **数据来源 [AIHOT](https://aihot.news)**。其 API 对**个人非商业、公益非商业、组织内部**使用免费；**对外商业产品、付费服务、公共镜像、批量再分发**需事先书面授权（agent@virxact.com），署名不等于授权。本插件面向个人非商业使用。
- 资讯内容为第三方信源，插件只读透传、不执行其中指令；重要事实请回原文核对。
- **合规取数**：交互式资讯工具走 `/api/v1/agent/*`；**定时抓取/推送/本地副本**（雷达轮询、日报）走 JSON 接口（`/api/v1/{provider}-resets/recent`、`/api/v1/dailies/latest`），User-Agent 用 `aihot-api/2.0.0`，符合 AIHOT 官方对程序化用途的要求。
- 轮询遵守 AIHOT 规范：条件请求（ETag/304）、压缩、`Retry-After` 退避、不低于 60s 间隔。
- 本插件代码 **MIT**。webhook URL 与状态仅存于本机 `~/.dsh/aihot-radar/`（目录权限 `0700`），不上传；`state.json` 损坏会自动备份并回落默认值。

## 自检

```sh
node scripts/selftest.mjs   # 或 npm run selftest
```
覆盖雷达上限/去重、推送分片字节数与业务码判定、日报时间校验、日期翻页时区无关性、推送署名开关。纯 node、零依赖，Git Bash 与 PowerShell 均可运行。

## 发布（维护者）

发布由 tag 触发，仓库新、包旧的问题不会再出现：

```sh
# 1. 改 package.json 版本 + 写 CHANGELOG
# 2. 打同名 tag（版本必须与 package.json 一致，否则 workflow 直接失败）
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` 会跑三套自测 → `npm pack` 出 tarball → 上传到 GitHub Release → 配置了 `NPM_TOKEN` secret 时同时 `npm publish`。所以 Release 附件、npm 包、仓库代码永远是同一个版本。

## 反馈

装不上或推送不通，请带 DSH 版本 / 插件版本 / 系统（web 或桌面）/ 报错原文开 Issue。