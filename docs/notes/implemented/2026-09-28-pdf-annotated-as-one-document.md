# Note: PDF 批注：一份文档一份标注，标注写回原生注释对象

Status: implemented

Supersedes: `2026-09-28-pdf-annotation-in-a-lazy-chunk.md`（PDF 标注：每页一份侧车）

## Problem

上一版把 PDF 标注做成了"一页一份侧车 + 一页一张 PNG"：标注一份 40 页的说明书，磁盘上会散出几十个文件，会话里收到的是"第 3 页的标注"这样一条条孤立的消息——而用户心里做的是"我在改**这份 PDF**"。用户要的是：一份 PDF 统一标一次，保存成**一份带批注的 PDF**，并且这份 PDF 作为一条消息回到会话；批注本身最好是 PDF 自己的注释对象（能在 Acrobat/Preview 里继续编辑、删除、评论），而不是在页面上涂一层位图。

难点有四处：坐标要能写回 PDF，而 PDF 的坐标系带 y 翻转、`/Rotate`、`/UserUnit` 与非零原点；写注释对象需要一个 PDF 写入库（PDF.js 只读）；写进去的注释必须自带外观流，否则多数阅读器什么都不画；而这些都必须住在那个 7 MB 的懒加载分块里（主包不能变大），还要跨过分块不能 import 主包的那条边界。

## Decision

