# dsh-annotator

DeepSeek Harness 插件：在右侧栏的文档预览里**直接圈画标注**，标注可以**保存**到文档旁边，也可以**填入会话**（作为一条用户消息发给当前会话的智能体），让它按标注去改生成源，而不是靠用户打字描述。

English summary: annotate a document (image, SVG, PDF, HTML, Office) in the right-sidebar preview, save the marks beside the file, and fill them into the session as a user message: a PDF is one document annotated once, written back as native PDF annotations attached to the message.

## 目标范围

本插件要为 DSH 预览器里的下列文档提供标注，标注后均能保存并填入会话：

| 文档类型 | 后缀 | 状态 |
|---|---|---|
| 图片 | `png` `jpg` `jpeg` `gif` `webp` `bmp` `ico` | 已实现 |
| SVG | `svg` | 已实现（内联渲染，支持图元锚定） |
| PDF | `pdf` | 已实现（整份文档一份标注：逐页画、一次保存，标注写回原生 PDF 注释对象） |
| HTML | `html` `htm` | 待实现，仍由内置 HTML 预览器打开 |
| Office | `doc` `docx` `ppt` `pptx` `xls` `xlsx` | 待实现，仍由内置 Office 预览器打开 |

「保存」= 把标注写进文档旁边的侧车文件；「填入会话」= 把标注（以及标注图、带批注的 PDF 副本）作为一条用户消息发进当前会话。目前**图片、SVG 与 PDF 走通了完整链路**，HTML/Office 尚未接入标注。

## 它解决的问题

专利说明书附图的返工意见通常是「这个标号指错了」「这里少一个件」「这条线该连到那边」——用文字描述既慢又容易误解。本插件让用户在图面上直接画箭头/圈选/文字，插件把**图面坐标 + 落在哪个图元上 + 用户那句话**一起交给智能体。

## 安装

插件是一个标准的 DSH 第三方插件包（Host 半 + Client 半），装进 profile 即可：

```jsonc
// <profile>/package.json
{
  "dependencies": { "dsh-annotator": "link:/Users/xujian/projects/dsh-annotator" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-annotator"] } }
}
```

```sh
pnpm install            # 在 profile 目录里建立链接
pnpm run build          # 在本插件目录里构建 lib/index.js 与 lib/client.js
```

**改动 Host 半后必须重启宿主进程**：Node 会缓存已导入的插件模块，运行中的进程不会重新导入它（Client 半只需刷新页面）。开发时建议用隔离实例验证：

```sh
DSH_HOME=/tmp/dsh-annotatordev node --import tsx/esm apps/cli/src/bin.ts --profile annotatordev --port 3099 --no-open
```

## 使用

1. 在会话里打开文档（右栏文件树、变更文件卡、`present` 卡片都能打开）。插件目前为 `svg/png/jpg/jpeg/gif/webp/bmp/ico` 注册了预览实现，是这类文件的默认渲染器；下拉里仍可切回内置图片查看器。
2. 点工具栏「标注」，选工具（箭头/框选/圈选/手绘/文字）、选颜色，直接在图上画。
3. 画完自动选中该标注，在「说明」里写一句话（例如「这个标号应指向滑套 34」）；「总体说明」写这次要改什么。
4. 「仅保存」只落盘；「保存并提交给智能体」落盘后把标注作为一条用户消息发进当前会话。

SVG 图会**内联渲染**，因此标注能锚定到图元：Graphviz 产出的节点（`<g><title>102</title>`）会被识别为「元素标题 102」，圈到某个标号文字上则记为该文字的标签。

PDF 是**一份文档一次标注**：上排工具栏翻页（`3 / 12` 与「共 12 页 · 5 处标注」），每页各自画、各自撤销，翻页时已画的内容不会丢也不会串页；「仅保存」/「保存并提交给智能体」是**整份文档**的两个动作，各只按一次。

## 产物

标注不修改原文档，只在文档旁边写两个文件：

| 文件 | 内容 |
|---|---|
| `<文件名>.annot.json` | 标注文档：文档信息（绝对路径、sha256，PDF 另有 `pageCount`）、`marks[]`（kind/color/points/page/anchor/text）、总体说明 |
| `<文件名>.annotated.png` | 图片/SVG：原图 + 标注的合成图（2 倍分辨率），随消息作为图片附件发给模型 |
| `<文件名>.annotated.pdf` | PDF：原件副本，标注写成**原生 PDF 注释对象**，同时作为附件随消息发送 |

两个名字都**带着被标注文件自己的扩展名**（`fig1.svg` → `fig1.svg.annot.json`）：同目录下同主名不同后缀的两份文件各有各的标注，绝不会互相读成对方的那一份。

