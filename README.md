# dsh-vibe-reading

右侧边栏里的 Vibe Reading（读论文的工作台）。打开一篇 PDF 后：

- **原样呈现**：pdf.js 按页把 PDF 渲染成画布，排版、字体、插图、公式都不经过任何转换；上传的原始文件保存在 `~/.dsh/vibe-reading/`，不做改写。
- **选中即用**：选中正文任意文字，浮出「高亮 / 笔记 / 提问」三个动作。
- **高亮与笔记**：按页保存，跨缩放定位；「标注」页可回看、跳转、删除。
- **在会话中提问**：把「请解释这段内容…」连同选段写进当前会话输入框，语言跟随界面语言。
- **人机共管批注**：批注存在磁盘上，agent 通过 `vibe_reading` 工具读写，人在阅读器里读写，两边看到同一份；AI 写的批注带 `AI` 标签。
- **原地跳转**：点标注行的页码或 ◎ 跳到那一页，同时收起面板让页面露出来；每条批注可复制 `vibe://<docId>@p<page>` 定位链接；点页面上的高亮弹出该条的引文、笔记与编辑入口。
- **两套代码目录**：`remote/` 放开源实现（填仓库地址后点克隆，后台执行、状态行与按钮实时反馈），`local/` 放本地复现（默认启用）。两边都能浏览目录树，点文件就让 agent 对照论文读它。
- **论文文件夹**：每篇论文一个文件夹，`pdf/` 原件、`markdown/` 正文抽取（可能带 `images/`）、`remote/` 开源代码、`local/` 本地复现，另有 `notes.md`（标注与笔记的唯一文档）与 `meta.md`（页数、关键词、仓库与解析状态）。工作目录根默认 `~/.paper_reading`，可在插件页里改。
- **静默解析**：上传后自动用 markitdown 把 PDF 转成 Markdown，落在 `markdown/paper.md`；「更多 → 解析正文（MinerU）」会中断当前解析并改用 MinerU（需要 Token；调用在插件自己的 JS 里完成，不依赖 Python 脚本），底部进度条实时显示进度，解析期间 `@` 按钮置灰。
- **`@` 一键带入**：工具栏的 `@` 往输入框写两行——`/dsh-vibe-reading` 手势与论文文件夹路径；目录里有什么由 skill 说明，提示词不带可能过时的副本。
- **论文库**：全局保存所有导入的论文，支持继续阅读、下载原件、删除。

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:jypjypjypjyp/dsh-vibe-reading

# 或在本地插件目录里 link 进去（开发调试）
dsh plugin --profile web add link:./projects/dsh-vibe-reading
```

装完重启一次 `dsh web`（Host 路由在启动时注册），右侧边栏的 `+` 里就有「Vibe Reading」。

## 使用

1. 打开右侧边栏，点 `+`，选「Vibe Reading」。
2. 点工具栏的上传按钮（或把 PDF 拖进面板）导入论文。
3. 选中正文文字，使用浮出菜单；工具栏的 `</>` 打开「代码」页，`@` 把 `/dsh-vibe-reading` 与论文目录写进输入框，`⋯` 里有「解析正文（MinerU）」与「设置」。
4. 面板三栏：**标注**（挂在某页某段原文上的高亮与批注，第二行显示它的笔记）、**笔记**（论文级的分块结论，可多条，随时增删改）、**代码**（再分「开源仓库 / 本地复现仓库」两个页签，各有目录浏览）。

设置（工作目录、MinerU Token、模型、语言）统一放在左侧「插件」→ `dsh-vibe-reading` 详情页，用 DSH 自带的设置表单渲染（`@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm` / `SettingsValueField` / `SettingsSecretField`，与「网页搜索」等内置设置页同一套控件）；阅读器里的「设置」直接跳到那一页。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host：`/vibe-reading` 路由（库、上传、元数据/标注、设置、双引擎解析、论文文件夹、目录浏览、PDF 字节、pdf.js 静态资源）与 `vibe_reading` 工具 |
| `client.js` | Client：向 `ctx.betterSidebar` 注册 `vibe-reading` tab（阅读器、标注/代码面板），并向 `plugins.detail.section` 注册插件页里的「阅读器设置」 |
| `public/` | vendored pdf.js 3.11（`pdf.min.js`、worker、cmaps、standard_fonts），Apache-2.0，许可证见 `public/LICENSE-pdfjs.txt` |

存储：`~/.dsh/vibe-reading/` 是内部库（`<uuid>.pdf` 原件、`<uuid>.json` 元数据、`settings.json` 设置）；对外的论文文件夹在 `~/.paper_reading/<论文名>/`。

## 批注工具

`vibe_reading` 面向模型：`action=list` 不带 `docId` 列出论文库，带 `docId` 读该论文的全部标注与笔记；`action=create` 写一条标注（`page` + `text` + `note`，作者记为 AI）；`update` / `delete` 按 id 改删；`action=note` / `update_note` / `delete_note` 管论文级笔记；`action=code` 读或写这篇论文的代码仓库（`repo` / `path`），阅读器「AI 查找仓库」按钮就是让 agent 走这条路自动回填。

## 跨会话记忆 skill

插件在 `apply()` 里用 `ctx.inject(['skills'])` + `ctx.skills.register()` 注册了一个运行时 skill `dsh-vibe-reading`：工具清单（`vibe_reading` 的每个 action）、论文目录里有什么、什么时候该写、每条写多短、什么不该写。

它出现在 agent 的 skill 目录里，模型可以自行调用；点阅读器的 `@` 时，输入框里写的是 `/dsh-vibe-reading` 这个手势加论文目录信息，由 DSH 的 skill 机制按需加载正文（`dsh-tool-skill` 用 `/(^|\s)\/([a-z0-9-]+)(?=\s|$)/` 扫描用户消息），而不是把正文粘进对话。

规则很短：标注挂原文、笔记记判断，每条一句话不超过 40 字，只写结论与依据，不写推测与过程。

## 损坏的 PDF

文件按原样保存，阅读器不会尝试改写。若 PDF 结构损坏（例如缺少 `xref` / `%%EOF`，常见于下载中断），打开时会给出说明，并提供「下载原件」和「重试」，方便用其它工具修复后再导入。
