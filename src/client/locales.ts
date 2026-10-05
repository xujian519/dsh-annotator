/**
 * Product copy of the annotator body.
 *
 * The dictionary is registered on the shell's locale service under
 * `annotator`, which is also what binds the `t` seat the body receives.
 * @module dsh-annotator/client/locales
 */

import type { TranslateVars } from './annotator-contract'

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
  pdfTitle: 'PDF 批注',
  previousPage: '上一页',
  nextPage: '下一页',
  pdfRendering: '正在渲染这一页…',
  pdfOpenFailed: '打开 PDF 失败：',
  documentScope: '共 {pages} 页 · {marks} 处批注',
  notReady: '还没有读取到这个 PDF 的宿主信息，请稍后再试。',
  mdTitle: 'Markdown 编辑',
  editMode: '编辑',
  diffMode: '对比',
  diffEmpty: '没有改动',
  editLoading: '正在载入 Markdown…',
  editLines: '共 {lines} 行',
  editStats: '改动 {hunks} 处 · +{added} −{removed} 行',
  discardEdit: '放弃修改',
  sendEdit: '送至会话',
  editSending: '正在提交…',
  editSent: '已提交给智能体（没有落盘）',
  editSendError: '提交失败：',
  editUnavailable: '当前组合没有会话服务，无法提交。',
  editNoSession: '这个文档的地址没有指向任何会话，无法提交。',
  editEofPending: '文件还没有读完；现在所做的修改以已载入的部分为基线。',
  editStale: '载入的内容在编辑期间变了（文件在磁盘上被改动过）：这份改动基于较早的版本，提交前请核对。',
  caretAt: '第 {line} 行 · 第 {column} 列',
  copyDiff: '复制 diff',
  diffCopied: '已复制这份 diff',
  copyFailed: '复制失败：',
  copyUnavailable: '这个环境没有剪贴板接口',
  hunkNote: '第 {line} 行起这一处的说明',
  hunkNotePlaceholder: '可选：为什么这么改（会随 diff 一起发给智能体）',
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
  pdfTitle: 'PDF annotations',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  pdfRendering: 'Rendering this page…',
  pdfOpenFailed: 'Opening the PDF failed: ',
  documentScope: '{pages} pages · {marks} marks',
  notReady: "This PDF's Host facts are not loaded yet; try again in a moment.",
  mdTitle: 'Markdown editor',
  editMode: 'Edit',
  diffMode: 'Diff',
  diffEmpty: 'No change',
  editLoading: 'Loading Markdown…',
  editLines: '{lines} lines',
  editStats: '{hunks} hunks · +{added} −{removed} lines',
  discardEdit: 'Discard',
  sendEdit: 'Send to agent',
  editSending: 'Sending…',
  editSent: 'Sent to the agent (nothing was written to disk)',
  editSendError: 'Sending failed: ',
  editUnavailable: 'This composition has no session service, so the edit cannot be sent.',
  editNoSession: 'This document’s address names no session, so the edit cannot be sent.',
  editEofPending: 'The file is not fully loaded yet; edits are diffed against the part that is.',
  editStale: 'The loaded content changed while you were editing (the file was modified on disk): this change is against an earlier version, so check it before sending.',
  caretAt: 'line {line} · col {column}',
  copyDiff: 'Copy diff',
  diffCopied: 'The diff is on the clipboard',
  copyFailed: 'Copying failed: ',
  copyUnavailable: 'this environment has no clipboard API',
  hunkNote: 'Note for the change at line {line}',
  hunkNotePlaceholder: 'Optional: why this change (it travels with the diff)',
}

/** Locale namespace this dictionary registers under. */
export const NAMESPACE = 'annotator'

/** Every copy key. */
export type CopyKey = keyof typeof zh

/**
 * Translate one key without the locale service.
 * @param locale - active locale id.
 * @param key - copy key.
 * @param vars - values interpolated into `{name}` placeholders.
 * @returns the localized string, falling back to Chinese.
 */
export function fallbackTranslate(locale: string, key: string, vars?: TranslateVars): string {
  const dictionary = locale.startsWith('en') ? en : zh
  const text = (dictionary as Record<string, string>)[key] ?? key
  if (vars === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (placeholder, name: string) => {
    const value = vars[name]
    return value === undefined ? placeholder : String(value)
  })
}
