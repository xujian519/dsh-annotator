/**
 * Reading and writing one figure's annotation sidecar.
 *
 * The marks file is JSON owned by this plugin; the review artifact is the same
 * marks applied to the figure (a PNG for a single-surface figure, a copy of the
 * document carrying native PDF annotations for one that has pages). Both are
 * written through a temporary file and a rename, so a reader never observes a
 * half-written document.
 * @module dsh-annotator/host/store
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ANNOTATION_VERSION,
  ANNOTATION_VERSION_V2,
  type AnnotationDocument,
  type AnnotationMark,
  type FigureBox,
  type FigurePoint,
  type MarkAnchor,
  type MarkKind,
} from '../shared/annotation'
import {
  annotationCandidates,
  annotationTargetsFigure,
  figureMediaType,
  legacyPagePattern,
  reviewFileExtension,
  sidecarPaths,
  type SidecarPaths,
} from './sidecar'

/** Maximum accepted sidecar size; a document larger than this is not one we wrote. */
const MAX_ANNOTATION_BYTES = 4 * 1024 * 1024

/** Maximum accepted flattened review artifact. */
export const MAX_REVIEW_BYTES = 24 * 1024 * 1024

/** Kinds a mark may declare. */
const MARK_KINDS: readonly MarkKind[] = ['arrow', 'rect', 'ellipse', 'pen', 'text']

/** Content hash of one file. */
export async function fileDigest(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Whether a value is a finite figure coordinate pair.
 * @param value - candidate value from the wire.
 * @returns true when the value is a two-number tuple.
 */
function isPoint(value: unknown): value is FigurePoint {
  return Array.isArray(value)
    && value.length === 2
    && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

/**
 * Whether a value is a finite figure rectangle.
 * @param value - candidate value from the wire.
 * @returns true when the value is a four-number tuple.
 */
function isBox(value: unknown): value is FigureBox {
  return Array.isArray(value)
    && value.length === 4
    && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

/**
 * Validate one anchor from the wire.
 * @param value - candidate anchor.
 * @returns the anchor, or undefined when absent; throws when malformed.
 */
function readAnchor(value: unknown): MarkAnchor | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new Error('annotation mark anchor must be an object')
  const raw = value as Record<string, unknown>
  if (typeof raw['tag'] !== 'string') throw new Error('annotation mark anchor needs a tag')
  if (!isBox(raw['bbox'])) throw new Error('annotation mark anchor needs a four-number bbox')
  const anchor: MarkAnchor = {
    tag: raw['tag'],
    bbox: raw['bbox'],
    ...(typeof raw['id'] === 'string' ? { id: raw['id'] } : {}),
    ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
    ...(typeof raw['text'] === 'string' ? { text: raw['text'] } : {}),
  }
  return anchor
}

/**
 * Read one optional positive integer field from the wire.
 * @param raw - the object as it arrived.
 * @param field - field name, used in the failure message.
 * @returns the number, or undefined when the field is absent.
 * @throws {Error} when the field is present but is not a positive integer.
 */
function readPositiveInteger(raw: Record<string, unknown>, field: string): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`annotation ${field} must be a positive integer`)
  }
  return value
}

/**
 * Validate one mark from the wire.
 *
 * A mark names the page it was drawn on exactly when its figure is a paged
 * document: on a single-surface figure a page number would be a coordinate space
 * that does not exist, so it is refused rather than ignored.
 *
 * @param value - candidate mark.
 * @param index - position used in the failure message.
 * @param figure - the validated figure the mark belongs to.
 * @returns the validated mark.
 * @throws {Error} when a required field is missing or mistyped.
 */
function readMark(value: unknown, index: number, figure: { readonly width?: number; readonly pageCount?: number }): AnnotationMark {
  if (typeof value !== 'object' || value === null) throw new Error(`annotation mark ${index} must be an object`)
  const raw = value as Record<string, unknown>
  const kind = raw['kind']
  if (typeof kind !== 'string' || !(MARK_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`annotation mark ${index} has unknown kind ${JSON.stringify(kind)}`)
  }
  if (typeof raw['id'] !== 'string' || raw['id'] === '') throw new Error(`annotation mark ${index} needs an id`)
  if (typeof raw['color'] !== 'string') throw new Error(`annotation mark ${index} needs a color`)
  const points = raw['points']
  if (!Array.isArray(points) || points.length === 0 || !points.every(isPoint)) {
    throw new Error(`annotation mark ${index} needs at least one coordinate pair`)
  }
  const page = readPositiveInteger(raw, 'page')
  if (page !== undefined && figure.width !== undefined) {
    throw new Error(`annotation mark ${index} names a page, but its figure is one surface`)
  }
  if (page !== undefined && figure.pageCount !== undefined && page > figure.pageCount) {
    throw new Error(`annotation mark ${index} is on page ${page} of a ${figure.pageCount}-page document`)
  }
  const anchor = readAnchor(raw['anchor'])
  return {
    id: raw['id'],
    kind: kind as MarkKind,
    color: raw['color'],
    points,
    ...(typeof raw['text'] === 'string' ? { text: raw['text'] } : {}),
    ...(page === undefined ? {} : { page }),
    ...(anchor === undefined ? {} : { anchor }),
  }
}

