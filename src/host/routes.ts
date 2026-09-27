/**
 * HTTP routes of the annotator.
 *
 * The routes live outside the `/api` channel, so they carry their own guard: a
 * required request header (which a cross-origin form or image request cannot
 * set without a preflight this plugin never answers) plus an origin check on
 * browsers that send `Sec-Fetch-Site`. Writes are limited to the two sidecar
 * files derived from a figure that already exists.
 * @module dsh-annotator/host/routes
 */
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { parseFileAddress } from '../shared/address'
import {
  figureMediaType,
  isFigurePath,
} from './sidecar'
import {
  MAX_REVIEW_BYTES,
  fileDigest,
  readAnnotation,
  readAnnotationDocument,
  writeAnnotation,
  type ReviewArtifact,
} from './store'

/** Request header every route requires. */
export const GUARD_HEADER = 'x-dsh-annotator'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-annotator'

/** Largest accepted request body. */
const MAX_BODY_BYTES = MAX_REVIEW_BYTES * 2

/** First bytes of every PDF file, used to tell one payload from another. */
const PDF_HEADER = '%PDF-'

/** What the routes need from the plugin. */
export interface RouteDeps {
  /**
   * Resolve one Session's workspace directory.
   * @param sessionId - the Session named by the address.
   * @returns the absolute directory, or undefined when the Session is unknown.
   */
  readonly sessionCwd: (sessionId: string) => Promise<string | undefined>
}

/** One resolved figure target. */
interface FigureTarget {
  /** Requested address, echoed into the sidecar. */
  readonly address: string
  /** Absolute path of the figure. */
  readonly path: string
  /** Media type implied by the suffix. */
  readonly mediaType: string
}

/**
 * Resolve one request address to an existing figure file.
 * @param address - `dsh-resource://file/…` address from the preview tab.
 * @param deps - Session lookup used for a relative path.
 * @returns the target, or an error message describing why it cannot be annotated.
 */
async function resolveTarget(
  address: string,
  deps: RouteDeps,
): Promise<{ ok: true; target: FigureTarget } | { ok: false; message: string }> {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return { ok: false, message: `not a file address: ${address}` }
  let absolute: string
  if (isAbsolute(parsed.path)) {
    absolute = parsed.path
  } else {
    const sessionId = parsed.sessionId
    const cwd = sessionId === undefined ? undefined : await deps.sessionCwd(sessionId)
    if (cwd === undefined) {
      return { ok: false, message: `cannot resolve this Session's directory for a relative path: ${address}` }
    }
    absolute = resolve(cwd, parsed.path)
  }
  if (!isFigurePath(absolute)) return { ok: false, message: `not an annotatable figure: ${absolute}` }
  const mediaType = figureMediaType(absolute)
  /* v8 ignore next -- isFigurePath already restricted the suffixes figureMediaType covers. */
  if (mediaType === undefined) return { ok: false, message: `no media type for ${absolute}` }
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return { ok: false, message: `not a regular file: ${absolute}` }
  } catch {
    return { ok: false, message: `no such figure: ${absolute}` }
  }
  return { ok: true, target: { address, path: absolute, mediaType } }
}

/**
 * Read the one flattened review artifact a save may carry.
 *
 * The kind is taken from the payload, and the store refuses a pair that
 * contradicts the figure's own suffix — so a caller cannot name PNG bytes as the
 * review of a PDF.
 *
 * @param body - parsed request body.
 * @returns the artifact, or undefined when the save carried none.
 * @throws {Error} when both payloads are present, or the PDF bytes are not a PDF.
 */
function readReview(body: Record<string, unknown>): ReviewArtifact | undefined {
  const image = typeof body['reviewImage'] === 'string' ? body['reviewImage'] : ''
  const pdf = typeof body['annotatedPdf'] === 'string' ? body['annotatedPdf'] : ''
  if (image !== '' && pdf !== '') throw new Error('a save carries one review artifact, not both')
  if (pdf !== '') {
    const bytes = new Uint8Array(Buffer.from(pdf, 'base64'))
    if (!Buffer.from(bytes.subarray(0, PDF_HEADER.length)).toString('latin1').startsWith(PDF_HEADER)) {
      throw new Error('the annotated document is not a PDF')
    }
    return { kind: 'pdf', bytes }
  }
  if (image !== '') return { kind: 'image', bytes: new Uint8Array(Buffer.from(image, 'base64')) }
  return undefined
}

/**
 * Whether a request carries the plugin guard and a same-origin posture.
 * @param req - incoming request.
 * @returns true when the request may proceed.
 */
function guarded(req: IncomingMessage): boolean {
  if (req.headers[GUARD_HEADER] === undefined) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site !== 'string') return true
  return site === 'same-origin' || site === 'none'
}

/**
 * Write one JSON response.
 * @param res - response to own.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read a request body with a byte cap.
 * @param req - incoming request.
 * @returns the body text.
 * @throws {Error} when the body exceeds the cap.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the route handlers this plugin registers.
 * @param deps - Session lookup.
 * @returns one handler per route path.
 */
export function createHandlers(deps: RouteDeps): {
  readonly annotation: (req: IncomingMessage, res: ServerResponse) => Promise<void>
} {
  const annotation = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!guarded(req)) {
      sendJson(res, 403, { ok: false, error: 'missing plugin guard header' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method === 'GET') {
        const address = url.searchParams.get('address') ?? ''
        const resolved = await resolveTarget(address, deps)
        if (!resolved.ok) {
          sendJson(res, 404, { ok: false, error: resolved.message })
          return
        }
        const [sha256, saved] = await Promise.all([
          fileDigest(resolved.target.path),
          readAnnotation(resolved.target.path),
        ])
        sendJson(res, 200, {
          ok: true,
          figure: { ...resolved.target, sha256 },
          annotation: saved,
        })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>
        const address = typeof body['address'] === 'string' ? body['address'] : ''
        const resolved = await resolveTarget(address, deps)
        if (!resolved.ok) {
          sendJson(res, 404, { ok: false, error: resolved.message })
          return
        }
        const document = readAnnotationDocument(body['annotation'])
        const review = readReview(body)
        if (review !== undefined && review.bytes.byteLength > MAX_REVIEW_BYTES) {
          sendJson(res, 413, { ok: false, error: 'the review artifact is too large' })
          return
        }
        const saved = await writeAnnotation(resolved.target.path, document, review)
        sendJson(res, 200, {
          ok: true,
          annotationPath: saved.paths.annotation,
          reviewPath: saved.wroteReview ? saved.paths.review : null,
        })
        return
      }
      sendJson(res, 405, { ok: false, error: `method ${req.method ?? ''} is not allowed` })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { annotation }
}
