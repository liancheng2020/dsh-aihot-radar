# dsh-aihot-radar ｜ AIHOT 雷达

[中文](README.md) | [English](README.en.md)

> **先看三行**
> - **免 Key、零运行时依赖**：纯 JS，不装 Python/Go，不填任何 API Key。数据来自 [AIHOT](https://aihot.news) 公开匿名 API。
> - 装完**重启一次** DSH（bundle 层组装）。
> - 想要推送：在 profile 的 `cordis.patch.yml` 给本插件配一个 webhook（见下）。不配也能用——对话里的资讯工具和侧边栏面板照常工作。

DSH 插件：**Codex / Claude / Antigravity 额度重置实时推送** + **AI 资讯 Agent 工具** + **每日日报**。

## 它做什么

- **额度雷达（核心）**：后台轮询 AIHOT 的重置监控，出现新的**预告**或**到账**时推送到你的 webhook。重置卡预告带时间窗推算，到账带确认帖；AIHOT 推断态（窗口已过/可能已到账）发轻提示并标明「未经确认」。单轮推送有上限，超出的事件下一轮补推，不会丢。
- **7 个资讯工具**：对话里直接问"今天 AI 圈发生了什么""搜一下 OpenAI""Claude 额度重置了吗"，Agent 调用 `aihot_*` 工具拿 AIHOT 整理好的中文 Markdown 回答。
- **每日日报**：可选，按北京时间定时从 AIHOT **JSON 接口**拉日报，推送并归档到本地。超长自动分条发送；推送失败 10 分钟后重试，当天最多 3 次。
- **侧边栏面板**：实时看待生效预告、最近事件、工具清单，显示 AIHOT 核对时间与监控状态（纯前端取数）。

## 装

**桌面端**：设置 → 插件 → 添加插件，填入仓库地址：

```
github:liancheng2020/dsh-aihot-radar
```

**Web 端**：
```sh
dsh plugin --profile web add github:liancheng2020/dsh-aihot-radar
```
装完重启 DSH，侧边栏出现 **AIHOT 雷达** 面板即生效。

> 尚未发布 npm 包与 GitHub Release，本文档不提供 `.tgz` 直链；发布后再补。

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
    digest:
      enabled: true             # 开启每日日报
      time: "08:30"             # 北京时间，合法范围 00:00–23:59；非法值回落 08:30
```

> `digest.time` 只接受 `HH:mm`（0≤时≤23、0≤分≤59），写错（如 `99:99`）会回落 `08:30` 并在日志告警。日报期号以 AIHOT 返回的 `report.date` 为准，不用本机日期猜测。

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
覆盖雷达上限/去重、推送分片字节数与业务码判定、日报时间校验、日期翻页时区无关性。纯 node、零依赖，Git Bash 与 PowerShell 均可运行。

## 反馈

装不上或推送不通，请带 DSH 版本 / 插件版本 / 系统（web 或桌面）/ 报错原文开 Issue。