- **一份文档一份标注。** `AnnotatedFigure.pageCount` 记页数，每条 `AnnotationMark` 带 `page`，坐标是那一页的**页面单位**——也就是 PDF 点，因为 PDF.js 的 `getViewport({ scale: 1 })` 直接以 MediaBox 乘 scale（`PageViewport` 内部没有 96/72 系数，`PixelsPerInch.PDF_TO_CSS_UNITS` 是查看器自己另外乘的）。`width`/`height` 只属于单面图，分页文档禁止携带；`readAnnotationDocument()` 把这条不变量当拒绝条件（半张尺寸、又带尺寸又带页数、单面图上出现 `page`、`page > pageCount` 全部拒绝）。
- **写入器 `src/client/pdf/annotate.ts`，用 pdf-lib（MIT，无 fontkit）。** 五种 kind 各自落成 PDF 注释对象：`pen`→`/Ink`（`/InkList`）、`rect`→`/Square`、`ellipse`→`/Circle`（四段贝塞尔）、`arrow`→`/Line`（`/L` + `/LE [/None /OpenArrow]`）、`text`→`/FreeText`；`/Contents` 一律带用户那句话。
- **坐标经每页视口变换写回用户空间。** `runtime.ts` 的 `size(page)` 现在一并返回 `viewport.transform`，`toUserSpace()`（纯函数）做逆变换，`unitScale()` 给长度换算。于是 `/Rotate`、`/UserUnit`、非零原点都对：同一份页面单位坐标在原件与批注副本里指向同一处。
- **自绘外观流。** 每个注释带 `/AP /N`（BBox 与 `/Rect` 同形，内容画在盒内局部坐标），因此任何阅读器都画出用户画的形状，而不是自己猜一个默认样式；箭头头部的两条斜边各自以 `m` 起一条子路径（少了它操作数栈会被污染，任何渲染器都画不出箭头——这条是渲染验证抓出来的）。文字外观用**内嵌标准 Helvetica** 的度量与编码（WinAnsi）绘制；笔记含中文时不画外观（自绘要嵌 CJK 字体），保留 `/DA`+`/Contents`+`/Rect` 交给阅读器用系统字体合成，同时在 `/AcroForm` 的 `/DR` 里登记 `Helv`（既有的 AcroForm/DR/Font 一律 `lookup` 后增量修改——它们是间接对象，`instanceof` 判断会把用户原有的表单资源整个换掉）。
- **保存与投递各一次。** 浏览器半边把原件与标注合成 `<名>.annotated.pdf`，与 `<名>.annot.json` 一起经一次 POST 写入（两个产物各走自己的字段：`reviewImage` 是单面图的 PNG，`annotatedPdf` 必须是 `%PDF-` 开头的字节，二者不可同时出现，种类与文档后缀不符则拒绝）。发送时把这份 PDF 通过客户端的 `fileUpload` 服务上传成持久文件引用，作为 `{ type: 'file' }` part 随消息发出（客户端会话的 `prompt` 注释写明接受"staged-file receipts"），再附**每个被标注页**的位图（上限 8 页，超出在文本里说明）与编号清单。
- **跨分块边界用注入的"文档座位"。** 分块不能 import 主包（§2 第 7 条），所以主包构造一个 `DocumentSeat`（`load`/`save`/`send` 三个闭包，闭住 `sessions`、`fileUpload`、`sessionId`、语言），与 `AnnotatorBody` 组件一起注入给分块；契约类型写在 `src/client/document-seat.ts`，分块对它只做 `import type`（类型会被擦除，不产生运行时 import）。
- **页面 body 只是"一页"。** 带 `page` 的 `AnnotatorBody` 不再自己读写侧车（否则每个页面 body 都会读到整份文档的标注并把所有页的标记画到当前页上），也不渲染保存按钮；总体说明与"查看/标注"模式由文档受控传入（翻页会重挂载页面 body，不受控就把用户踢回查看模式，这是浏览器验证抓出来的第二个真缺陷）；每条 mark 的 `page` 由文档在保存前统一盖章。
- **构建契约补一条。** pdf-lib 的依赖图看起来有副作用，rolldown 因此在入口里插了一条**急切**的 `require("./client.pdf.js")`，浏览器工厂解析不了它（jsdom 规格全绿，只有把真实产物交给模块加载器时才炸）。构建插件剥掉这条语句、断言没有残留，并把这条写进 §2 第 8 条；同时分块 banner 现在带所有打包依赖（pdf-lib、pako、tslib、@pdf-lib/*）的许可证，缺一份就让构建失败。
- **旧文件读得回。** 上一版"每页一份"的 `<名>.pN.annot.json` 在整份文档还没有统一侧车时被读成一份文档显示（`pageCount` 取出现过的最大页号，真实页数由浏览器半边下次保存写回），旧文件原样保留不删。

## Alternatives considered

- **把标记烧进页面内容流（flatten）** —— 与用户的选择相反：原生注释可编辑、可删除、可评论，页面内容不被改写；代价是"只画内容不画注释"的自制栅格化流程看不见标记，这一路用消息里附的每页位图兜底。
- **在宿主侧用 pdf-lib 从 JSON 重新生成带批注的 PDF** —— 需要宿主侧重建"页面单位→点"的映射（每页视口只有浏览器侧有），还会把约 1 MB 的解析成本加到每个会话的宿主进程上；放在分块里则启动零成本，且页尺寸天然在手。
- **改用 @cantoo/pdf-lib（维护中的 fork）** —— 上游 pdf-lib 1.17.1 就是参考实现（pdf-annotate.js 写的正是它的低层 API）且是 MIT；fork 在注释写入这件事上没有我们需要的新能力。
- **直接引入 pdf-annotate.js** —— 它是"注释 UI + 写入器"整体，等于放弃本插件已有的 mark 模型、撤销栈与侧车管线；只借鉴它"自绘外观流"的做法。
- **中文文字批注也自绘外观** —— 需要把一份 CJK 字体（数 MB）嵌进产物，与"产物要小、要作为附件回传"冲突；改为保留 `/DA`+`/Contents` 交给阅读器合成（MuPDF 实测能显示中文，只是字形由阅读器自选）。
- **继续用分页 sidecar 作主格式** —— 与"一份 PDF 一次标注"的诉求直接冲突。
- **连续滚动 + PDF 文本层** —— 是另一次更大的改动（虚拟化、文本命中、滚动同步），与"先交付一份带批注的 PDF"无关，留作后续。

## Consequences

- 一份文档一次保存 = 两个文件 + 一条消息；会话收到的是可点开的带批注 PDF 附件，加上逐页位图与编号清单。
- 依赖面变大而启动成本不变：分块 6.8 MB → 7.9 MB（pdf-lib 及其依赖全部内联在懒加载分块里），主包 71 kB → 79 kB（新增文档座位与若干共享文案）。
- 分块内分成三层：`runtime.ts`（PDF.js 接缝与每页变换）、`annotate.ts`（写入器，纯函数 + pdf-lib）、`PdfBody.tsx`（文档控制器）；写入器可以在 Node 里用真 pdf-lib 写真文件、用真 PDF.js（legacy build）与 PyMuPDF 回读。
- 新增一条构建陷阱（急切 preload）与其护栏；分块 banner 变长（许可证）。
- 已知取舍：中文文字批注的外观由阅读器合成；`<名>.annotated.pdf` 是派生产物（原件被重新生成后要再保存一次才同步）；不做文本层与连续滚动。
- 验收（本机临时脚手架，不进仓，22/22）：真实构建产物 + 真实宿主路由 + Chromium 151，打开一份 3 页 PDF（第 2 页 `/Rotate 90`）→ 第 1、3 页各画一条箭头并写说明 → 一次「仅保存」写出 `verify.pdf.annot.json`（`pageCount: 3`，两条 mark 分别 `page: 1` / `page: 3`）与 `verify.pdf.annotated.pdf`（1500 B → 2255 B）→ 一次「保存并提交」发出 `[file, image, image, text]` 四个 part（附件 2255 B，两张标注位图，正文含「共 3 页，其中 2 页有标注」）。带批注 PDF 由 PDF.js 读回为 `1:Line 2:- 3:Line`（两条都有外观流、内容与批注文字一致），由 PyMuPDF 渲染出可见标记（含旋转页），控制台无报错。
