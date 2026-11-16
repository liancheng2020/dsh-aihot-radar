# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.3.0] - 2026-11-16

### Added
- **面板内配置推送通道**：`POST /webhook` 保存并可立即测试，保存即生效无需重启；Origin 白名单 + `Sec-Fetch-Site` 校验（放行宿主壳 `dsh-app://`），`/status` 只回脱敏 host。
- **面板内配置日报**：`/status` 返回 `digestCfg`（生效开关 / 时间 / 时区 / 下次触发），新增 `POST /digest` 保存偏好并即时重排定时器；偏好存 `state.json` 的 `digestPref`，与运行态 `digest` 分离，坏调度不会丢配置。
- **发送测试日报**：`POST /digest/test` 用真实日报走完整链路（含分条），且不写 `lastDate`，不会顶掉当天真正的推送。
- **`digest.catchUp`**：宿主在设定时间之后才启动时补发一次（默认关），仍受同日去重保护。
- 日报卡片展示上次结果（成功日期 / 失败原因），失败不再只写日志。
- 用例：客户端 P8–P18、宿主 L7–L10。
- 上架材料：新增 `assets/panel-push.png`（推送配置 + 每日 AI 日报），`screenshots.json` 与中英文 README 同步引用。

### Changed
- 区块标题「推送通道」改为「推送配置」；日报时间改为主题色下拉 + 半小时间隔预设，可直接输入（`7:5` 失焦归一为 `07:05`，粘贴 `10:30:00` 会丢掉秒）。
- 日报时间下拉补齐 combobox 语义（`aria-expanded` / `aria-activedescendant` + `listbox`/`option`，方向键选择、回车确认、Esc 关闭）；关闭定时后时间框仍可编辑，方便「先设时间再开启」。
- `POST /digest` 支持只传部分字段（缺省即保持原值），并拒绝非布尔的 `enabled`（字符串 `"true"` 不再被静默当成关闭）。
- 日报卡与通道卡对齐：补「已启用 / 未启用」徽章，「下次推送」独立成行；副标题不再写「默认关闭」，改为关闭态才出现的说明；动作按钮独立成行放在控件下方、主按钮在前，与 webhook 表单页脚保持一致。
- 动作顺序统一为「轻 / 可回退在前，提交在最后」：表单页脚 `取消 → 关闭推送 → 仅保存 → 保存并发送测试`，通道卡 `发送测试推送 → 修改`，日报卡 `发送测试日报 → 保存日报设置`。位置规则与样式规则分开——只有提交类动作使用主按钮样式。
- 「修改」改为描边按钮（与相邻按钮同款边框，但无填充底色），在提交位不再显得比主操作更重；未配置时该位置显示「保存」并保持填充样式。
- 日报开关仍以显式偏好或 `digest.enabled` 为准——配了 webhook 不会自动开启日报，升级不改变推送行为。
- 「下次推送」按 `digest.timezone` 显示并标注时区，精确到分。
- 精简：`/status` 去掉无人消费的 `digestCfg.pref`；时区格式化合并为单个 `tzParts`；预设列表样式移到样式表；`lib/digest.js` 不再转出口 `validateTime`/`msUntilNext`/`beijingParts`；删除 3 个无用文案键。

### Fixed
- 宿主桥接为旧版本时提示重启 DSH，保存失败不再只显示「未知接口」。
- 保存 / 关闭 webhook 后重新同步日报状态，避免面板开关与宿主实际行为不一致。
- 面板重新可见时重读日报状态，长时间挂着不会一直显示过去时间的「下次推送」。

## [0.2.0] - 2026-11-13

### Added
- **推送署名（默认开启）**：额度重置卡片、AI 日报与测试推送尾部加一行 `via AIHOT 雷达 · 安装：github:liancheng2020/dsh-aihot-radar`。推送落在团队群里，每条即一次安装入口；`notify.signature: false` 关闭，`notify.signatureText` 换自定义文案。
- **tag 驱动发布**：`.github/workflows/release.yml` 在 `v*` tag 上校验版本一致性、跑三套自测、`npm pack` 出 tarball 并上传 GitHub Release，配置 `NPM_TOKEN` 时同时发布 npm。杜绝「仓库新、包旧」。
- **README 首屏**：面板截图提到「先看三行」之后，补 release / DSH 兼容徽章，中英文同步。
- **面板激活引导**：侧边栏新增「推送通道」区块，显示 webhook 配置状态、提供「发送测试推送」与「复制配置片段」按钮（loopback 桥接 `127.0.0.1:17420`，不泄露 url/secret；不可用时回落 `aihot_radar_status`）。
- **通知疲劳控制**：`radar.quiet`（免打扰时段，支持跨天）与 `radar.muted`（按来源静音）。免打扰期间推送顺延不丢；静音来源标记已读避免解除后刷屏。
- **日报时区可配置**：`digest.timezone`（IANA，默认 `Asia/Shanghai`），非法值回落默认。
- **面板反馈入口**：脚注「反馈/报障」直达 GitHub Issues。
- **CI**：GitHub Actions 在 Node 18/20/22 跑全部自测；README 徽章。
- **社区模板**：issue（bug/feat）与 PR 模板。
- 共享时区模块 `lib/time.js`；本地桥接 `lib/localapi.js`。