/**
 * Validate a whole annotation document from the wire.
 * @param value - parsed request body.
 * @returns the validated document.
 * @throws {Error} when the body is not a document this plugin wrote.
 */
export function readAnnotationDocument(value: unknown): AnnotationDocument {
  if (typeof value !== 'object' || value === null) throw new Error('annotation document must be an object')
  const raw = value as Record<string, unknown>
  if (raw['version'] !== ANNOTATION_VERSION) {
    throw new Error(`annotation document version ${JSON.stringify(raw['version'])} is not ${ANNOTATION_VERSION}`)
  }
  const figure = raw['figure']
  if (typeof figure !== 'object' || figure === null) throw new Error('annotation document needs a figure')
  const figureRaw = figure as Record<string, unknown>
  for (const field of ['address', 'path', 'mediaType', 'sha256'] as const) {
    if (typeof figureRaw[field] !== 'string' || figureRaw[field] === '') {
      throw new Error(`annotation figure needs ${field}`)
    }
  }
  const width = readSize(figureRaw, 'width')
  const height = readSize(figureRaw, 'height')
  if ((width === undefined) !== (height === undefined)) {
    throw new Error('annotation figure needs both its width and its height, or neither')
  }
  const pageCount = readPositiveInteger(figureRaw, 'pageCount')
  if (pageCount !== undefined && width !== undefined) {
    // A document with pages has no single size, and a single surface has no pages:
    // a document carrying both would leave a reader guessing which one the mark
    // coordinates are measured in.
    throw new Error('annotation figure is a paged document, so it cannot carry width and height')
  }
  const marks = raw['marks']
  if (!Array.isArray(marks)) throw new Error('annotation document needs a marks array')
  const updatedAt = typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : new Date().toISOString()
  return {
    version: ANNOTATION_VERSION,
    figure: {
      address: figureRaw['address'] as string,
      path: figureRaw['path'] as string,
      mediaType: figureRaw['mediaType'] as string,
      sha256: figureRaw['sha256'] as string,
      ...(width !== undefined && height !== undefined ? { width, height } : {}),
      ...(pageCount === undefined ? {} : { pageCount }),
    },
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : updatedAt,
    updatedAt,
    marks: marks.map((mark, index) => readMark(mark, index, { ...(width === undefined ? {} : { width }), ...(pageCount === undefined ? {} : { pageCount }) })),
    ...(typeof raw['summary'] === 'string' && raw['summary'] !== '' ? { summary: raw['summary'] } : {}),
  }
}

/**
 * Read one optional positive size from the wire.
 * @param raw - the figure object as it arrived.
 * @param field - field name, used in the failure message.
 * @returns the size, or undefined when the field is absent.
 * @throws {Error} when the field is present but is not a positive number.
 */
function readSize(raw: Record<string, unknown>, field: 'width' | 'height'): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`annotation figure ${field} must be a positive number`)
  }
  return value
}

/**
 * Read one figure's saved annotation.
 *
 * The current sidecar name is tried first, then the legacy base-name one, and a
 * document that names a different figure is skipped — two figures in one directory
 * that share a base name would otherwise read each other's marks.
 *
 * @param figurePath - absolute path of the figure.
 * @returns the document, or null when none was stored or it is unreadable.
 */
export async function readAnnotation(figurePath: string): Promise<AnnotationDocument | null> {
  for (const candidate of annotationCandidates(figurePath)) {
    const document = await readSidecar(candidate)
    if (document !== null && annotationTargetsFigure(document, figurePath)) return document
  }
  if (figureMediaType(figurePath) !== 'application/pdf') return null
  return await readLegacyPages(figurePath)
}

/**
 * Restate the per-page sidecars an earlier version wrote as one document.
 *
 * That version annotated one page at a time and stored each page as its own file,
 * so a figure annotated then has no whole-figure sidecar. Reading them merged
 * keeps those marks visible; the files are left untouched, and the next save
 * writes the unified name.
 *
 * The page count is the highest page found, since the per-page files do not
 * record it — the browser half replaces it with the document's real count the next
 * time it saves.
 *
 * @param figurePath - absolute path of the figure.
 * @returns the merged document, or null when no readable page file exists.
 */
