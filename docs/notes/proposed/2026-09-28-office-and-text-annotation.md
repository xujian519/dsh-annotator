# Note: Office 文档与文本源（md）的标注

Status: proposed

> 后续：[2026-09-28-markdown-edit-and-diff.md](./2026-09-28-markdown-edit-and-diff.md) 取代了本条里 **md 按行标注**那半（md 改走"编辑 + 差异"路线）；**Office 部分仍然有效**。

## Problem

本插件目前在**像素面**上标注：图片、SVG、PDF（整份文档一份标注）。要覆盖 Office 文档与 Markdown，难点不在"再画一个画布"，而在这两类文档没有"像素面"这回事：

- **Office 的面不是文件本身。** DSH 内置的 Office 预览把 `doc/docx/ppt/pptx` 交给宿主 `officeToPdf`（LibreOffice）转成 PDF，再交给共享 PDF 正文渲染（证据 A）。所以任何画在 Office 上的坐标天然是**派生渲染**的坐标——本机实测：同一套引擎转一份 31 页 docx 用时 1.76s、A4 595.3×841.9pt、每页都有文本层（373–530 字符/页），但 `missingFonts` 报了 7 种（宋体/黑体/仿宋_GB2312/楷体_GB2312/Calibri…），页面断行与 Word 不保证一致（证据 B）。
- **md 没有面。** 内置 Markdown 预览是 `text-pages` 的累积文本（证据 C），渲染出来的 DOM 不带源行号（证据 D）：像素坐标会随 reflow 失效，而智能体真正要改的是**源文件的行**。
- 另外两个岔路要一次定掉：**是否接管内置预览**（`documentPreviews` 的 `priority: 'extension'` 会赢过 `'builtin'`，证据 J），以及**是否把 `remote.officeToPdf` 当硬依赖**（撞上 AGENTS.md §2.6「误配置响亮失败」）。

不解决它，Office 与 md 就只能继续由内置预览只读打开，标注能力在这两类文档上是空的。

## Decision

分两个家族，共用现有的侧车、守卫、投递链路；数据模型在 v1 内**加性**扩展，不升版本。

### A. Office：把"转换后的 PDF"当被标注面，复用整条 PDF 管线

- 注册自己的 `documentPreviews` 实现（`priority: 'extension'`、`loading: 'renderer'`），接管 `doc/docx/ppt/pptx`；用户仍可在查看器下拉里切回内置 Office 预览——与现在图片/PDF 的相处方式一致。
- 正文内用 `ctx.remote.officeToPdf.render(sessionId, path, 'foreground', signal)` 取转换后的 PDF 字节（证据 E：任何注入 `remote` 的客户端插件都能拿到该命名空间；内置 office 就是这么用的），并在成功/失败时回调 owner 的 `loaded(version)` / `failed()`。
- 拿到字节后**完全复用现有 PDF 管线**：同一份字节既交给 PDF.js 画页，也交给 pdf-lib 写回原生注释对象。唯一要动的接缝是 `PdfBody` 的字节来源（现在是 `props.content.kind === 'bytes'`，证据 F）——抽成"字节提供者"，PDF 走 owner 字节、Office 走转换结果。
- 图面事实：`figure.path` 仍是 Office 本体（侧车名 `<名>.docx.annot.json`），`figure.sha256` 是**源文件**的哈希（源被重写要告警），新增 `figure.rendered = { via: 'officeToPdf', generation, sha256, missingFonts }`——其中 `rendered.sha256` 是**转换后 PDF 字节**的哈希（标注实际画在其上的那一份），`generation` 是转换器世代。这样**源变了**与**渲染变了**（引擎/字体配置换代）可以分别判定、分别告警。
- 产物：`<名>.docx.annotated.pdf` = 转换后 PDF 的副本 + 原生注释对象（`/Line` `/Square` `/Circle` `/Ink` `/FreeText`），随消息作为附件发送——与 PDF 家族逐字一致。
- 消息结尾纪律改为：带批注 PDF 是 LibreOffice 渲染（可能缺字体、断行与 Word 不一致），要改的是 `.docx` 源。

### B. 文本源（md）：按源行区间锚定，不做像素标注

- 注册 `text-pages` 实现（`priority: 'extension'`），正文自己按行渲染源文本（每行带 `data-*` 行号），用户选行区间 + 写说明。
- mark 新增 `kind: 'comment'`，几何是 `range: { startLine, endLine }` + `quote`（引文，截断），不带 `points`。
- `figure` 新增第三种几何 `lineCount`（由 `content.pages[]` 的 `offset`+`lines` 得出，证据 G）。
- 产物：`<名>.md.annotated.md` = 插了 `〔①〕` 标记的审阅副本；消息里逐条给 `L12–L14：「引文」：说明`，智能体直接改源文件。
- **不给 md 做像素标注**：渲染 DOM 没有源行映射（证据 D），reflow 后坐标失去意义。

