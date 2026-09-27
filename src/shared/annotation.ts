/**
 * The annotation data model shared by the browser half (which draws it) and the
 * Node half (which persists it).
 *
 * Coordinates are figure pixels: the origin is the figure's top-left corner and
 * one unit is one image pixel at the figure's intrinsic size, so a mark means the
 * same thing whatever zoom or pane width the annotator ran at.
 * @module dsh-annotator/shared/annotation
 */

/** Schema version of the sidecar document. */
export const ANNOTATION_VERSION = 1

/**
 * Schema version of the v2 sidecar document.
 *
 * v2 is written by the sibling annotator that shares a workbench with this plugin
 * (Sati). It carries the same marks and the same figure facts, but names the figure
 * `target` instead of `figure` and records that target's kind. This plugin reads v2
 * documents and keeps writing its own {@link ANNOTATION_VERSION} ones — the
 * translation lives in `src/host/store.ts`.
 */
export const ANNOTATION_VERSION_V2 = 2

/** One mark's shape kind. */
export type MarkKind = 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text'

/** One point in figure pixel coordinates. */
export type FigurePoint = readonly [number, number]

/** A rectangle in figure pixels: x, y, width, height. */
export type FigureBox = readonly [number, number, number, number]

/** What the mark landed on, when the figure is an inlined SVG. */
export interface MarkAnchor {
  /** Element name of the innermost SVG element under the mark's tip. */
  readonly tag: string
  /** That element's `id`, when it declares one. */
  readonly id?: string
  /** That element's `<title>` text, when it declares one (Graphviz names its nodes here). */
  readonly title?: string
  /** That element's own text content, trimmed and capped. */
  readonly text?: string
  /** Bounding box of that element in figure pixels: x, y, width, height. */
  readonly bbox: FigureBox
}

/** One annotation the user drew. */
export interface AnnotationMark {
  /** Stable mark id, unique inside one document. */
  readonly id: string
  /** Shape kind. */
  readonly kind: MarkKind
  /** Stroke color as a CSS hex string. */
  readonly color: string
  /**
   * Shape geometry in figure pixels. An arrow carries tail then head, a `rect`
   * or `ellipse` carries two opposite corners, `pen` carries the sampled path,
   * and `text` carries its anchor point only.
   */
  readonly points: readonly FigurePoint[]
  /** The user's note for this mark. */
  readonly text?: string
  /** Element the mark points at, when the figure exposes one. */
  readonly anchor?: MarkAnchor
}

/** Geometry of the annotated figure. */
export interface AnnotatedFigure {
  /** The `dsh-resource://file/…` address the annotator opened. */
  readonly address: string
  /** Absolute path on the Host. */
  readonly path: string
  /** Media type of the figure file. */
  readonly mediaType: string
  /** Intrinsic width in pixels. */
  readonly width: number
  /** Intrinsic height in pixels. */
  readonly height: number
  /** Content hash of the figure at annotation time, used to detect a redraw. */
  readonly sha256: string
  /**
   * 1-based page the marks belong to, for a figure whose annotation is one page
   * of a paged document. Width and height are that page's own size, so marks stay
   * page-relative and survive any zoom or pane width.
   */
  readonly page?: number
  /** Pages in that document, for the model-facing text. */
  readonly pageCount?: number
}

/**
 * Suffix naming one page's sidecar files inside a paged document's name.
 * @param page - 1-based page, or undefined for a single-surface figure.
 * @returns the suffix, empty when the figure has no pages.
 */
export function pageFileSuffix(page: number | undefined): string {
  return page === undefined ? '' : `.p${page}`
}

/**
 * Describe which part of a figure the marks belong to.
 * @param figure - the annotated figure.
 * @param locale - language of the surrounding message.
 * @returns the scope in words, or an empty string for a single-surface figure.
 */
export function describeFigureScope(figure: AnnotatedFigure, locale: SummaryLocale): string {
  if (figure.page === undefined) return ''
  const zh = locale === 'zh'
  if (figure.pageCount === undefined) return zh ? `第 ${figure.page} 页` : `page ${figure.page}`
  return zh ? `第 ${figure.page} 页/共 ${figure.pageCount} 页` : `page ${figure.page} of ${figure.pageCount}`
}

