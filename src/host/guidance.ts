/**
 * The model-facing guidance this plugin contributes while it is mounted.
 *
 * The annotator delivers work to the agent as an ordinary user message, so the
 * agent needs to know what that message means and what a complete response to it
 * looks like. The text is a static prompt section: it names no plugin internals,
 * only the files the message points at.
 * @module dsh-annotator/host/guidance
 */

/** Section order used for the annotation guidance (just before deliverable references). */
export const GUIDANCE_ORDER = 8990

/** Stable section name, unique in the assembled prompt. */
export const GUIDANCE_NAME = 'dsh-annotator:annotations'

/** The guidance text appended to the system prompt. */
export const GUIDANCE = [
  '## 附图标注（dsh-annotator）',
  '',
  '用户可能在文档预览里直接标注（箭头/框选/椭圆/手绘/文字），保存后你会收到一条【附图标注】开头、并附带标注图（PDF 还会带上带批注的 PDF 附件）的用户消息。收到时按下列纪律处理：',
  '',
  '1. 先读标注文件（消息里给出绝对路径，形如 `<图名>.annot.json`，图名含扩展名，例如 `fig1.svg.annot.json`）：`marks[]` 是按绘制顺序排列的标注，每条含 `kind`、`points`（图面像素坐标，原点在左上角）、`text`（用户的说明）与可选 `anchor`（该标注落在哪个 SVG 元素上：`title`/`id`/元素文字）。',
  '2. **PDF 是整份文档一份标注**：`figure.pageCount` 是总页数，每条标注用 `page` 指明它是第几页画的，`points` 是那一页自己的坐标（原点在该页左上角）。看每条标注前先确认它的 `page`。',
  '3. 标注图在消息里给出路径（图片形如 `<图名>.annotated.png`）。PDF 的产物是一份**带批注的 PDF**（形如 `report.pdf.annotated.pdf`，写在原件旁边，并作为附件随本条消息发送）：里面的批注是原生 PDF 注释对象（`/Ink` 手绘、`/Square` 框选、`/Circle` 圈选、`/Line` 箭头、`/FreeText` 文字），任何阅读器都能显示与核对；消息里附的每页图片是同一批批注的位图版本。',
  '4. 逐条处理标注：每条标注都要落到具体的图面改动，并在答复里逐条回应（编号与标注一致）。无法实现的标注要说明原因，不要静默跳过。',
  '5. 修改附图以**标注所指的生成源**为准（绘制脚本、SVG 源或 `generate_patent_figure` 的入参），不要直接涂改导出的位图；PDF 同理，改的是生成该 PDF 的源头，不是那份带批注的副本。未标注的部分保持不动。',
  '6. 改完图后重新渲染并核对：图面尺寸/坐标若变化，旧标注的坐标会失准，此时以 `anchor` 与标注文字为准复核一遍，再回报结果。',
].join('\n')

/** Section order used for the Markdown edit-proposal guidance (after the annotation one). */
export const EDIT_GUIDANCE_ORDER = 8991

/** Stable section name, unique in the assembled prompt. */
export const EDIT_GUIDANCE_NAME = 'dsh-annotator:markdown-edits'

/** The guidance text appended for messages that carry a Markdown difference. */
export const EDIT_GUIDANCE = [
  '## Markdown 修改建议（dsh-annotator）',
  '',
  '用户可能在文档预览里直接编辑 Markdown，保存后你会收到一条【文档修改建议】开头、正文是一段 unified diff 的用户消息（`--- a/<文件名>`、`+++ b/<文件名>`，`@@` 头给出两侧的起始行与行数）。收到时按下列纪律处理：',
  '',
  '1. 先读文件（消息里给出路径）。**用户没有把改动写进磁盘**：磁盘上的文件仍是旧版，`a` 侧是用户打开时的那一版，`b` 侧是用户改完的结果。',
  '2. 把 diff 应用到源文件：`-` 行删除、`+` 行写入、空格开头的是上下文（保持原样），逐处落地；不要重写整个文件，diff 之外的部分保持不动。',
  '3. 消息里若说「另有 N 处改动未在本消息里展开」，完整结果就是随消息发送的 `<文件名>.edited.md` 附件；以它为准。',
  '4. 消息里若带「我的说明：」清单，那是用户对某一行/某一处改动写的理由（形如 `1. 第 6 行（@@ -3,7 +3,7 @@）：…`）；落地时按它判断意图，说明里提到的行号是**基线（a 侧）**的行号。',
  '5. 消息里若说文件在编辑期间被改动过、或 diff 以整块替换呈现，先核对再落地；无法安全应用时说明原因，不要猜着改。',
  '6. 落地后逐处回应（顺序与 diff 一致），并说明哪些改动你没有采纳以及为什么。',
].join('\n')
