/**
 * The seats the entry bundle hands to the paged-document body.
 *
 * A paged document is one annotation for the whole document, so the body that
 * owns its pages also owns the one save and the one delivery. That work needs the
 * entry half's HTTP shapes and session access, and a package-local chunk may not
 * import its own entry bundle — the import would either duplicate the client half
 * or resolve through a module table that carries only the shell's modules. So the
 * entry builds this small object and the chunk calls it; the types below are the
 * whole contract, and the chunk imports them with `import type` so nothing here
 * reaches the chunk's runtime.
 * @module dsh-annotator/client/document-seat
 */
import { ANNOTATION_VERSION, type AnnotationDocument, type AnnotationMark, type SummaryLocale } from '../shared/annotation'
import { composeReviewSvg, rasterizePng, reviewScale } from './export'
import { loadAnnotation, saveAnnotation } from './host-api'
import { deliverAnnotation, type DeliveredPageImage, type FileUploadLike, type SessionsLike } from './session'

/** Facts one whole-document annotation is persisted against. */
export interface PagedFigureFacts {
  /** The `dsh-resource://file/…` address the annotator opened. */
  readonly address: string
  /** Absolute path on the Host. */
  readonly path: string
  /** Media type of the document. */
  readonly mediaType: string
  /** Content hash of the document at annotation time. */
  readonly sha256: string
  /** Pages in the document. */
  readonly pageCount: number
}

/** A whole document's edits, as the body that owns its pages reports them. */
export interface PagedAnnotationInput {
  /** The document the marks were drawn on. */
  readonly figure: PagedFigureFacts
  /** Every mark of every page, in page then draw order. */
  readonly marks: readonly AnnotationMark[]
  /** The user's overall note. */
  readonly summary: string
  /** Creation time of the document already on disk, when it was loaded. */
  readonly createdAt: string | null
}

/** One annotated page rendered for the session, in the page's own units. */
export interface PageImage {
  /** 1-based page the raster shows. */
  readonly page: number
  /** PNG data URL of the page. */
  readonly dataUrl: string
  /** Page width in page units. */
  readonly width: number
  /** Page height in page units. */
  readonly height: number
}

/** Where one save wrote its two files. */
export interface SavedPaths {
  /** Absolute path of the marks file. */
  readonly annotationPath: string
  /** Absolute path of the flattened review artifact, when one was written. */
  readonly reviewPath: string | null
}

/** What the entry half does for one paged-document body. */
export interface DocumentSeat {
  /**
   * Read the document's saved annotation.
   * @param address - the preview tab's file address.
   * @param signal - cancels the request when the tab closes.
   * @returns the Host's answer.
   */
  load(address: string, signal: AbortSignal): Promise<{
    /** Absolute path of the document on the Host. */
    readonly path: string
    /** Media type implied by the document's suffix. */
    readonly mediaType: string
    /** Content hash of the document at read time. */
    readonly sha256: string
    /** The saved document, or null when it was never annotated. */
    readonly annotation: AnnotationDocument | null
  }>
  /**
   * Write the whole document's annotation and the annotated document beside it.
   * @param address - the preview tab's file address.
   * @param input - the document's marks and note.
   * @param annotatedPdf - the original document with the marks written into it.
   * @returns the paths the Host wrote.
   */
  save(address: string, input: PagedAnnotationInput, annotatedPdf: Uint8Array): Promise<SavedPaths>
  /**
   * Deliver the annotation to the session that owns the document.
   * @param input - the document's marks and note.
   * @param saved - paths the save wrote.
   * @param pageImages - the annotated pages, rendered.
   * @param annotatedPdf - the annotated document, attached to the message.
   * @returns what the delivery could not do, empty when it did everything.
   */
  send(
    input: PagedAnnotationInput,
    saved: SavedPaths,
    pageImages: readonly PageImage[],
    annotatedPdf: Uint8Array,
  ): Promise<readonly string[]>
}

/**
 * Restate one whole document's edits as the sidecar document.
 * @param input - the figure, its marks and the overall note.
 * @returns the document, stamped with this save's time.
 */
export function buildPagedDocument(input: PagedAnnotationInput): AnnotationDocument {
  const now = new Date().toISOString()
  const summary = input.summary.trim()
  return {
    version: ANNOTATION_VERSION,
    figure: {
      address: input.figure.address,
      path: input.figure.path,
      mediaType: input.figure.mediaType,
      sha256: input.figure.sha256,
      pageCount: input.figure.pageCount,
    },
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    marks: input.marks,
    ...(summary === '' ? {} : { summary }),
  }
}

/** What the seat closes over, taken from the client composition. */
export interface DocumentSeatOptions {
  /** The client sessions service. */
  readonly sessions: SessionsLike | undefined
  /** The client upload service, used to attach the annotated document. */
  readonly fileUpload: FileUploadLike | undefined
  /** Session the figures belong to. */
  readonly sessionId: string
  /** Language of the messages this seat composes. */
  readonly locale: SummaryLocale
}

/**
 * Build the seat one paged-document body is injected with.
 * @param options - the services and session the seat acts through.
 * @returns the seat.
 */
export function createDocumentSeat(options: DocumentSeatOptions): DocumentSeat {
  return {
    load: async (address, signal) => await loadAnnotation(address, signal),
    save: async (address, input, annotatedPdf) =>
      await saveAnnotation(address, buildPagedDocument(input), annotatedPdf),
    send: async (input, saved, pageImages, annotatedPdf) => {
      const sessions = options.sessions
      if (sessions === undefined) throw new Error('the sessions service is unavailable')
      const document = buildPagedDocument(input)
      return await deliverAnnotation({
        sessions,
        fileUpload: options.fileUpload,
        sessionId: options.sessionId,
        document,
        paths: saved,
        pageImages: await renderPageImages(document, pageImages),
        annotatedPdf,
        locale: options.locale,
      })
    },
  }
}

/**
 * Draw one annotated page per reviewed page, through the same SVG the single-surface
 * export uses, so the agent's picture and the user's screen cannot drift.
 * @param document - the document whose marks are drawn.
 * @param pages - the pages the body rendered, in page order.
 * @returns one image per page.
 */
async function renderPageImages(
  document: AnnotationDocument,
  pages: readonly PageImage[],
): Promise<DeliveredPageImage[]> {
  const images: DeliveredPageImage[] = []
  for (const page of pages) {
    const layer = { kind: 'raster' as const, dataUrl: page.dataUrl, width: page.width, height: page.height }
    const marks = document.marks.filter(mark => mark.page === page.page)
    const svg = composeReviewSvg(layer, marks)
    images.push({
      page: page.page,
      image: await rasterizePng(svg, page.width, page.height, reviewScale(page.width, page.height)),
    })
  }
  return images
}
