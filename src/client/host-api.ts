/**
 * The plugin's own HTTP routes, as the browser half calls them.
 *
 * The routes live outside the shell's authenticated `/api` channel, so every
 * request carries the plugin guard header; cookies still travel with the
 * same-origin request, which is what keeps a foreign page from driving them.
 * @module dsh-annotator/client/host-api
 */

import type { AnnotationDocument } from '../shared/annotation'
import { GUARD_HEADER, ROUTE_PREFIX } from '../shared/http'

/** Figure facts and any saved annotation the Host reported. */
export interface LoadedAnnotation {
  /** Absolute path of the figure on the Host. */
  readonly path: string
  /** Media type implied by the figure's suffix. */
  readonly mediaType: string
  /** Content hash of the figure at read time. */
  readonly sha256: string
  /** The saved document, or null when the figure was never annotated. */
  readonly annotation: AnnotationDocument | null
}

/** Result of one annotation save. */
export interface SavedAnnotation {
  /** Absolute path of the marks file. */
  readonly annotationPath: string
  /** Absolute path of the flattened review artifact, when one was written. */
  readonly reviewPath: string | null
}

/** Error carrying the Host's own message. */
export class AnnotatorHostError extends Error {
  /**
   * @param message - the message the Host returned.
   */
  constructor(message: string) {
    super(message)
    this.name = 'AnnotatorHostError'
  }
}

/**
 * Encode one artifact as base64 for the JSON body.
 * @param source - bytes, or the blob an export produced.
 * @returns base64 text.
 */
async function toBase64(source: Blob | Uint8Array): Promise<string> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Read the figure's saved annotation.
 * @param address - the preview tab's file address.
 * @param signal - cancels the request when the tab closes.
 * @returns the Host's answer.
 * @throws {AnnotatorHostError} when the Host refuses the address.
 */
export async function loadAnnotation(
  address: string,
  signal: AbortSignal,
): Promise<LoadedAnnotation> {
  // URLSearchParams round-trips the address exactly, including the `+` and `%`
  // characters a `dsh-resource://` address may carry.
  const query = new URLSearchParams({ address })
  const url = `${ROUTE_PREFIX}/annotation?${query.toString()}`
  const response = await fetch(url, { headers: { [GUARD_HEADER]: '1' }, signal })
  const body = await response.json() as {
    ok?: boolean
    error?: string
    figure?: { path: string; mediaType: string; sha256: string }
    annotation?: AnnotationDocument | null
  }
  if (body.ok !== true || body.figure === undefined) {
    throw new AnnotatorHostError(body.error ?? `annotation read failed with status ${response.status}`)
  }
  return {
    path: body.figure.path,
    mediaType: body.figure.mediaType,
    sha256: body.figure.sha256,
    annotation: body.annotation ?? null,
  }
}

/**
 * Persist one annotation document and its flattened review artifact.
 *
 * The payload each artifact travels in follows the annotated figure's own kind:
 * a paged document is reviewed as a PDF and a single surface as a PNG, which is
 * the pairing the Host writes and the pairing it refuses to mix up.
 *
 * @param address - the preview tab's file address.
 * @param document - the document to save.
 * @param review - flattened PNG, or the annotated PDF, when the browser exported one.
 * @returns the paths the Host wrote.
 * @throws {AnnotatorHostError} when the Host refuses the write.
 */
export async function saveAnnotation(
  address: string,
  document: AnnotationDocument,
  review?: Blob | Uint8Array,
): Promise<SavedAnnotation> {
  const paged = document.figure.mediaType === 'application/pdf'
  const response = await fetch(`${ROUTE_PREFIX}/annotation`, {
    method: 'POST',
    headers: { [GUARD_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      address,
      annotation: document,
      ...(review === undefined
        ? {}
        : { [paged ? 'annotatedPdf' : 'reviewImage']: await toBase64(review) }),
    }),
  })
  const body = await response.json() as {
    ok?: boolean
    error?: string
    annotationPath?: string
    reviewPath?: string | null
  }
  if (body.ok !== true || body.annotationPath === undefined) {
    throw new AnnotatorHostError(body.error ?? `annotation save failed with status ${response.status}`)
  }
  return { annotationPath: body.annotationPath, reviewPath: body.reviewPath ?? null }
}