async function readLegacyPages(figurePath: string): Promise<AnnotationDocument | null> {
  const directory = dirname(figurePath)
  const pattern = legacyPagePattern(figurePath)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return null
  }
  const pages = entries
    .map(name => ({ name, page: Number(pattern.exec(name)?.[1]) }))
    .filter(entry => Number.isInteger(entry.page) && entry.page > 0)
    .sort((left, right) => left.page - right.page)
  const read: { readonly page: number; readonly document: AnnotationDocument }[] = []
  for (const entry of pages) {
    const document = await readSidecar(join(directory, entry.name))
    if (document !== null && annotationTargetsFigure(document, figurePath)) read.push({ page: entry.page, document })
  }
  const first = read[0]
  if (first === undefined) return null
  let summary: string | undefined
  for (const entry of read) {
    if (entry.document.summary !== undefined) summary = entry.document.summary
  }
  return {
    version: ANNOTATION_VERSION,
    figure: {
      address: first.document.figure.address,
      path: first.document.figure.path,
      mediaType: first.document.figure.mediaType,
      sha256: first.document.figure.sha256,
      pageCount: read.reduce((highest, entry) => Math.max(highest, entry.page), first.page),
    },
    createdAt: read.reduce((earliest, entry) => (entry.document.createdAt < earliest ? entry.document.createdAt : earliest), first.document.createdAt),
    updatedAt: read.reduce((latest, entry) => (entry.document.updatedAt > latest ? entry.document.updatedAt : latest), first.document.updatedAt),
    marks: read.flatMap(entry => entry.document.marks.map(mark => ({ ...mark, page: entry.page }))),
    ...(summary === undefined ? {} : { summary }),
  }
}

/**
 * Parse one marks file into this plugin's document shape.
 * @param sidecarPath - absolute path of the marks file.
 * @returns the document, or null when the file is missing, oversized, or unreadable.
 */
async function readSidecar(sidecarPath: string): Promise<AnnotationDocument | null> {
  let text: string
  try {
    const info = await stat(sidecarPath)
    if (info.size > MAX_ANNOTATION_BYTES) return null
    text = await readFile(sidecarPath, 'utf8')
  } catch {
    // A missing sidecar is the ordinary "never annotated" state.
    return null
  }
  try {
    return readStoredDocument(JSON.parse(text) as unknown)
  } catch {
    // A sidecar this plugin cannot parse is reported as "no annotation" so the
    // user can start over instead of the preview failing to open.
    return null
  }
}

/**
 * Read a stored sidecar document in either schema version this workbench sees.
 * @param value - parsed marks file content.
 * @returns the document in this plugin's shape, or null when it is neither version.
 */
function readStoredDocument(value: unknown): AnnotationDocument | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['version'] === ANNOTATION_VERSION) return readAnnotationDocument(raw)
  if (raw['version'] === ANNOTATION_VERSION_V2) return readAnnotationDocument(bridgeV2Document(raw))
  return null
}

/**
 * Restate a v2 document as the v1 shape this plugin validates and writes.
 *
 * Both versions carry the same marks and the same figure facts. v2 names the figure
 * `target`, adds fields this plugin does not model (`kind` on the target, per-mark
 * `targetFingerprint`, `nodeId`/`ref` on an anchor — the v1 reader then drops them),
 * and omits `address`, the one v1 field it has no counterpart for: the figure's own
 * path stands in, and the browser half replaces it with the live preview address the
 * next time it saves.
 *
 * @param raw - parsed v2 document.
 * @returns the same document as a v1 shape.
 * @throws {Error} when the document carries no target object.
 */
function bridgeV2Document(raw: Record<string, unknown>): unknown {
  const target = raw['target']
  if (typeof target !== 'object' || target === null) throw new Error('annotation document needs a target')
  const figure = target as Record<string, unknown>
  return {
    version: ANNOTATION_VERSION,
    figure: {
      address: figure['path'],
      path: figure['path'],
      mediaType: figure['mediaType'],
      width: figure['width'],
      height: figure['height'],
      sha256: figure['sha256'],
    },
    createdAt: raw['createdAt'],
    updatedAt: raw['updatedAt'],
    marks: raw['marks'],
    summary: raw['summary'],
  }
}

/** The flattened artifact written beside the marks, and what it is. */
export interface ReviewArtifact {
  /** File kind, which must match what the figure's own suffix calls for. */
  readonly kind: 'image' | 'pdf'
  /** Artifact bytes. */
  readonly bytes: Uint8Array
}

/** Outcome of one sidecar save. */
export interface SaveResult {
  /** Sidecar paths the save wrote. */
  readonly paths: SidecarPaths
  /** Whether a flattened review artifact was written too. */
  readonly wroteReview: boolean
}

/**
 * Write one figure's annotation, and optionally its flattened review artifact.
 * @param figurePath - absolute path of the annotated figure.
 * @param document - validated document to persist.
 * @param review - the flattened artifact, when the browser exported one.
 * @returns the written paths.
 * @throws {Error} when the artifact's kind contradicts the figure's own kind.
 */
export async function writeAnnotation(
  figurePath: string,
  document: AnnotationDocument,
  review?: ReviewArtifact,
): Promise<SaveResult> {
  const paths = sidecarPaths(figurePath)
  if (review !== undefined && review.kind !== (reviewFileExtension(figurePath) === '.pdf' ? 'pdf' : 'image')) {
    throw new Error(`a ${reviewFileExtension(figurePath)} review artifact cannot be written from ${review.kind} bytes`)
  }
  await mkdir(dirname(paths.annotation), { recursive: true })
  const temporary = `${paths.annotation}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, paths.annotation)
  if (review === undefined) return { paths, wroteReview: false }
  const reviewTemporary = `${paths.review}.tmp-${process.pid}-${Date.now()}`
  await writeFile(reviewTemporary, review.bytes)
  await rename(reviewTemporary, paths.review)
  return { paths, wroteReview: true }
}