/** The sidecar document persisted beside one figure. */
export interface AnnotationDocument {
  /** Schema version. */
  readonly version: typeof ANNOTATION_VERSION
  /** The figure these marks belong to. */
  readonly figure: AnnotatedFigure
  /** ISO timestamp of the first save. */
  readonly createdAt: string
  /** ISO timestamp of this save. */
  readonly updatedAt: string
  /** Marks in draw order. */
  readonly marks: readonly AnnotationMark[]
  /** The user's own one-paragraph summary, when they wrote one. */
  readonly summary?: string
}

/** Language used when rendering the model-facing summary lines. */
export type SummaryLocale = 'zh' | 'en'

/** Round one figure coordinate for model-facing text. */
function round(value: number): number {
  return Math.round(value)
}

/** Describe one mark's shape in words, for the model-facing summary. */
function describeShape(mark: AnnotationMark, locale: SummaryLocale): string {
  const [first, second] = mark.points
  const zh = locale === 'zh'
  switch (mark.kind) {
    case 'arrow':
      return first !== undefined && second !== undefined
        ? (zh ? `箭头 (${round(first[0])},${round(first[1])}) → (${round(second[0])},${round(second[1])})`
          : `arrow (${round(first[0])},${round(first[1])}) → (${round(second[0])},${round(second[1])})`)
        : (zh ? '箭头' : 'arrow')
    case 'rect':
      return first !== undefined && second !== undefined
        ? (zh ? `矩形 (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`
          : `rectangle (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`)
        : (zh ? '矩形' : 'rectangle')
    case 'ellipse':
      return first !== undefined && second !== undefined
        ? (zh ? `椭圆 (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`
          : `ellipse (${round(first[0])},${round(first[1])})-(${round(second[0])},${round(second[1])})`)
        : (zh ? '椭圆' : 'ellipse')
    case 'pen':
      return zh ? `手绘线（${mark.points.length} 点）` : `freehand stroke (${mark.points.length} points)`
    case 'text':
      return first !== undefined
        ? (zh ? `文字 位于 (${round(first[0])},${round(first[1])})` : `text at (${round(first[0])},${round(first[1])})`)
        : (zh ? '文字' : 'text')
  }
}

/** Describe what a mark points at, when the figure exposed an element. */
function describeAnchor(mark: AnnotationMark, locale: SummaryLocale): string {
  const anchor = mark.anchor
  if (anchor === undefined) return ''
  const zh = locale === 'zh'
  const parts: string[] = []
  if (anchor.title !== undefined && anchor.title !== '') parts.push(zh ? `元素标题「${anchor.title}」` : `element title "${anchor.title}"`)
  if (anchor.id !== undefined && anchor.id !== '') parts.push(zh ? `id=${anchor.id}` : `id=${anchor.id}`)
  if (anchor.text !== undefined && anchor.text !== '') parts.push(zh ? `元素文字「${anchor.text}」` : `element text "${anchor.text}"`)
  if (parts.length === 0) parts.push(`<${anchor.tag}>`)
  return `（${parts.join('，')}）`
}

/**
 * Render one mark as a numbered line the model reads.
 * @param mark - the mark to describe.
 * @param index - zero-based position in the document, rendered as a circled number.
 * @param locale - language of the surrounding message.
 * @returns one line of the annotation summary.
 */
export function describeMark(mark: AnnotationMark, index: number, locale: SummaryLocale): string {
  const zh = locale === 'zh'
  const marker = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][index] ?? `${index + 1}.`
  const note = mark.text !== undefined && mark.text.trim() !== ''
    ? (zh ? `：${mark.text.trim()}` : `: ${mark.text.trim()}`)
    : (zh ? '：（未写说明）' : ': (no note)')
  return `${marker} ${describeShape(mark, locale)}${describeAnchor(mark, locale)}${note}`
}

/**
 * Render every mark as the numbered list carried into the Session.
 * @param document - the saved annotation document.
 * @param locale - language of the surrounding message.
 * @returns one line per mark.
 */
export function describeMarks(document: AnnotationDocument, locale: SummaryLocale): string[] {
  return document.marks.map((mark, index) => describeMark(mark, index, locale))
}
