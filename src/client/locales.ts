/**
 * Product copy of the annotator body.
 *
 * The dictionary is registered on the shell's locale service under
 * `annotator`, which is also what binds the `t` seat the body receives.
 * @module dsh-annotator/client/locales
 */

/** Chinese copy (the product's primary language). */
export const zh = {
  title: '附图标注',
  annotate: '标注',
  view: '查看',
  toolSelect: '选择',
  toolArrow: '箭头',
  toolRect: '框选',
  toolEllipse: '圈选',
  toolPen: '手绘',
  toolText: '文字',
  undo: '撤销',
  redo: '重做',
  clear: '清空',
  fitWidth: '适应宽度',
  actual: '100%',
  zoomIn: '放大',
  zoomOut: '缩小',
  note: '说明',
  notePlaceholder: '给这条标注写一句说明（例如「这个标号应指向滑套 34」）',
  summary: '总体说明',
  summaryPlaceholder: '可选：一句话说明这次要改什么',
  marks: '标注清单',
  noMarks: '还没有标注。选一个工具，直接在图上画。',
  delete: '删除',
  save: '仅保存',
  saveAndSend: '保存并提交给智能体',
  saving: '正在保存…',
  sending: '正在提交…',
  saved: '已保存：',
  sent: '已提交给智能体，标注文件：',
  loading: '正在载入附图…',
  unsupported: '这个文件不是可标注的附图（支持 SVG/PNG/JPEG/WebP/BMP/GIF）',
  loadFailed: '读取附图失败',
  stale: '这张图在上次标注之后已经更新过，旧标注的坐标可能失准，请核对后再提交。',
  anchor: '锚定',
  readError: '读取标注失败',
  saveError: '保存标注失败',
  emptyText: '（文字）',
} as const

/** English copy. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Figure annotations',
  annotate: 'Annotate',
  view: 'View',
  toolSelect: 'Select',
  toolArrow: 'Arrow',
  toolRect: 'Box',
  toolEllipse: 'Circle',
  toolPen: 'Draw',
  toolText: 'Text',
  undo: 'Undo',
  redo: 'Redo',
  clear: 'Clear',
  fitWidth: 'Fit width',
  actual: '100%',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  note: 'Note',
  notePlaceholder: 'Describe this mark (for example "this numeral should point at the sleeve 34")',
  summary: 'Summary',
  summaryPlaceholder: 'Optional: one line on what should change',
  marks: 'Marks',
  noMarks: 'No marks yet. Pick a tool and draw on the figure.',
  delete: 'Delete',
  save: 'Save only',
  saveAndSend: 'Save and send to agent',
  saving: 'Saving…',
  sending: 'Sending…',
  saved: 'Saved: ',
  sent: 'Sent to the agent; annotation file: ',
  loading: 'Loading figure…',
  unsupported: 'This file is not an annotatable figure (SVG/PNG/JPEG/WebP/BMP/GIF)',
  loadFailed: 'Reading the figure failed',
  stale: 'This figure changed since it was annotated; old marks may be misplaced. Check them before sending.',
  anchor: 'anchor',
  readError: 'Reading the annotation failed',
  saveError: 'Saving the annotation failed',
  emptyText: '(text)',
}

/** Locale namespace this dictionary registers under. */
export const NAMESPACE = 'annotator'

/** Every copy key. */
export type CopyKey = keyof typeof zh

/**
 * Translate one key without the locale service.
 * @param locale - active locale id.
 * @param key - copy key.
 * @returns the localized string, falling back to Chinese.
 */
export function fallbackTranslate(locale: string, key: string): string {
  const dictionary = locale.startsWith('en') ? en : zh
  return (dictionary as Record<string, string>)[key] ?? key
}