### Changed
- 版本号 `0.1.2` → `0.2.0`，npm 与 Release 重新打包发布（补齐图标、工具卡片、标签图标与 README 优化，下载即最新）。
- 资讯工具卡片改为可点击：复制示例问句并给出「去对话粘贴即可调用」的引导。
- 复制反馈改为**浮动 toast**（✓ 图标 + 单行标题与说明，成功/失败两种配色），定位在面板顶部居中，2s 自动消失，`position: fixed` 不占面板布局、不遮挡点击；配色用透明色叠主题文字变量，浅色/深色模式都清晰。
- 面板分区标题统一使用同一色阶（`T.sub`，与计数徽章一致），消除「推送通道」因无计数徽章而显得更淡的观感。
- 标签图标平衡：额度雷达图标放大至与今日日报相当。
- README 标语去叠词（"每日日报"→"AI 日报"），GitHub About 对齐。
- 扩充 npm keywords 与 GitHub topics 提升搜索发现。

### Fixed
- 复制提示曾固定在窗口底部，远离点击位置且看起来像面板正文；已改为面板顶部居中的浮动 toast。
- 面板样式表按 id 缓存后不再更新，插件热更新时新增样式（如 toast）不生效、退化成面板正文；改为每次挂载强制同步样式内容。
- 客户端自测 B7 与真实日期解耦（冻结"最新期"计算），不再随日历变红。

## [0.1.2] - 2026-11-12

首个发布版。仓库历史（`30f9e97` → `f31ab7f`）对应本版本的全部内容：

- `30f9e97` 初版插件骨架：额度雷达、7 个 AIHOT 资讯工具、可选每日日报、侧边栏面板、多通道 webhook。
- `b852214` 修复 P0/P1 缺陷并补齐自检：推送响应业务码校验、超长消息分条、雷达单轮推送上限与去重；新增服务端自检 `scripts/selftest.mjs`。
- `91425e1` 完整中英双语 UI 与 P2 工程项：补齐 MIT `LICENSE`、扩充 `locale/{zh,en}.json`、状态读写容错、工具注册收口。
- `20f4ec9` 第二轮返工：日报来源字段（`source` 对象）与 `outage` 字段解析、跨实例去重（desktop/web 共享 `~/.dsh/aihot-radar/state.json`）、`state.json` 容错、可复现自检（`selftest-client.mjs`、`verify-dedup.mjs`）。
- `e886f75` 发布收尾：去掉死参数、双语语言包对齐、修正安装文档，补 `.gitattributes`。
- `9fae9e4` 上架材料：`assets/icon-180.png`、`assets/panel-radar.png`、`assets/panel-daily.png`、`screenshots.json`。
- `f31ab7f` 文档：补充 GitHub Release `.tgz` 直链安装方式。

### Added
- 额度雷达（预告/到账/推断态推送、单轮上限补推）、7 个资讯工具、可选每日日报（分条/重试/归档）、侧边栏面板、多通道 webhook（企微/钉钉/飞书/Bark/Server酱/Telegram/generic）。
- 免 Key、零运行时依赖；双语 UI；合规取数与本地状态持久化。
- 三种安装方式：npm 包名、GitHub 仓库直装、Release `.tgz` 直链。

### Fixed
- 推送 HTTP 200 但业务失败（errcode/code 非 0）被误判为成功。
- 长文本超限被通道拒绝；改为按行分片、不截断中文。
- 日报期号依赖本机日期、`outage`/`source` 字段解析不正确。
- 多实例（desktop + web）重复推送；`state.json` 损坏导致启动失败。
- 自测依赖真实日期、结果不可复现。

[0.3.0]: https://github.com/liancheng2020/dsh-aihot-radar/releases/tag/v0.3.0
[0.2.0]: https://github.com/liancheng2020/dsh-aihot-radar/releases/tag/v0.2.0
[0.1.2]: https://github.com/liancheng2020/dsh-aihot-radar/releases/tag/v0.1.2
