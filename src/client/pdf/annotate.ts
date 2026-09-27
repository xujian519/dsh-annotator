/**
 * Writing the user's marks into the document as native PDF annotations.
 *
 * The saved document is the original with the marks added, never a picture of the
 * page: an arrow becomes a `/Line`, a box a `/Square`, an ellipse a `/Circle`, a
 * freehand stroke an `/Ink`, and a text note a `/FreeText`. Each one carries the
 * note as `/Contents` and an appearance stream this module draws itself, so a
 * reader shows exactly what the user drew instead of guessing a default.
 *
 * A paged document's marks are measured in page units, and `pdf.js` answers the
 * transform from PDF user space to those units for each page — so a page that is
 * rotated, scaled by `/UserUnit`, or whose media box does not start at the origin
 * still lands where the user drew it.
 *
 * `FreeText` is the one exception to the self-drawn appearance: an appearance that
 * shows Latin text is drawn here, but one that shows Chinese cannot be — that would
 * need a CJK font embedded in the file. Such a note keeps its `/DA`, `/Contents`
 * and `/Rect`, and the reader synthesizes the appearance from its own fonts.
 * @module dsh-annotator/client/pdf/annotate
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib'
import type { AnnotationMark, FigurePoint } from '../../shared/annotation'

/** One page's marks, and the transform that maps PDF user space to page units. */
export interface PageAnnotateInput {
  /** 1-based page number. */
  readonly page: number
  /**
   * `pdf.js` viewport transform at scale 1, as `[a b c d e f]`: a user-space point
   * `(x, y)` is at `(a·x + c·y + e, b·x + d·y + f)` in page units.
   */
  readonly transform: readonly number[]
  /** Marks drawn on this page, in page units. */
  readonly marks: readonly AnnotationMark[]
}

/** Stroke width of every mark, matching the overlay's own (`src/client/render.ts`). */
const STROKE_WIDTH = 2.5

/** Arrow head length in page units, matching the overlay's own. */
const ARROW_HEAD = 14

/** Half-angle of the arrow head, in radians. */
const ARROW_SPREAD = Math.PI / 7

/** Font size a text mark draws at, in page units. */
const TEXT_FONT_SIZE = 16

/** Control point ratio that turns four Bézier curves into an ellipse. */
const ELLIPSE_KAPPA = 0.5522847498307936

/** Smallest rectangle side, so a mark stays clickable in a reader. */
const MIN_RECT_SIDE = 1

/** Name the text appearances and the default appearance use for Helvetica. */
const FONT_NAME = 'Helv'

