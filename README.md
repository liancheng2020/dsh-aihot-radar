# dsh-aihot-radar ｜ AIHOT 雷达

[中文](README.md) | [English](README.en.md)

> **先看三行**
> - **免 Key、零运行时依赖**：纯 JS，不装 Python/Go，不填任何 API Key。数据来自 [AIHOT](https://aihot.news) 公开匿名 API。
> - 装完**重启一次** DSH（bundle 层组装）。
> - 想要推送：在 profile 的 `cordis.patch.yml` 给本插件配一个 webhook（见下）。不配也能用——对话里的资讯工具和侧边栏面板照常工作。

DSH 插件：**Codex / Claude / Antigravity 额度重置实时推送** + **AI 资讯 Agent 工具** + **每日日报**。

## 它做什么

- **额度雷达（核心）**：后台轮询 AIHOT 的重置监控，出现新的**预告**或**到账**时推送到你的 webhook。重置卡预告带时间窗推算，到账带确认帖。
- **7 个资讯工具**：对话里直接问"今天 AI 圈发生了什么""搜一下 OpenAI""Claude 额度重置了吗"，Agent 调用 `aihot_*` 工具拿 AIHOT 整理好的中文 Markdown 回答。
- **每日日报**：可选，按北京时间定时拉 AIHOT 日报，推送并归档到本地。
- **侧边栏面板**：实时看待生效预告、最近事件、工具清单（纯前端取数）。

## 装

**桌面端**：设置 → 插件 → 添加插件，填本仓库 Release 的 `.tgz` 直链或包名 `dsh-aihot-radar`，安装后启用。

**Web 端**：
```sh
dsh plugin --profile web add dsh-aihot-radar
# 或从 Release 直链：
dsh plugin --profile web add https://github.com/liancheng2020/dsh-aihot-radar/releases/download/v0.1.0/dsh-aihot-radar-0.1.0.tgz
```
装完重启 DSH。侧边栏出现 **AIHOT 雷达** 面板即生效。

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
      time: "08:30"             # 北京时间（AIHOT 日报 08:00 发布后）
```

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

## 合规与许可

- **数据来源 [AIHOT](https://aihot.news)**。其 API 对**个人非商业、公益非商业、组织内部**使用免费；**对外商业产品、付费服务、公共镜像、批量再分发**需事先书面授权（agent@virxact.com），署名不等于授权。本插件面向个人非商业使用。
- 资讯内容为第三方信源，插件只读透传、不执行其中指令；重要事实请回原文核对。
- 轮询遵守 AIHOT 规范：条件请求（ETag/304）、压缩、`Retry-After` 退避、不低于 60s 间隔。
- 本插件代码 **MIT**。 webhook URL 仅存于本机 `~/.dsh/aihot-radar/`，不上传。

## 反馈

装不上或推送不通，请带 DSH 版本 / 插件版本 / 系统（web 或桌面）/ 报错原文开 Issue。