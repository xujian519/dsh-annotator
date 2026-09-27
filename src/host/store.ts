/**
 * Reading and writing one figure's annotation sidecar.
 *
 * The marks file is JSON owned by this plugin; the flattened image is the same
 * marks burned onto the figure. Both are written through a temporary file and a
 * rename, so a reader never observes a half-written document.
 * @module dsh-annotator/host/store
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
import { annotationCandidates, annotationTargetsFigure, sidecarPaths, type SidecarPaths } from './sidecar'

/** Maximum accepted sidecar size; a document larger than this is not one we wrote. */
const MAX_ANNOTATION_BYTES = 4 * 1024 * 1024

/** Maximum accepted flattened review image. */
export const MAX_REVIEW_IMAGE_BYTES = 24 * 1024 * 1024

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
 * Validate one mark from the wire.
 * @param value - candidate mark.
 * @param index - position used in the failure message.
 * @returns the validated mark.
 * @throws {Error} when a required field is missing or mistyped.
 */
function readMark(value: unknown, index: number): AnnotationMark {
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
  const anchor = readAnchor(raw['anchor'])
  return {
    id: raw['id'],
    kind: kind as MarkKind,
    color: raw['color'],
    points,
    ...(typeof raw['text'] === 'string' ? { text: raw['text'] } : {}),
    ...(anchor === undefined ? {} : { anchor }),
  }
}

/**
 * Validate one optional page number from the wire.
 * @param raw - the figure object as it arrived.
 * @param field - field name, used in the failure message.
 * @returns the page number, or undefined when the field is absent.
 * @throws {Error} when the field is present but is not a positive integer.
 */
function readPageNumber(raw: Record<string, unknown>, field: 'page' | 'pageCount'): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`annotation figure ${field} must be a positive integer`)
  }
  return value
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
  for (const field of ['width', 'height'] as const) {
    if (typeof figureRaw[field] !== 'number' || !Number.isFinite(figureRaw[field])) {
      throw new Error(`annotation figure needs a numeric ${field}`)
    }
  }
  const page = readPageNumber(figureRaw, 'page')
  const pageCount = readPageNumber(figureRaw, 'pageCount')
  if (page !== undefined && pageCount !== undefined && page > pageCount) {
    throw new Error(`annotation figure page ${page} is outside its ${pageCount} pages`)
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
      width: figureRaw['width'] as number,
      height: figureRaw['height'] as number,
      sha256: figureRaw['sha256'] as string,
      ...(page === undefined ? {} : { page }),
      ...(pageCount === undefined ? {} : { pageCount }),
    },
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : updatedAt,
    updatedAt,
    marks: marks.map(readMark),
    ...(typeof raw['summary'] === 'string' && raw['summary'] !== '' ? { summary: raw['summary'] } : {}),
  }
}

/**
 * Read one figure's saved annotation.
 *
 * The current sidecar name is tried first, then the legacy base-name one, and a
 * document that names a different figure is skipped — two figures in one directory
 * that share a base name would otherwise read each other's marks.
 *
 * @param figurePath - absolute path of the figure.
 * @param page - 1-based page for a paged figure, or undefined for a whole figure.
 * @returns the document, or null when none was stored or it is unreadable.
 */
export async function readAnnotation(figurePath: string, page?: number): Promise<AnnotationDocument | null> {
  for (const candidate of annotationCandidates(figurePath, page)) {
    const document = await readSidecar(candidate)
    if (document !== null && annotationTargetsFigure(document, figurePath)) return document
  }
  return null
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

/** Outcome of one sidecar save. */
export interface SaveResult {
  /** Sidecar paths the save wrote. */
  readonly paths: SidecarPaths
  /** Whether a flattened review image was written too. */
  readonly wroteImage: boolean
}

/**
 * Write one figure's annotation, and optionally its flattened review image.
 * @param figurePath - absolute path of the annotated figure.
 * @param document - validated document to persist.
 * @param reviewImage - flattened PNG bytes, when the browser exported one.
 * @returns the written paths.
 */
export async function writeAnnotation(
  figurePath: string,
  document: AnnotationDocument,
  reviewImage?: Uint8Array,
): Promise<SaveResult> {
  const paths = sidecarPaths(figurePath, document.figure.page)
  await mkdir(dirname(paths.annotation), { recursive: true })
  const temporary = `${paths.annotation}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, paths.annotation)
  if (reviewImage === undefined) return { paths, wroteImage: false }
  const imageTemporary = `${paths.annotatedImage}.tmp-${process.pid}-${Date.now()}`
  await writeFile(imageTemporary, reviewImage)
  await rename(imageTemporary, paths.annotatedImage)
  return { paths, wroteImage: true }
}
