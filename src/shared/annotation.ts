/**
 * The annotation data model shared by the browser half (which draws it) and the
 * Node half (which persists it).
 *
 * Coordinates are surface pixels: the origin is the surface's top-left corner and
 * one unit is one pixel at the surface's intrinsic size, so a mark means the same
 * thing whatever zoom or pane width the annotator ran at. A paged document is one
 * document whose marks each name the page they were drawn on, and the page's own
 * size is the unit those coordinates are measured in.
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
   *
   * For a mark on a page of a paged document the coordinates are that page's own
   * pixels, so they stay meaningful whatever zoom or pane width the mark was
   * drawn at; {@link AnnotationMark.page} names the page they belong to.
   */
  readonly points: readonly FigurePoint[]
  /** The user's note for this mark. */
  readonly text?: string
  /** 1-based page this mark sits on, for a figure that has pages. */
  readonly page?: number
  /** Element the mark points at, when the figure exposes one. */
  readonly anchor?: MarkAnchor
}

/**
 * Geometry of the annotated figure.
 *
 * A figure is either one surface or many pages, and the two carry different
 * facts: a single-surface figure measures itself in intrinsic pixels, a paged
 * document has no one size (each page does) and counts pages instead. The
 * validation in `src/host/store.ts` holds the two apart, so a reader never has
 * to guess which kind it holds.
 */
export interface AnnotatedFigure {
  /** The `dsh-resource://file/…` address the annotator opened. */
  readonly address: string
  /** Absolute path on the Host. */
  readonly path: string
  /** Media type of the figure file. */
  readonly mediaType: string
  /** Intrinsic width in pixels, for a single-surface figure. */
  readonly width?: number
  /** Intrinsic height in pixels, for a single-surface figure. */
  readonly height?: number
  /** Content hash of the figure at annotation time, used to detect a redraw. */
  readonly sha256: string
  /** Pages in the paged document these marks belong to. */
  readonly pageCount?: number
}

/**
 * Suffix naming one page's files inside a paged document's name.
 * @param page - 1-based page, or undefined for a single-surface figure.
 * @returns the suffix, empty when the figure has no pages.
 */
export function pageFileSuffix(page: number | undefined): string {
  return page === undefined ? '' : `.p${page}`
}

/**
 * Describe how many pages a paged figure has.
 * @param figure - the annotated figure.
 * @param locale - language of the surrounding message.
 * @returns the scope in words, or an empty string for a single-surface figure.
 */
export function describeFigureScope(figure: AnnotatedFigure, locale: SummaryLocale): string {
  if (figure.pageCount === undefined) return ''
  return locale === 'zh' ? `共 ${figure.pageCount} 页` : `${figure.pageCount} pages`
}

/**
 * List the pages that carry at least one mark.
 * @param document - the annotation document.
 * @returns 1-based page numbers, ascending; empty for a single-surface figure.
 */
export function annotatedPages(document: AnnotationDocument): number[] {
  const pages = new Set<number>()
  for (const mark of document.marks) {
    if (mark.page !== undefined) pages.add(mark.page)
  }
  return [...pages].sort((left, right) => left - right)
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
  // A mark that names a page carries it, so one numbered list can span the pages
  // of a document without its coordinates becoming ambiguous.
  const page = mark.page === undefined ? '' : (zh ? `第 ${mark.page} 页 ` : `page ${mark.page} `)
  const note = mark.text !== undefined && mark.text.trim() !== ''
    ? (zh ? `：${mark.text.trim()}` : `: ${mark.text.trim()}`)
    : (zh ? '：（未写说明）' : ': (no note)')
  return `${marker} ${page}${describeShape(mark, locale)}${describeAnchor(mark, locale)}${note}`
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
