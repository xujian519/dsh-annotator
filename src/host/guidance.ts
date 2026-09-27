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
  '用户可能在附图预览里直接标注（箭头/框选/椭圆/手绘/文字），保存后你会收到一条【附图标注】开头、并附带标注图的用户消息。收到时按下列纪律处理：',
  '',
  '1. 先读标注文件（消息里给出绝对路径，形如 `<图名>.annot.json`）：`marks[]` 是按绘制顺序排列的标注，每条含 `kind`、`points`（图面像素坐标，原点在左上角）、`text`（用户的说明）与可选 `anchor`（该标注落在哪个 SVG 元素上：`title`/`id`/元素文字）。',
  '2. 标注图的绝对路径在消息里给出（形如 `<图名>.annotated.png`）。若你需要更精确地看图面细节，用图像输入能力或 `analyze_patent_figure` 读它。',
  '3. 逐条处理标注：每条标注都要落到具体的图面改动，并在答复里逐条回应（编号与标注一致）。无法实现的标注要说明原因，不要静默跳过。',
  '4. 修改附图以**标注所指的生成源**为准（绘制脚本、SVG 源或 `generate_patent_figure` 的入参），不要直接涂改导出的位图。未标注的部分保持不动。',
  '5. 改完图后重新渲染并核对：图面尺寸/坐标若变化，旧标注的坐标会失准，此时以 `anchor` 与标注文字为准复核一遍，再回报结果。',
].join('\n')