`marks[].points` 是**图面像素坐标**（原点在左上角）；PDF 里每条标注另外带 `page`，坐标是那一页自己的页面单位（PDF 点），因此缩放、翻页、旋转页都不影响它指向的位置。`marks[].anchor` 记录标注落在哪个 SVG 元素上（`tag`/`id`/`title`/元素文字/包围盒）。原文被重画后 sha256 变化，插件会提示旧标注可能失准。

带批注的 PDF 里，箭头是 `/Line`、框选 `/Square`、圈选 `/Circle`、手绘 `/Ink`、文字 `/FreeText`，每个对象都带自绘的外观流，因此在任何阅读器（Acrobat、Preview、浏览器内置查看器、PDF.js）里都能看到与页面上一致的形状，也能在阅读器里继续编辑或删除；文字批注若是中文，外观交给阅读器用它自己的字体合成（自绘外观需要把 CJK 字体嵌进文件，那会让产物大一截）。

智能体侧同时收到一段【附图标注】消息：文档路径、页数与标注处数、侧车与带批注副本的路径、逐条编号的标注（PDF 会写明「第 N 页」），以及一句处理纪律（改生成源、未标注处不动、逐条回应）。插件还会注入一段系统提示，说明这类消息该怎么处理。

### 与同工作区的其它标注器互通

同一工作区里的姊妹标注器（Sati）把标注写进同一份侧车文件，但用的是 **v2 形状**（用 `target` 承载图面信息，而不是 `figure`）。本插件读得懂 v2 并继续写自己的 v1 形状，所以两边都能看到对方留下的标注。回存时本插件按自己的形状落盘，v2 独有、本插件不建模的字段（`target.kind`、逐条 `targetFingerprint`、锚点的 `nodeId`/`ref`）会在这一步丢掉。

早期版本按**主名**派生侧车名（`fig1.svg` → `fig1.annot.json`）。那个名字仍会被读回（作为优先级更低的只读回退），所以升级不会让既有标注消失；但同一个主名被同目录的另一份文件（`fig1.png`）共用时，回退读回会先核对文档指向的是不是当前文件，指向对方就拒绝。

更早的版本对 PDF **按页各存一份**（`report.pdf.p3.annot.json`）。那些文件在整份文档还没有统一侧车时会被读回并**合并成一份**显示（`pageCount` 取出现过的最大页号，真实页数由浏览器半边下次保存时写回），旧文件原样保留不删。

## 限制

- **不做图面编辑**：插件只采集标注，不改图；修图仍由智能体改生成源（脚本/DOT/SVG）完成。
- **栅格图没有元素锚定**：PNG/JPEG 只能给像素坐标，锚定信息仅 SVG 有。
- **PDF 标注只写原生注释对象**：不做「把标记烧进页面内容」的副本。好处是标记在阅读器里仍可编辑/删除、页面内容不被改写；代价是只画内容不画注释的渲染器（例如把页面转成位图的自制流程）看不到标记——那种场合请用消息里附的每页图片。
- **不做 PDF 文本层与连续滚动**：一次一页，翻页按钮在文档工具栏上；页内文字不可选、不可搜。
- **HTML、Office 文档尚未接入标注**，仍由内置预览处理（见「目标范围」）。
- **带批注的 PDF 是派生产物**：它由浏览器半边在保存时生成，原件被重新生成后需要重新保存一次才会同步。
- **提交即一条用户消息**：模型能否直接看到标注图取决于会话路由是否声明图像输入；不支持时会降级为占位文本，此时结构化标注与标注图路径仍是完整信息源（可用 `analyze_patent_figure` 或图像输入模型回看）。
- **未做 Excalidraw 模式**：这是既定的一期范围；一期自研轻量标注层，二期再评估把 Excalidraw 作为自由批注模式接在同一条提交链路上。

## 开发

开发规范（门禁、负控制、决策记录、架构红线）的家在 [`AGENTS.md`](./AGENTS.md)，开工前先读它的 §2。决策背景在 [`docs/notes/`](./docs/notes)。

```sh
pnpm run check      # 三个门禁一次跑完：typecheck + lint + test:coverage
pnpm run build      # tsc --noEmit + tsdown（Host ESM / Client 单文件 CJS）
pnpm test           # vitest：地址解析、标注模型、侧车读写、路由、绘制、导出、锚定
pnpm run typecheck
```

Client 半边必须匹配 DSH 动态客户端契约：单文件 CJS、唯一副作用是 `window.__ModuleLoader__.load({id, factory})`、只把 `react`/`react/jsx-runtime` 留给模块表，其余全部内联（插件路由只发 `client.*.js`，发不了字体等静态资产）。
