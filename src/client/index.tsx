/**
 * Browser half of the annotator.
 *
 * It registers one document renderer per annotatable kind — images and PDFs —
 * so opening either in the right Sidebar offers the annotator, and registers
 * each renderer's body in the keyed document slot. The PDF body lives in a
 * package-local chunk that is fetched only when a PDF opens.
 * Everything else — reading the figure bytes, storing marks, reaching the agent —
 * happens inside a body through the owner and the injected session service.
 *
 * All three services are hard requirements: without the preview registry there is
 * nothing to open, without the slot registry nowhere to render, and without the
 * locale registry no copy to render with. A composition missing any of them gets a
 * loud failure rather than a silently half-mounted plugin.
 * @module dsh-annotator/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { AnnotatorBody } from './AnnotatorBody'
import type { AnnotatorInjected } from './AnnotatorBody'
import { createDocumentSeat } from './document-seat'
import { LazyPdfBody } from './LazyPdfBody'
import { NAMESPACE, en, zh } from './locales'
import { missingService } from '../missing-service'
import type { PdfBodyInjected } from './pdf/PdfBody'
import type { FileUploadLike, SessionsLike } from './session'

/** Plugin name reported to the client module loader. */
export const name = 'dsh-annotator-client'

/** Client services this plugin waits for before it mounts anything. */
export const inject = ['slots', 'locale', 'documentPreviews']

/** Implementation identity of the image renderer, shared by its metadata and its slot entry. */
export const BODY_ID = 'dsh-annotator/image'

/** Implementation identity of the PDF renderer, shared by its metadata and its slot entry. */
export const PDF_BODY_ID = 'dsh-annotator/pdf'

/** Suffixes the annotator claims for whole-file figures, matching the shell's builtin image renderer. */
const EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'] as const

/** Suffixes whose bytes are not readable as text. */
const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'] as const

/** Suffix the PDF renderer claims, ranking above the shell's read-only PDF preview. */
const PDF_EXTENSIONS = ['pdf'] as const

/** Document renderer registry slice this plugin registers into. */
interface DocumentPreviewsLike {
  register(definition: {
    id: string
    extensions: readonly string[]
    binaryExtensions?: readonly string[]
    priority?: 'builtin' | 'extension'
    title: () => string
    loading: 'text-pages' | 'bytes-complete' | 'renderer'
    wrap?: boolean
  }): () => void
}

/** Slot registry slice this plugin registers into. */
interface SlotsLike {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Locale registry slice this plugin registers into. */
interface LocaleLike {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
  getLocale(): { readonly locale?: string }
}

/** What the keyed body slot injects, typed so no `any` crosses the hand-off. */
type BodyInjected = AnnotatorInjected

/**
 * Mount the browser half.
 * @param ctx - the plugin's client context.
 * @throws {Error} when a required service is missing from the composition.
 */
export function apply(ctx: Context): void {
  const locale = ctx.get('locale') as LocaleLike | undefined
  const previews = ctx.get('documentPreviews') as DocumentPreviewsLike | undefined
  const slots = ctx.get('slots') as SlotsLike | undefined
  if (locale === undefined) throw new Error(missingService('locale'))
  if (previews === undefined) throw new Error(missingService('documentPreviews'))
  if (slots === undefined) throw new Error(missingService('slots'))
  ctx.effect(
    () => locale.register(NAMESPACE, { zh, en }),
    'dsh-annotator: dictionaries',
  )
  ctx.effect(() => previews.register({
    id: BODY_ID,
    extensions: EXTENSIONS,
    binaryExtensions: BINARY_EXTENSIONS,
    priority: 'extension',
    title: () => locale.bind(NAMESPACE)('title'),
    loading: 'bytes-complete',
    wrap: false,
  }), 'dsh-annotator: renderer metadata')
  ctx.effect(() => slots.inject('sidebar.right.tab.document', () => slots.register({
    name: 'sidebar.right.tab.document',
    key: BODY_ID,
    locale: NAMESPACE,
    inject: (sessionId: unknown): BodyInjected => ({
      sessions: ctx.get('sessions') as SessionsLike | undefined,
      sessionId: String(sessionId),
      localeId: locale.getLocale().locale ?? 'zh',
    }),
  }, AnnotatorBody)), 'dsh-annotator: document body')
  ctx.effect(() => previews.register({
    id: PDF_BODY_ID,
    extensions: PDF_EXTENSIONS,
    binaryExtensions: PDF_EXTENSIONS,
    priority: 'extension',
    title: () => locale.bind(NAMESPACE)('pdfTitle'),
    loading: 'bytes-complete',
    wrap: false,
  }), 'dsh-annotator: pdf renderer metadata')
  ctx.effect(() => slots.inject('sidebar.right.tab.document', () => slots.register({
    name: 'sidebar.right.tab.document',
    key: PDF_BODY_ID,
    locale: NAMESPACE,
    // The chunk cannot import its own package's entry bundle, so the annotator body
    // it renders each page with, and the seat that reads, writes and delivers the
    // document's one annotation, cross as injected props.
    inject: (sessionId: unknown): PdfBodyInjected => ({
      AnnotatorBody,
      seat: createDocumentSeat({
        sessions: ctx.get('sessions') as SessionsLike | undefined,
        fileUpload: ctx.get('fileUpload') as FileUploadLike | undefined,
        sessionId: String(sessionId),
        locale: locale.getLocale().locale?.startsWith('en') === true ? 'en' : 'zh',
      }),
    }),
  }, LazyPdfBody)), 'dsh-annotator: pdf document body')
}
