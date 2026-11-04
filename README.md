# dsh-paper-reader

右侧边栏里的论文阅读器。打开一篇 PDF 后：

- **原样呈现**：pdf.js 按页把 PDF 渲染成画布，排版、字体、插图、公式都不经过任何转换；上传的原始文件保存在 `~/.dsh/paper-reader/`，不做改写。
- **选中即用**：选中正文任意文字，浮出「高亮 / 笔记 / 提问」三个动作。
- **高亮与笔记**：按页保存，跨缩放定位；「标注」页可回看、跳转、删除。
- **在会话中提问**：把「请解释这段内容…」连同选段写进当前会话输入框，语言跟随界面语言。
- **人机共管批注**：批注存在磁盘上，agent 通过 `paper_annotations` 工具读写，人在阅读器里读写，两边看到同一份；AI 写的批注带 `AI` 标签。
- **会话 ↔ PDF 定位**：人写的批注记下来源会话，点「回到会话」跳回那次对话；每条批注可复制 `paper://<docId>@p<page>` 定位链接。
- **关联代码**：每篇论文可挂一个开源仓库地址和/或本地代码目录；目录可浏览，点文件就让 agent 对照论文读它；没关联时可以让 agent 直接写一版实现。
- **论文文件夹**：每篇论文在 `~/.paper_reading/<论文名>/` 下一个文件夹，`pdf/` 放原件、`markdown/` 放正文抽取、`code/` 放代码（仓库或本地副本），另有 `notes.md`（标注导出）与 `README.md`（目录说明）。工作目录根可在插件页里改。
- **静默解析**：上传后自动用 markitdown 把 PDF 转成 Markdown，落在 `markdown/paper.md`；「更多 → 解析正文（MinerU）」会中断当前解析并改用 MinerU（需要 Token；调用在插件自己的 JS 里完成，不依赖 Python 脚本），底部进度条实时显示进度，解析期间 `@` 按钮置灰。
- **`@` 一键带入**：工具栏的 `@` 把论文文件夹路径（含 pdf / markdown / 代码情况）写进当前会话输入框，agent 直接在那个目录里干活。
- **论文库**：全局保存所有导入的论文，支持继续阅读、下载原件、删除。

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:jypjypjypjyp/dsh-paper-reader

# 或在本地插件目录里 link 进去（开发调试）
dsh plugin --profile web add link:./projects/dsh-paper-reader
```

装完重启一次 `dsh web`（Host 路由在启动时注册），右侧边栏的 `+` 里就有「论文阅读器」。

## 使用

1. 打开右侧边栏，点 `+`，选「论文阅读器」。
2. 点工具栏的上传按钮（或把 PDF 拖进面板）导入论文。
3. 选中正文文字，使用浮出菜单；工具栏的 `</>` 打开「代码」，`@` 把论文目录和 `paper-memory` skill 写进输入框，`⋯` 里有「解析正文（MinerU）」与「设置」。
4. 面板三栏：**标注**（挂在某页某段原文上的高亮与批注）、**笔记**（论文级的一句话结论，可多条，随时增删改）、**代码**。

设置（工作目录、MinerU Token、模型、语言）统一放在左侧「插件」→ `dsh-paper-reader` 详情页，用 DSH 自带的设置表单渲染（`@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm` / `SettingsValueField` / `SettingsSecretField`，与「网页搜索」等内置设置页同一套控件）；阅读器里的「设置」直接跳到那一页。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host：`/paper-reader` 路由（库、上传、元数据/标注、设置、双引擎解析、论文文件夹、目录浏览、PDF 字节、pdf.js 静态资源）与 `paper_annotations` 工具 |
| `client.js` | Client：向 `ctx.betterSidebar` 注册 `paper-reader` tab（阅读器、标注/代码面板），并向 `plugins.detail.section` 注册插件页里的「阅读器设置」 |
| `public/` | vendored pdf.js 3.11（`pdf.min.js`、worker、cmaps、standard_fonts），Apache-2.0，许可证见 `public/LICENSE-pdfjs.txt` |

存储：`~/.dsh/paper-reader/` 是内部库（`<uuid>.pdf` 原件、`<uuid>.json` 元数据、`settings.json` 设置）；对外的论文文件夹在 `~/.paper_reading/<论文名>/`。

## 批注工具

`paper_annotations` 面向模型：`action=list` 不带 `docId` 列出论文库，带 `docId` 读该论文的全部标注与笔记；`action=create` 写一条标注（`page` + `text` + `note`，作者记为 AI）；`update` / `delete` 按 id 改删；`action=note` / `update_note` / `delete_note` 管论文级笔记；`action=code` 读或写这篇论文的代码仓库（`repo` / `path`），阅读器「AI 查找仓库」按钮就是让 agent 走这条路自动回填。

## 跨会话记忆 skill

插件在 `apply()` 里用 `ctx.inject(['skills'])` + `ctx.skills.register()` 注册了一个运行时 skill `paper-memory`，内容是「怎么用标注和笔记做跨会话记忆、每条写多短」。它出现在 agent 的 skill 目录里，模型可以自行调用；点阅读器的 `@` 时，插件会把论文目录信息和这个 skill 的正文一起写进输入框，让模型当场按规则读旧记忆、写新记忆。

规则很短：标注挂原文、笔记记判断，每条一句话不超过 40 字，只写结论与依据，不写推测与过程。

## 损坏的 PDF

文件按原样保存，阅读器不会尝试改写。若 PDF 结构损坏（例如缺少 `xref` / `%%EOF`，常见于下载中断），打开时会给出说明，并提供「下载原件」和「重试」，方便用其它工具修复后再导入。
