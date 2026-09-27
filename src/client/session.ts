/**
 * Delivering one annotation to the agent.
 *
 * The delivery is an ordinary user message: the flattened review artifact as an
 * attached file when the figure has pages, the review image of every annotated
 * page (the model sees the marks directly when its route accepts images), and the
 * numbered summary plus the sidecar paths as text. Nothing here bypasses the
 * session log, so what the agent saw is what the transcript holds.
 * @module dsh-annotator/client/session
 */

import type { AnnotationDocument, SummaryLocale } from '../shared/annotation'
import { annotatedPages, describeFigureScope, describeMarks, pageFileSuffix } from '../shared/annotation'

/** The session face this module calls. */
interface SessionFaceLike {
  prompt(
    content: readonly unknown[],
    mode: 'queue' | 'steer',
  ): Promise<{ ok: boolean; error?: { message?: string } }>
  /** Present only on a subagent continuation, which cannot take file attachments. */
  readonly address?: unknown
}

/** The sessions service slice this module calls. */
export interface SessionsLike {
  scope(id: string): unknown
  sessionOf(scope: unknown): SessionFaceLike | undefined
  using<T>(
    id: string,
    options: { source: string },
    operation: (reference: {
      readonly ready: Promise<{ readonly session: SessionFaceLike }>
    }) => T | Promise<T>,
  ): Promise<T>
}

/** A durable file reference the attachment store returned. */
export interface FileAttachmentRefLike {
  /** Content-addressed identifier of the stored bytes. */
  readonly attachmentId: string
  /** Display name the store kept. */
  readonly name: string
  /** Stored byte length. */
  readonly bytes: number
}

/** The client upload service slice this module calls. */
export interface FileUploadLike {
  upload(
    sessionId: string,
    data: Uint8Array,
    name: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly file: FileAttachmentRefLike } }
    | { readonly ok: false; readonly error: { readonly message?: string } }
  >
}

/** Paths the annotation was written to, as the message must name them. */
export interface DeliveredPaths {
  /** Absolute path of the marks file. */
  readonly annotationPath: string
  /** Absolute path of the flattened review artifact, when one was written. */
  readonly reviewPath: string | null
}

/** Most annotated pages whose review image one message carries. */
export const MAX_PAGE_IMAGES = 8

/** One annotated page rendered for the session. */
export interface DeliveredPageImage {
  /** 1-based page the image shows. */
  readonly page: number
  /** The rendered page with its marks. */
  readonly image: Blob
}

/** Everything one delivery needs. */
export interface DeliveryInput {
  /** The client sessions service. */
  readonly sessions: SessionsLike
  /** The client upload service, when the composition provides one. */
  readonly fileUpload: FileUploadLike | undefined
  /** Session the figure belongs to. */
  readonly sessionId: string
  /** The saved document. */
  readonly document: AnnotationDocument
  /** Paths the Host wrote. */
  readonly paths: DeliveredPaths
  /** Review images of the annotated pages, in page order. */
  readonly pageImages: readonly DeliveredPageImage[]
  /** The document carrying the written-back annotations, when there is one. */
  readonly annotatedPdf: Uint8Array | undefined
  /** Message language. */
  readonly locale: SummaryLocale
}

/**
 * Compose the user message that carries one annotation.
 * @param document - the saved document.
 * @param paths - sidecar paths the Host wrote.
 * @param locale - message language.
 * @returns the message text.
 */
export function buildAnnotationMessage(
  document: AnnotationDocument,
  paths: DeliveredPaths,
  locale: SummaryLocale,
): string {
  const zh = locale === 'zh'
  const { figure, marks } = document
  const scope = describeFigureScope(figure, locale)
  const size = figure.width === undefined || figure.height === undefined
    ? ''
    : (zh
      ? `图面 ${Math.round(figure.width)}×${Math.round(figure.height)}，`
      : `figure ${Math.round(figure.width)}x${Math.round(figure.height)}, `)
  const pages = annotatedPages(document)
  const marked = pages.length === 0
    ? ''
    : (zh ? `其中 ${pages.length} 页有标注，` : `${pages.length} pages marked, `)
  const header = zh
    ? `【附图标注】${figure.path}（${scope === '' ? '' : `${scope}，`}${size}${marked}标注 ${marks.length} 处，图 sha256:${figure.sha256.slice(0, 12)}）`
    : `[figure annotations] ${figure.path} (${scope === '' ? '' : `${scope}, `}${size}${marked}${marks.length} marks, sha256:${figure.sha256.slice(0, 12)})`
  const paged = figure.pageCount !== undefined
  const files = [
    zh ? `标注文件：${paths.annotationPath}` : `annotation file: ${paths.annotationPath}`,
    ...(paths.reviewPath === null
      ? []
      : [paged
        ? (zh ? `带批注 PDF：${paths.reviewPath}（已作为本条消息的附件发送）` : `annotated PDF: ${paths.reviewPath} (attached to this message)`)
        : (zh ? `标注图：${paths.reviewPath}` : `annotated image: ${paths.reviewPath}`)]),
  ]
  const summary = document.summary !== undefined && document.summary.trim() !== ''
    ? [zh ? `我的总体说明：${document.summary.trim()}` : `overall note: ${document.summary.trim()}`, '']
    : []
  const closing = paged
    ? (zh
      ? '请按上述标注逐条处理该 PDF（带批注 PDF 的每一页已带原生批注对象，可直接在阅读器里核对）；未标注的部分保持不动，改完后逐条回应。'
      : 'Address each mark above in the PDF (every page of the annotated PDF carries native annotation objects you can check in a reader); leave unmarked parts untouched and answer mark by mark.')
    : (zh
      ? '请按上述标注逐条修复该附图（改生成源，不要涂改导出的位图）；未标注的部分保持不动，改完后逐条回应。'
      : 'Fix the figure for each mark above (change the generating source, not the exported bitmap); leave unmarked parts untouched and answer mark by mark.')
  return [header, ...files, '', ...summary, ...describeMarks(document, locale), '', closing].join('\n')
}

