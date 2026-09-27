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