### 共用的模型改动（v1 内加性扩展）

- `figure` 三选一：`surface`(width/height) | `pages`(pageCount，PDF 与 Office 共用) | `text`(lineCount)；校验保留“恰好一种几何”。
- mark 两类：绘制类（`points`…）与 `comment`（`range`+`quote`）；校验“恰好一类形状”。
- `anchor` 增加可选判别式，允许 `kind: 'text'`（框住的文字 + 包围盒），为下一步的文本层锚留位；旧文档没有这个字段，读回不受影响。
- **不写 v3 的理由**：Sati 只认 v1 的 `figure.width/height` 与 v2（证据 H）。升到 v3 会让 Sati 连我们现有的 svg/png 侧车都读不出来，把 README 里已声明的互通性倒着砍一刀；而加性字段对 Sati 无影响（pdf/office/md 那几种它本来就读作“从未标注”）。

## Alternatives considered

- **只替换内置 Office 正文里的 PDF 子槽**（注册 `sidebar.right.tab.document.office.pdf`，key 用内置实现 id、`priority` 调低来 shadow）：代码量约 1/4，白拿转换缓存、错误文案、缺字体提示、标签页保活。落选：内置 office 的 id 是模块内 `const`，没导出（证据 I）；子槽名与它传给子槽的 props 形状都是私有实现。上游改个名字就静默失效，等于把插件挂在别人的内部结构上——公开扩展点只有 `documentPreviews` 与文档槽。
- **md 走像素标注**：落选。渲染 DOM 无源行映射（证据 D），reflow 后坐标失去意义；而按行锚定既更稳又更便宜。
- **Office 写原生 Word 批注**（`<名>.docx.annotated.docx`：`word/comments.xml` + 关系 + 内容类型，锚到 `commentRangeStart/End`）：在 Word 里可见可编辑，最接近 PDF 那条“原生注释对象”的体验。落选（本期）：从“PDF 页上的一个矩形”到 OOXML 文本区间没有可靠映射，要真做就得先自研 docx 文本视图。折中已在 A 里——把框住的文字作为 `quote` 交给智能体，由它去 docx 里定位。
- **xls/xlsx 一并接管**：落选（本期）。内置 Excel 预览是浏览器内的表格引擎，接管等于把“能读能算的表格”换成 PDF 渲染，阅读体验倒退；等真有单元格锚定方案再说。
- **升 `version: 3`**：落选，理由见上（以牺牲既有互通换取一个更漂亮但不必要的版本号）。

## Consequences

换来的：Office 与 md 都进同一条“保存 + 送会话”链路，侧车格式、路由守卫、投递、消息纪律、覆盖率门禁都不另起一套；Office 的坐标不可靠由**三条一起兜**——`rendered` 事实（渲染换代可判定）、`quote` 文本锚（像素之外的第二锚）、消息里的纪律（改源不改副本）。

付出的与要认的风险：

1. **接管 docx/pptx 的默认预览**：内置的缺字体提示与“安装字体”动作不再出现，我们要自己显示 `missingFonts`——否则用户在缺字体的渲染上标错位置却毫无提示。
2. **§2.6 的取舍**：`remote.officeToPdf` 在官方 web 客户端装配里恒在（证据 E），但本插件不只服务那一种装配。拟用上游自己的手法 `ctx.inject(['remote','remote.officeToPdf'], …)`，把“转换不可用”做成**可见的降级态**（预览里一条明确提示 + 一键切回内置预览），而不是静默挂半个插件。这条是对 §2.6 的修订，按 §8 属“改 Host/Client 契约”，要单独拍板并落进 AGENTS.md。
3. **体积上限**：`MAX_REVIEW_BYTES` 24MB 对带图大 deck 可能不够（实测 31 页纯文字 258KB，证据 B）；要么按需提高，要么允许“只存标注、不写副本”。
4. **转换成本**：实测热态 1.76s，冷启动要拉起 LibreOffice；body 重挂载会再取一次（宿主侧内容寻址缓存兜住），标签页保活没做。
5. **侧车互通的边界要写清**：Sati 只认 svg/png，本插件写下的 pdf/office/md 侧车它读作“从未标注”（证据 H）——这是既有事实，本次要在 README 里说明白。
6. **覆盖率**：新增分支（三选一几何、两类 mark、Office 下载失败/服务缺失降级、md 累积文本尚未 `eof`）都要进 100% per-file 门禁；没有豁免。

## 分期