/** Round one coordinate to two decimals, as a PDF number operator. */
function num(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/**
 * Map one page-unit point into PDF user space.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param point - a point in page units.
 * @returns the point in user space.
 * @throws {Error} when the transform is degenerate and cannot be inverted.
 */
export function toUserSpace(transform: readonly number[], point: FigurePoint): FigurePoint {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = transform
  const determinant = a * d - b * c
  if (determinant === 0) throw new Error('the page transform is degenerate')
  const x = point[0] - e
  const y = point[1] - f
  return [(d * x - c * y) / determinant, (a * y - b * x) / determinant]
}

/**
 * Ratio between page units and user-space units on one page.
 *
 * The transform has no skew, so one factor does for every direction: a stroke that
 * reads 2.5 page units wide is `2.5 / scale` wide in the file.
 *
 * @param transform - `[a b c d e f]`, user space → page units.
 * @returns page units per user-space unit.
 */
export function unitScale(transform: readonly number[]): number {
  const [a = 0, b = 0] = transform
  return Math.hypot(a, b)
}

/** A rectangle in user space, normalized so both sides are positive. */
interface UserRect {
  /** Lower-left corner. */
  readonly x: number
  /** Lower-left corner. */
  readonly y: number
  /** Positive width. */
  readonly width: number
  /** Positive height. */
  readonly height: number
}

/**
 * Bounding rectangle of a set of user-space points, widened so no side is degenerate.
 * @param points - points to enclose.
 * @param padding - space kept around the points, in user-space units.
 * @returns the rectangle.
 */
function boundsOf(points: readonly FigurePoint[], padding: number): UserRect {
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  const left = Math.min(...xs) - padding
  const right = Math.max(...xs) + padding
  const bottom = Math.min(...ys) - padding
  const top = Math.max(...ys) + padding
  return {
    x: left,
    y: bottom,
    width: Math.max(right - left, MIN_RECT_SIDE),
    height: Math.max(top - bottom, MIN_RECT_SIDE),
  }
}

/**
 * Whether every character of a string fits the font's own single-byte encoding.
 *
 * The check reads one UTF-16 code unit per element, which is what `for…of` hands
 * back for the characters that matter here: anything outside Latin-1 — a CJK
 * character, or half of an astral pair — is above the boundary either way.
 */
function latinEncodable(text: string): boolean {
  for (const character of text) {
    if (character.charCodeAt(0) > 0xff) return false
  }
  return true
}

/** A mark's geometry, restated in user space. */
interface PlacedMark {
  /** The mark's points in user space. */
  readonly points: readonly FigurePoint[]
  /** Stroke width in user-space units. */
  readonly width: number
  /** Arrow head length in user-space units. */
  readonly head: number
  /** Text size in user-space units. */
  readonly textSize: number
}

/**
 * Restate one mark's geometry in user space.
 * @param mark - the mark, in page units.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @returns the placed geometry.
 */
function place(mark: AnnotationMark, transform: readonly number[]): PlacedMark {
  const scale = unitScale(transform)
  return {
    points: mark.points.map(point => toUserSpace(transform, point)),
    width: STROKE_WIDTH / scale,
    head: ARROW_HEAD / scale,
    textSize: TEXT_FONT_SIZE / scale,
  }
}

/** A text mark's lines and the user-space box they occupy. */
interface TextLayout {
  /** The note's lines, in draw order. */
  readonly lines: readonly string[]
  /** The box the text occupies, in user space. */
  readonly box: UserRect
  /** Baseline of the first line, in user space. */
  readonly baseline: FigurePoint
}

/** Width of one character at a given size: a CJK glyph fills its em, Latin ones do not. */
function characterWidth(character: string, size: number): number {
  return character.charCodeAt(0) >= 0x2e80 ? size : size * 0.62
}

/** Estimated width of one line of text, in the same units as the size. */
function lineWidth(line: string, size: number): number {
  let width = 0
  for (const character of line) width += characterWidth(character, size)
  return width
}

/**
 * Lay one text mark out in user space.
 *
 * The anchor is the point the user clicked; the note extends to its right and above
 * it, exactly as the overlay draws it, and the box is the transformed outline of
 * that region — so a rotated page moves the note with the drawing.
 *
 * @param mark - the text mark, in page units.
 * @param anchor - the mark's anchor point, in page units.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param placed - the mark's geometry in user space.
 * @returns the lines and the box they need.
 */
function layoutText(
  mark: AnnotationMark,
  anchor: FigurePoint,
  transform: readonly number[],
  placed: PlacedMark,
): TextLayout {
  const anchorUnit = anchor
  const lines = (mark.text ?? '').split('\n')
  const size = placed.textSize
  // The box has to hold the text whichever way it is drawn: an appearance this
  // module draws uses the line lengths below, and one a reader synthesizes is
  // clipped to the same rectangle.
  const width = lines.reduce((widest, line) => Math.max(widest, lineWidth(line, size)), 0) + size * 0.5
  const height = Math.max(lines.length, 1) * size * 1.35
  const topLeft: FigurePoint = [anchorUnit[0], anchorUnit[1] - size]
  const bottomRight: FigurePoint = [anchorUnit[0] + width, anchorUnit[1] - size + height]
  const corners = [toUserSpace(transform, topLeft), toUserSpace(transform, bottomRight)]
  return {
    lines,
    box: boundsOf(corners, 0),
    baseline: toUserSpace(transform, [anchorUnit[0], anchorUnit[1]]),
  }
}

/**
 * The points one mark draws, including the head an arrow's appearance strokes.
 *
 * An appearance is clipped to its own box, so the head belongs to the geometry the
 * box is measured from — a box around the shaft alone would cut the head off.
 *
 * @param mark - the mark being drawn.
 * @param placed - the mark's geometry in user space.
 * @returns the points the appearance strokes.
 */
function drawnPoints(mark: AnnotationMark, placed: PlacedMark): readonly FigurePoint[] {
  const [first, second] = placed.points
  if (mark.kind !== 'arrow' || first === undefined || second === undefined) return placed.points
  const angle = Math.atan2(second[1] - first[1], second[0] - first[0])
  return [
    ...placed.points,
    [second[0] - placed.head * Math.cos(angle + ARROW_SPREAD), second[1] - placed.head * Math.sin(angle + ARROW_SPREAD)],
    [second[0] - placed.head * Math.cos(angle - ARROW_SPREAD), second[1] - placed.head * Math.sin(angle - ARROW_SPREAD)],
  ]
}

/** The appearance stream content of one stroked shape, in box-local coordinates. */
function strokeContent(mark: AnnotationMark, placed: PlacedMark, rect: UserRect): string {
  const local = (point: FigurePoint): FigurePoint => [point[0] - rect.x, point[1] - rect.y]
  const [first, second] = placed.points
  const color = colorOperators(mark.color, 'RG')
  const stroke = `${color} ${num(placed.width)} w 1 J 1 j`
  switch (mark.kind) {
    case 'pen': {
      const path = placed.points.map((point, index) => {
        const [x, y] = local(point)
        return `${num(x)} ${num(y)} ${index === 0 ? 'm' : 'l'}`
      })
      return `${stroke} ${path.join(' ')} S`
    }
    case 'rect': {
      if (first === undefined || second === undefined) return ''
      const [x0, y0] = local(first)
      const [x1, y1] = local(second)
      const left = Math.min(x0, x1) + placed.width / 2
      const bottom = Math.min(y0, y1) + placed.width / 2
      const width = Math.max(Math.abs(x1 - x0) - placed.width, 0)
      const height = Math.max(Math.abs(y1 - y0) - placed.width, 0)
      return `${stroke} ${num(left)} ${num(bottom)} ${num(width)} ${num(height)} re S`
    }
    case 'ellipse': {
      if (first === undefined || second === undefined) return ''
      const [x0, y0] = local(first)
      const [x1, y1] = local(second)
      const radiusX = Math.abs(x1 - x0) / 2
      const radiusY = Math.abs(y1 - y0) / 2
      const centerX = (x0 + x1) / 2
      const centerY = (y0 + y1) / 2
      const ox = radiusX * ELLIPSE_KAPPA
      const oy = radiusY * ELLIPSE_KAPPA
      const path = [
        `${num(centerX - radiusX)} ${num(centerY)} m`,
        `${num(centerX - radiusX)} ${num(centerY + oy)} ${num(centerX - ox)} ${num(centerY + radiusY)} ${num(centerX)} ${num(centerY + radiusY)} c`,
        `${num(centerX + ox)} ${num(centerY + radiusY)} ${num(centerX + radiusX)} ${num(centerY + oy)} ${num(centerX + radiusX)} ${num(centerY)} c`,
        `${num(centerX + radiusX)} ${num(centerY - oy)} ${num(centerX + ox)} ${num(centerY - radiusY)} ${num(centerX)} ${num(centerY - radiusY)} c`,
        `${num(centerX - ox)} ${num(centerY - radiusY)} ${num(centerX - radiusX)} ${num(centerY - oy)} ${num(centerX - radiusX)} ${num(centerY)} c`,
      ]
      return `${stroke} ${path.join(' ')} S`
    }
    case 'arrow': {
      if (first === undefined || second === undefined) return ''
      const tail = local(first)
      const tip = local(second)
      // Every barb starts its own subpath: an `l` with no current point draws
      // nothing, and the operands it leaves behind would break the next operator.
      const barbs = drawnPoints(mark, placed).slice(2).map(point => {
        const [x, y] = local(point)
        return `${num(x)} ${num(y)} m ${num(tip[0])} ${num(tip[1])} l`
      })
      return `${stroke} ${num(tail[0])} ${num(tail[1])} m ${num(tip[0])} ${num(tip[1])} l S ${barbs.join(' ')} S`
    }
    /* v8 ignore next 2 -- appearance asks a stroke mark for its content, never a note. */
    case 'text':
      return ''
  }
}

/** The colour operators setting one stroke and fill colour. */
function colorOperators(color: string, operator: string): string {
  const match = /^#?([0-9a-f]{6})$/iu.exec(color)
  const value = match?.[1] ?? '000000'
  const channel = (offset: number): string => num(Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  return `${channel(0)} ${channel(2)} ${channel(4)} ${operator}`
}

/**
 * The text matrix that draws a note the way the user drew it.
 *
 * Glyphs run along the text matrix's x-axis and stand up along its y-axis, and a
 * viewer displays the note after rotating the page by its own `/Rotate`. So the
 * two axes are the page's *display* axes carried back into user space: on an
 * unrotated page this is the identity, and on a rotated one it keeps the note
 * upright on screen instead of running down it.
 *
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param origin - the baseline origin, in box-local coordinates.
 * @returns the six text-matrix numbers.
 */
export function textMatrix(transform: readonly number[], origin: FigurePoint): number[] {
  const [a = 0, b = 0, c = 0, d = 0] = transform
  const determinant = a * d - b * c
  if (determinant === 0) throw new Error('the page transform is degenerate')
  // Columns of the inverse linear map: where the display axes come from.
  const along: FigurePoint = [d / determinant, -b / determinant]
  const across: FigurePoint = [-c / determinant, a / determinant]
  const alongLength = Math.hypot(along[0], along[1])
  const acrossLength = Math.hypot(across[0], across[1])
  const right: FigurePoint = [along[0] / alongLength, along[1] / alongLength]
  const down: FigurePoint = [across[0] / acrossLength, across[1] / acrossLength]
  return [right[0], right[1], -down[0], -down[1], origin[0], origin[1]]
}

/**
 * Build the appearance stream content of one text mark, in box-local coordinates.
 * @param layout - the laid-out note.
 * @param placed - the mark's geometry in user space.
 * @param rect - the box the appearance is drawn in.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param font - the embedded standard font the text is encoded with.
 * @returns the content stream operators.
 */
function textContent(
  layout: TextLayout,
  placed: PlacedMark,
  rect: UserRect,
  transform: readonly number[],
  font: PDFFont,
): string {
  const size = placed.textSize
  const leading = size * 1.35
  const matrix = textMatrix(transform, [layout.baseline[0] - rect.x, layout.baseline[1] - rect.y])
  const lines = layout.lines.map((line, index) =>
    `${index === 0 ? '' : `${num(leading)} T* `}${font.encodeText(line).toString()} Tj`)
  return `q BT /${FONT_NAME} ${num(size)} Tf ${num(leading)} TL 0 g ${matrix.map(num).join(' ')} Tm ${lines.join(' ')} ET Q`
}

/**
 * Build one appearance stream and register it with the document.
 * @param context - the document's object context.
 * @param mark - the mark being drawn.
 * @param placed - the mark's geometry in user space.
 * @param rect - the box the appearance covers, in user space.
 * @param layout - the laid-out note, for a text mark.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param font - the embedded standard font, for a text mark.
 * @returns the appearance stream reference, or undefined when the mark has no
 *   appearance this module can draw (a note its font cannot encode).
 */
function appearance(
  context: PDFContext,
  mark: AnnotationMark,
  placed: PlacedMark,
  rect: UserRect,
  layout: TextLayout | undefined,
  transform: readonly number[],
  font: PDFFont | undefined,
): PDFRef | undefined {
  let content: string
  if (mark.kind === 'text') {
    const note = (mark.text ?? '').trim()
    if (note === '' || !latinEncodable(note) || font === undefined || layout === undefined) return undefined
    content = textContent(layout, placed, rect, transform, font)
  } else {
    content = strokeContent(mark, placed, rect)
    if (content === '') return undefined
  }
  const dictionary = PDFDict.withContext(context)
  dictionary.set(PDFName.of('Type'), PDFName.of('XObject'))
  dictionary.set(PDFName.of('Subtype'), PDFName.of('Form'))
  dictionary.set(PDFName.of('FormType'), PDFNumber.of(1))
  dictionary.set(PDFName.of('BBox'), numbers(context, [0, 0, rect.width, rect.height]))
  const resources = PDFDict.withContext(context)
  if (mark.kind === 'text' && font !== undefined) {
    const fonts = PDFDict.withContext(context)
    fonts.set(PDFName.of(FONT_NAME), font.ref)
    resources.set(PDFName.of('Font'), fonts)
  }
  dictionary.set(PDFName.of('Resources'), resources)
  return context.register(PDFRawStream.of(dictionary, new TextEncoder().encode(content)))
}

/** A PDF array of numbers. */
function numbers(context: PDFContext, values: readonly number[]): PDFArray {
  const array = PDFArray.withContext(context)
  for (const value of values) array.push(PDFNumber.of(value))
  return array
}

/** The note as a PDF string: readable when it is ASCII, hexadecimal otherwise. */
function contentString(text: string): PDFString | PDFHexString {
  return latinEncodable(text) ? PDFString.of(text) : PDFHexString.fromText(text)
}

/**
 * Build one annotation dictionary for one mark.
 * @param context - the document's object context.
 * @param mark - the mark being written.
 * @param transform - `[a b c d e f]`, user space → page units.
 * @param font - the embedded standard font, when the document has a text mark.
 * @returns the annotation dictionary.
 */
function annotation(
  context: PDFContext,
  mark: AnnotationMark,
  transform: readonly number[],
  font: PDFFont | undefined,
): PDFDict {
  const placed = place(mark, transform)
  const strokeKind = mark.kind !== 'text'
  const padding = strokeKind ? placed.width * 2 : 0
  const anchor = mark.points[0]
  if (anchor === undefined || placed.points[0] === undefined) {
    throw new Error('an annotation mark needs at least one coordinate pair')
  }
  const layout = mark.kind === 'text' ? layoutText(mark, anchor, transform, placed) : undefined
  const rect = boundsOf(drawnPoints(mark, placed), padding)
  const box = layout?.box ?? rect
  const dictionary = PDFDict.withContext(context)
  dictionary.set(PDFName.of('Type'), PDFName.of('Annot'))
  dictionary.set(PDFName.of('Subtype'), PDFName.of(annotationSubtype(mark)))
  dictionary.set(PDFName.of('Rect'), numbers(context, [box.x, box.y, box.x + box.width, box.y + box.height]))
  dictionary.set(PDFName.of('F'), PDFNumber.of(4))
  const note = (mark.text ?? '').trim()
  if (note !== '') dictionary.set(PDFName.of('Contents'), contentString(note))
  if (strokeKind) {
    dictionary.set(PDFName.of('C'), numbers(context, colorChannels(mark.color)))
    const border = PDFDict.withContext(context)
    border.set(PDFName.of('W'), PDFNumber.of(placed.width))
    border.set(PDFName.of('S'), PDFName.of('S'))
    dictionary.set(PDFName.of('BS'), border)
  }
  if (mark.kind === 'pen') {
    const inkList = PDFArray.withContext(context)
    const path = PDFArray.withContext(context)
    for (const point of placed.points) {
      path.push(PDFNumber.of(point[0]))
      path.push(PDFNumber.of(point[1]))
    }
    inkList.push(path)
    dictionary.set(PDFName.of('InkList'), inkList)
  }
  if (mark.kind === 'arrow') {
    // A half-drawn arrow is still an arrow: it gets the line it has, and the
    // appearance of one with no head is simply not drawn.
    const [tail, tip] = placed.points
    if (tail !== undefined) {
      const head = tip ?? tail
      dictionary.set(PDFName.of('L'), numbers(context, [tail[0], tail[1], head[0], head[1]]))
      const endings = PDFArray.withContext(context)
      endings.push(PDFName.of('None'))
      endings.push(PDFName.of('OpenArrow'))
      dictionary.set(PDFName.of('LE'), endings)
    }
  }
  if (mark.kind === 'text') {
    dictionary.set(PDFName.of('DA'), PDFString.of(`/${FONT_NAME} ${num(placed.textSize)} Tf ${colorOperators(mark.color, 'rg')}`))
    dictionary.set(PDFName.of('Q'), PDFNumber.of(0))
  }
  const stream = appearance(context, mark, placed, box, layout, transform, font)
  if (stream !== undefined) {
    const streams = PDFDict.withContext(context)
    streams.set(PDFName.of('N'), stream)
    dictionary.set(PDFName.of('AP'), streams)
  }
  return dictionary
}

/** The annotation subtype one mark kind is written as. */
function annotationSubtype(mark: AnnotationMark): string {
  switch (mark.kind) {
    case 'pen': return 'Ink'
    case 'rect': return 'Square'
    case 'ellipse': return 'Circle'
    case 'arrow': return 'Line'
    case 'text': return 'FreeText'
  }
}

/** One mark's colour as three decimal channels. */
function colorChannels(color: string): number[] {
  const match = /^#?([0-9a-f]{6})$/iu.exec(color)
  const value = match?.[1] ?? '000000'
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
}

/**
 * Append the annotations of every page to a copy of the document.
 *
 * Annotations travel in each page's own `/Annots`, appended after whatever the
 * document already carried: a file someone else annotated stays annotated, and
 * saving twice writes the same annotations once because every save starts from the
 * original bytes.
 *
 * @param bytes - the original document.
 * @param pages - the marks of each annotated page.
 * @returns the annotated document.
 * @throws {Error} when a page number is outside the document, or a transform is degenerate.
 */
export async function annotatePdf(bytes: Uint8Array, pages: readonly PageAnnotateInput[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes)
  const count = document.getPageCount()
  for (const input of pages) {
    if (input.page < 1 || input.page > count) {
      throw new Error(`page ${input.page} is outside this ${count}-page document`)
    }
  }
  // `embedStandardFont` is synchronous — it registers a font dictionary and
  // answers it, with no font file to fetch.
  const font = pages.some(input => input.marks.some(mark => mark.kind === 'text'))
    ? document.embedStandardFont(StandardFonts.Helvetica)
    : undefined
  for (const input of pages) {
    const page = document.getPage(input.page - 1)
    if (input.marks.length === 0) continue
    const annots = pageAnnots(document.context, page)
    for (const mark of input.marks) {
      annots.push(document.context.register(annotation(document.context, mark, input.transform, font)))
    }
  }
  if (font !== undefined) registerFont(document, font)
  return await document.save()
}

/** One page's annotation array, created when the page carries none yet. */
function pageAnnots(context: PDFContext, page: PDFPage): PDFArray {
  const existing = page.node.Annots()
  if (existing !== undefined) return existing
  const created = PDFArray.withContext(context)
  page.node.set(PDFName.of('Annots'), created)
  return created
}

/**
 * Make the document's default resources carry the font the text annotations name.
 *
 * A reader resolves a `/FreeText`'s `/DA` font name against the interactive form's
 * default resources; without the entry, a reader that regenerates the appearance
 * has to substitute a font of its own choosing.
 *
 * @param document - the document being annotated.
 * @param font - the embedded standard font.
 */
function registerFont(document: PDFDocument, font: PDFFont): void {
  const context = document.context
  const catalog = document.catalog
  // Every entry is read through `lookup`: a form, its default resources and the
  // font dictionary inside them are usually indirect objects, and an entry that
  // is a reference rather than a dictionary would otherwise be replaced wholesale.
  const existing = context.lookup(catalog.get(PDFName.of('AcroForm')))
  const form = existing instanceof PDFDict ? existing : PDFDict.withContext(context)
  if (!(existing instanceof PDFDict)) {
    catalog.set(PDFName.of('AcroForm'), context.register(form))
  }
  if (!form.has(PDFName.of('Fields'))) form.set(PDFName.of('Fields'), PDFArray.withContext(context))
  const defaultsEntry = context.lookup(form.get(PDFName.of('DR')))
  const defaults = defaultsEntry instanceof PDFDict ? defaultsEntry : PDFDict.withContext(context)
  if (!(defaultsEntry instanceof PDFDict)) form.set(PDFName.of('DR'), defaults)
  const fontsEntry = context.lookup(defaults.get(PDFName.of('Font')))
  const fonts = fontsEntry instanceof PDFDict ? fontsEntry : PDFDict.withContext(context)
  if (!(fontsEntry instanceof PDFDict)) defaults.set(PDFName.of('Font'), fonts)
  fonts.set(PDFName.of(FONT_NAME), font.ref)
}