/**
 * The file name at the end of a path, without the directory part.
 * @param path - a workspace path, POSIX- or Windows-separated.
 * @returns the last path segment.
 */
function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Encode one PNG blob as base64 for the prompt's image part.
 * @param blob - PNG bytes.
 * @returns base64 text.
 */
async function encodePng(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Attach the annotated document to the message, unless this session cannot take one.
 *
 * A subagent continuation refuses file parts outright, and a composition without
 * the upload service has nowhere to store the bytes; both are reported as a
 * warning and the message still goes out with the text and the page images.
 *
 * @param input - the delivery being composed.
 * @param content - parts being built, appended to when the file was attached.
 * @param warnings - warnings being collected.
 */
async function attachAnnotatedPdf(
  input: DeliveryInput,
  session: SessionFaceLike | undefined,
  content: unknown[],
  warnings: string[],
): Promise<void> {
  const zh = input.locale === 'zh'
  const bytes = input.annotatedPdf
  if (bytes === undefined) return
  const name = input.paths.reviewPath === null
    ? `${baseName(input.document.figure.path)}.annotated.pdf`
    : baseName(input.paths.reviewPath)
  if (input.fileUpload === undefined) {
    warnings.push(zh ? '本次组合没有附件服务，带批注 PDF 未随消息发送。' : 'This composition has no upload service, so the annotated PDF was not attached.')
    return
  }
  if (session?.address !== undefined) {
    warnings.push(zh ? '当前会话是子会话，不接受文件附件，带批注 PDF 未随消息发送。' : 'This session is a subagent continuation and takes no file attachments, so the annotated PDF was not attached.')
    return
  }
  try {
    const uploaded = await input.fileUpload.upload(input.sessionId, bytes, name)
    if (!uploaded.ok) throw new Error(uploaded.error.message ?? 'the upload was refused')
    content.push({ type: 'file', attachment: uploaded.value.file })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warnings.push(zh ? `带批注 PDF 未能随消息发送：${reason}` : `The annotated PDF was not attached: ${reason}`)
  }
}

/**
 * Send one annotation into the session that owns the figure.
 * @param input - the document, its written files, and the pages rendered for it.
 * @returns what the delivery could not do, empty when it did everything.
 * @throws {Error} when the session is unknown or the Host refuses the prompt.
 */
export async function deliverAnnotation(input: DeliveryInput): Promise<readonly string[]> {
  const zh = input.locale === 'zh'
  const warnings: string[] = []
  const content: unknown[] = []
  const live = input.sessions.scope(input.sessionId)
  const session = live === undefined ? undefined : input.sessions.sessionOf(live)
  await attachAnnotatedPdf(input, session, content, warnings)
  const shown = input.pageImages.slice(0, MAX_PAGE_IMAGES)
  const paged = input.document.figure.pageCount !== undefined
  for (const entry of shown) {
    content.push({
      type: 'image',
      mediaType: 'image/png',
      data: await encodePng(entry.image),
      name: `${baseName(input.document.figure.path)}${paged ? pageFileSuffix(entry.page) : ''}.annotated.png`,
    })
  }
  if (shown.length < input.pageImages.length) {
    const hidden = input.pageImages.length - shown.length
    warnings.push(zh ? `另有 ${hidden} 页标注未附图，请看带批注 PDF。` : `${hidden} more annotated pages are not attached as images; see the annotated PDF.`)
  }
  content.push({ type: 'text', text: buildAnnotationMessage(input.document, input.paths, input.locale) })
  const result = session === undefined
    ? await input.sessions.using(input.sessionId, { source: 'dsh-annotator' }, async (reference) => {
      const binding = await reference.ready
      return await binding.session.prompt(content, 'queue')
    })
    : await session.prompt(content, 'queue')
  if (!result.ok) throw new Error(result.error?.message ?? 'the session refused the annotation message')
  return warnings
}