| 期 | 内容 | 结束判据 |
|---|---|---|
| 一 | 模型加性扩展 + Office 注册/转换/复用 PDF 管线 + `rendered` 事实 + guidance/README | 真机 docx 跑通“打开→画→保存→磁盘出现 `<名>.docx.annot.json` 与 `<名>.docx.annotated.pdf`→会话收到消息与附件” |
| 二 | 文本源 md：按行渲染 + 行区间标注 + `lineCount` + `<名>.md.annotated.md` | 真机 md 跑通同一条链路，消息里逐条给行区间与引文 |
| 三 | 候选：PDF/Office 文本层锚（`anchor.kind='text'`）、原生 Word 批注、xlsx 单元格锚、HTML | 各自单独出 note |

一期与二期的模型改动是同一批，可以一起落；两条链路彼此不阻塞。

## 验收（按 §9 的纪律）

- **独立解析器读结构 + 独立渲染器看图 + 真浏览器走交互**，三样都过才算完：PyMuPDF 解析 `.annotated.pdf` 里的注释对象与页面图像；真机脚手架加载真实 `lib/` 产物与真实宿主路由跑完整交互。
- **负控制**：Office 转换失败 / `remote.officeToPdf` 缺失时必须走到“可见降级 + 可切回内置预览”，不能是空白页——这条要有一条“先制造失败、确认变红、再回退”的记录。
- **桩与真身同形**（§9.5）：Office 的 Remote 替身要能返回真 PDF 字节并触发 `loaded`/`failed` 回调；只回一个 `{ ok: true }` 而不触发回调的替身会把接缝 bug 藏起来。

## 待决（需要产品决定的三件事）

1. **Office 是否包含 xls/xlsx**：接管 = 牺牲内置表格阅读；只做 doc/ppt 则无损（内置对它们本来就是 PDF 渲染）。
2. **文本家族是否连 txt/代码文件一起**：同一条按行锚定链路几乎零额外成本，但会接管这些后缀的默认预览。
3. **§2.6 例外**：允许 `remote.officeToPdf` 缺失时以可见降级继续挂载（推荐），还是坚持 fail-closed（没有它就不挂插件）。

## 证据

| 代号 | 内容 | 位置 |
|---|---|---|
| A | 内置 Office 预览：`doc/docx/ppt/pptx`、`loading:'renderer'`、priority builtin；子槽 `sidebar.right.tab.document.office.pdf` → LazyPdfBody；`scope.remote.officeToPdf.render(file.sessionId, file.path, priority, signal)` | `packages/client/ui-sidebar-documentpreview/src/client/office/index.ts:32-33,41-45,66-69,70-79` |
| B | 本机实测（2026-09-28，bundled kit CLI）：31 页 A4、1.76s、`missingFonts` 7 项；pdf_scan 每页 `hasTextLayer: true`、`textChars` 373–530、输出 257,958 B | 临时产物 `/tmp/da-spike/sample.pdf`（不进仓） |
| C | `DocumentContent` 三态；md 声明为 `text-pages` | `ui-sidebar-documentpreview/src/client/document/contract.ts:17-30`、`src/client/markdown/index.ts:17` |
| D | Markdown 用 `MarkdownText` 渲染，无源行属性（`source-line`/`data-line` 在该包无命中） | `src/client/markdown/MarkdownBody.tsx:33-37` |
| E | 任何注入 `remote` 的客户端插件都挂载 `officeToPdf` 命名空间；签名 `render(workspaceFileScopeId: SessionId, path, priority, signal)`；Host 侧按会话文件授权读源、转 PDF、返回 `missingFonts`/`generation` | `packages/api/remotes/src/client/index.ts:173,188`、`packages/document/office-to-pdf/lib/typert.remote-client.d.ts`、`packages/document/office-to-pdf/src/index.ts:159-167` |
| F | PDF 正文唯一的字节来源 | `src/client/pdf/PdfBody.tsx:155` |
| G | `DocumentTextPage{offset,text,lines}`：`offset` 是 1-based 起始行；`lastLineLoaded` | `contract.ts:7-11`、`src/client/text/lines.ts:22-36` |
| H | Sati 只认 v2 与 v1 的 `figure.width/height`（缺则整体判废） | `~/projects/Sati/ui/src/types/annotationReference.ts:340-347,358-377,412-418` |
| I | 内置 office 的 id 是模块内 `const`、未导出；同 priority 同 key 冲突、不同 priority 可 shadow 且最低者渲染 | `office/index.ts:32`、`packages/client/ui-slots/src/index.ts:1219-1230` |
| J | `priority: 'extension'` 赢过 `'builtin'`；`loading` 模式定义 | `ui-sidebar-documentpreview/src/client/document/registry.ts:5-6,20-28,36-49` |
| K | 文档工具栏确有查看器切换控件（`data-document-viewer-menu`，`t('openWith')`），即"接管后仍可切回内置预览"这条 UX 成立 | `ui-sidebar-documentpreview/src/client/TextPreview.tsx:9,272` |

上游路径均相对 `~/projects/deepseek-harness`；本插件路径相对本仓根。
