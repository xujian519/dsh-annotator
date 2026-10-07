/**
 * Delivering one annotation, or one edit proposal, to the agent.
 *
 * The delivery is an ordinary user message: the flattened review artifact as an
 * attached file when the figure has pages, the review image of every annotated
 * page (the model sees the marks directly when its route accepts images), and the
 * numbered summary plus the sidecar paths as text. An edit proposal carries the
 * unified diff of what the reader changed instead of marks, and the edited text
 * itself as an attachment when the diff exceeds the message's budget. Nothing
 * bypasses the session log, so what the agent saw is what the transcript holds.
 * @module dsh-annotator/client/session
 */

import { baseNameOf } from '../shared/address'
import type { AnnotationDocument, SummaryLocale } from '../shared/annotation'
import { annotatedPages, describeFigureScope, describeMarks, pageFileSuffix } from '../shared/annotation'
import { formatHunkHeader, formatUnifiedDiff, type DiffHunk, type TextDiff } from '../shared/text-diff'

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
  readonly attachmentId: string;
  /** Display name the store kept. */
  readonly name: string;
  /** Stored byte length. */
  readonly bytes: number;
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
  // A rendered document is measured in the pixels it was laid out in, and it has
  // no picture: the marks file and the locators inside it are the whole payload.
  const rendered = figure.mediaType === 'text/html'
  const size = figure.width === undefined || figure.height === undefined
    ? ''
    : rendered
      ? (zh
        ? `渲染面 ${Math.round(figure.width)}×${Math.round(figure.height)}，`
        : `rendered surface ${Math.round(figure.width)}x${Math.round(figure.height)}, `)
      : (zh
        ? `图面 ${Math.round(figure.width)}×${Math.round(figure.height)}，`
        : `figure ${Math.round(figure.width)}x${Math.round(figure.height)}, `)
  const pages = annotatedPages(document)
  const marked = pages.length === 0
    ? ''
    : (zh ? `其中 ${pages.length} 页有标注，` : `${pages.length} pages marked, `)
  const kind = rendered
    ? (zh ? '【HTML 标注】' : '[HTML annotations]')
    : (zh ? '【附图标注】' : '[figure annotations]')
  const hash = zh
    ? `${rendered ? '文件' : '图'} sha256:${figure.sha256.slice(0, 12)}`
    : `sha256:${figure.sha256.slice(0, 12)}`
  const header = zh
    ? `${kind}${figure.path}（${scope === '' ? '' : `${scope}，`}${size}${marked}标注 ${marks.length} 处，${hash}）`
    : `${kind} ${figure.path} (${scope === '' ? '' : `${scope}, `}${size}${marked}${marks.length} marks, ${hash})`
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
  const closing = rendered
    ? (zh
      ? '请按上述标注逐条修改这份 HTML 的生成源（不要改动渲染结果本身）。定位元素以 `anchor.selector` 为准，`points` 只是辅助：渲染宽度变化会让坐标漂移。未标注的部分保持不动，改完后逐条回应。'
      : 'Address each mark above in the HTML source that generates this document (not in the rendered result). Locate elements by `anchor.selector`; `points` only assists, because coordinates drift when the render width changes. Leave unmarked parts untouched and answer mark by mark.')
    : paged
      ? (zh
        ? '请按上述标注逐条处理该 PDF（带批注 PDF 的每一页已带原生批注对象，可直接在阅读器里核对）；未标注的部分保持不动，改完后逐条回应。'
        : 'Address each mark above in the PDF (every page of the annotated PDF carries native annotation objects you can check in a reader); leave unmarked parts untouched and answer mark by mark.')
      : (zh
        ? '请按上述标注逐条修复该附图（改生成源，不要涂改导出的位图）；未标注的部分保持不动，改完后逐条回应。'
        : 'Fix the figure for each mark above (change the generating source, not the exported bitmap); leave unmarked parts untouched and answer mark by mark.')
  return [header, ...files, '', ...summary, ...describeMarks(document, locale), '', closing].join('\n')
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

/** What one attachment needs to travel, or to fail loudly in the reader's language. */
interface Attachment {
  /** The bytes the session receives. */
  readonly bytes: Uint8Array
  /** File name the store keeps. */
  readonly name: string
  /** What a warning calls this attachment, in both languages. */
  readonly noun: { readonly zh: string; readonly en: string }
}

/** What one {@link attachFile} call acts through. */
interface AttachInput {
  /** The upload service, when the composition provides one. */
  readonly fileUpload: FileUploadLike | undefined
  /** The live session face, when one is bound. */
  readonly session: SessionFaceLike | undefined
  /** Session the file belongs to. */
  readonly sessionId: string
  /** Parts being built, appended to when the file was attached. */
  readonly content: unknown[]
  /** Warnings being collected. */
  readonly warnings: string[]
  /** Whether the reader's language is Chinese. */
  readonly zh: boolean
  /** The file itself. */
  readonly attachment: Attachment
}

/**
 * Attach one file to the message, unless this composition or session cannot take one.
 *
 * A subagent continuation refuses file parts outright, and a composition without
 * the upload service has nowhere to store the bytes; both are reported as a
 * warning and the message still goes out with its text.
 *
 * @param input - the upload seats, the parts being built, and the file.
 */
async function attachFile(input: AttachInput): Promise<void> {
  const { zh } = input
  const { noun } = input.attachment
  const fileUpload = input.fileUpload
  if (fileUpload === undefined) {
    input.warnings.push(zh
      ? `本次组合没有附件服务，${noun.zh}未随消息发送。`
      : `This composition has no upload service, so the ${noun.en} was not attached.`)
    return
  }
  if (input.session?.address !== undefined) {
    input.warnings.push(zh
      ? `当前会话是子会话，不接受文件附件，${noun.zh}未随消息发送。`
      : `This session is a subagent continuation and takes no file attachments, so the ${noun.en} was not attached.`)
    return
  }
  try {
    const uploaded = await fileUpload.upload(input.sessionId, input.attachment.bytes, input.attachment.name)
    if (!uploaded.ok) throw new Error(uploaded.error.message ?? 'the upload was refused')
    input.content.push({ type: 'file', attachment: uploaded.value.file })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    input.warnings.push(zh
      ? `${noun.zh}未能随消息发送：${reason}`
      : `The ${noun.en} was not attached: ${reason}`)
  }
}

/**
 * Attach the annotated document to the message, unless this session cannot take one.
 * @param input - the delivery being composed.
 * @param session - the live session face, when one is bound.
 * @param content - parts being built, appended to when the file was attached.
 * @param warnings - warnings being collected.
 */
async function attachAnnotatedPdf(
  input: DeliveryInput,
  session: SessionFaceLike | undefined,
  content: unknown[],
  warnings: string[],
): Promise<void> {
  const bytes = input.annotatedPdf
  if (bytes === undefined) return
  const name = input.paths.reviewPath === null
    ? `${baseNameOf(input.document.figure.path)}.annotated.pdf`
    : baseNameOf(input.paths.reviewPath)
  await attachFile({
    fileUpload: input.fileUpload,
    session,
    sessionId: input.sessionId,
    content,
    warnings,
    zh: input.locale === 'zh',
    attachment: { bytes, name, noun: { zh: '带批注 PDF', en: 'annotated PDF' } },
  })
}

/**
 * Hand one message to the session, whether it is live or has to be resumed.
 * @param sessions - the client sessions service.
 * @param sessionId - session the message belongs to.
 * @param session - the live session face, when one is bound.
 * @param content - the parts to send.
 * @param refusal - the message an answer without `ok` is reported with.
 * @throws {Error} when the session is unknown or refuses the prompt.
 */
async function promptSession(
  sessions: SessionsLike,
  sessionId: string,
  session: SessionFaceLike | undefined,
  content: readonly unknown[],
  refusal: string,
): Promise<void> {
  const result = session === undefined
    ? await sessions.using(sessionId, { source: 'dsh-annotator' }, async (reference) => {
      const binding = await reference.ready
      return await binding.session.prompt(content, 'queue')
    })
    : await session.prompt(content, 'queue')
  if (!result.ok) throw new Error(result.error?.message ?? refusal)
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
      name: `${baseNameOf(input.document.figure.path)}${paged ? pageFileSuffix(entry.page) : ''}.annotated.png`,
    })
  }
  if (shown.length < input.pageImages.length) {
    const hidden = input.pageImages.length - shown.length
    warnings.push(zh ? `另有 ${hidden} 页标注未附图，请看带批注 PDF。` : `${hidden} more annotated pages are not attached as images; see the annotated PDF.`)
  }
  content.push({ type: 'text', text: buildAnnotationMessage(input.document, input.paths, input.locale) })
  await promptSession(input.sessions, input.sessionId, session, content, 'the session refused the annotation message')
  return warnings
}

/** Most diff lines one edit message carries before it defers to an attachment. */
export const MAX_DIFF_LINES = 400

/** One diff fitted into a message. */
export interface FittedDiff {
  /** The unified diff the message carries. */
  readonly text: string
  /** Hunks the message left out because they did not fit. */
  readonly hidden: number
}

/**
 * Fit a difference into the message's line budget, whole hunks at a time.
 *
 * A hunk is never cut in half — a half hunk is not a diff anyone can apply — so
 * the budget drops trailing hunks and reports how many went with the attachment
 * instead. The first hunk always travels, however large it is: a message that
 * carries nothing but "see the attachment" would be worse than a long one.
 *
 * @param displayPath - the path the diff header names.
 * @param diff - the difference to fit.
 * @param maxLines - the message's diff budget, header lines included.
 * @returns the diff text and the number of hunks left out.
 */
export function fitDiff(displayPath: string, diff: TextDiff, maxLines: number = MAX_DIFF_LINES): FittedDiff {
  const kept: DiffHunk[] = []
  let used = 0
  for (const hunk of diff.hunks) {
    const size = hunk.lines.length + 1
    if (kept.length > 0 && used + size > maxLines) break
    kept.push(hunk)
    used += size
  }
  return {
    text: formatUnifiedDiff(displayPath, { ...diff, hunks: kept }),
    hidden: diff.hunks.length - kept.length,
  }
}

/** What one edit message is composed from. */
export interface EditMessageInput {
  /** Path the message names: the document's own, or its address when unparsed. */
  readonly documentPath: string
  /** The whole difference. */
  readonly diff: TextDiff
  /** The part of it the message carries. */
  readonly fitted: FittedDiff
  /** The reader's notes, keyed by the baseline line the change starts at. */
  readonly notes: Readonly<Record<number, string>>
  /** Whether the loaded baseline moved while the reader was editing. */
  readonly stale: boolean
  /** Message language. */
  readonly locale: SummaryLocale
}

/**
 * Spell the reader's notes as the numbered list the message carries.
 *
 * A note is keyed by the baseline line its change starts at, so it stays put
 * while the reader keeps editing; the hunk that starts there is named when one
 * still does. A note whose change the reader has since removed is still sent —
 * the line number is the reader's own reference and they wrote it on purpose —
 * it just travels without a hunk header.
 *
 * @param diff - the whole difference, for pairing notes with their hunk.
 * @param notes - the reader's notes.
 * @param locale - message language.
 * @returns one line per note, in line order; empty when there are none.
 */
export function describeNotes(
  diff: TextDiff,
  notes: Readonly<Record<number, string>>,
  locale: SummaryLocale,
): string[] {
  const zh = locale === 'zh'
  const lines: string[] = []
  const keys = Object.keys(notes).map(Number).sort((left, right) => left - right)
  for (const key of keys) {
    const text = notes[key]
    if (text === undefined || text.trim() === '') continue
    const hunk = diff.hunks.find(candidate => candidate.oldStart === key)
    const where = hunk === undefined ? '' : `（${formatHunkHeader(hunk)}）`
    lines.push(zh
      ? `${lines.length + 1}. 第 ${key} 行${where}：${text.trim()}`
      : `${lines.length + 1}. line ${key}${hunk === undefined ? '' : ` (${formatHunkHeader(hunk)})`}: ${text.trim()}`)
  }
  return lines
}

/**
 * Compose the user message that carries one edit proposal.
 * @param input - the document, its difference, and what the message could not carry.
 * @returns the message text.
 */
export function buildEditMessage(input: EditMessageInput): string {
  const zh = input.locale === 'zh'
  const { diff, fitted } = input
  const readerNotes = describeNotes(diff, input.notes, input.locale)
  const counted = readerNotes.length === 0 ? '' : (zh ? `，说明 ${readerNotes.length} 条` : `, ${readerNotes.length} notes`)
  const header = zh
    ? `【文档修改建议】${input.documentPath}（Markdown，改动 ${diff.hunks.length} 处，+${diff.added} −${diff.removed} 行${counted}）`
    : `[document edits] ${input.documentPath} (Markdown, ${diff.hunks.length} hunks, +${diff.added} -${diff.removed} lines${counted})`
  const warnings: string[] = []
  if (input.stale) {
    warnings.push(zh
      ? '注意：文件在编辑期间被改动过，这份 diff 基于较早的版本，可能无法直接应用。'
      : 'Note: the file changed while it was being edited, so this diff is against an earlier version and may not apply cleanly.')
  }
  if (diff.coarse) {
    warnings.push(zh ? '改动较大，diff 以整块替换呈现。' : 'The change is large, so the diff reads as one replacement block.')
  }
  if (fitted.hidden > 0) {
    const name = `${baseNameOf(input.documentPath)}.edited.md`
    warnings.push(zh
      ? `另有 ${fitted.hidden} 处改动未在本消息里展开，完整结果见随本消息发送的 ${name}。`
      : `${fitted.hidden} more hunks are not expanded here; the complete result is attached as ${name}.`)
  }
  const closing = zh
    ? '我已在文档预览里改好，但**没有落盘**：请把这段 diff 应用到源文件，或据此复核我的改动；diff 之外的部分不要动，改完逐处回应。'
    : 'I made these edits in the document preview and did **not** write them to disk: apply this diff to the source, or review my change against it; leave everything outside the diff untouched and answer hunk by hunk.'
  return [
    header,
    '',
    '```diff',
    fitted.text,
    '```',
    ...(readerNotes.length === 0 ? [] : ['', zh ? '我的说明：' : 'My notes:', ...readerNotes]),
    ...(warnings.length === 0 ? [] : ['', ...warnings]),
    '',
    closing,
  ].join('\n')
}

/** Everything one edit proposal delivery needs. */
export interface EditDeliveryInput {
  /** The client sessions service. */
  readonly sessions: SessionsLike
  /** The client upload service, when the composition provides one. */
  readonly fileUpload: FileUploadLike | undefined
  /** Session the document belongs to. */
  readonly sessionId: string
  /** Path the message names: the document's own, or its address when unparsed. */
  readonly documentPath: string
  /** The difference against the version the document was opened with. */
  readonly diff: TextDiff
  /** The reader's whole edited text, attached when the message cannot carry the diff. */
  readonly editedText: string
  /** The reader's notes, keyed by the baseline line the change starts at. */
  readonly notes: Readonly<Record<number, string>>
  /** Whether the loaded baseline moved while the reader was editing. */
  readonly stale: boolean
  /** Message language. */
  readonly locale: SummaryLocale
}

/**
 * Send one edit proposal into the session that owns the document.
 *
 * Nothing here writes the document: the diff in the message is the deliverable,
 * and the edited text travels as an attachment only when the diff did not fit.
 *
 * @param input - the document, its difference, and the session to reach.
 * @returns what the delivery could not do, empty when it did everything.
 * @throws {Error} when the session is unknown or refuses the prompt.
 */
export async function deliverEdit(input: EditDeliveryInput): Promise<readonly string[]> {
  const zh = input.locale === 'zh'
  const warnings: string[] = []
  const content: unknown[] = []
  const live = input.sessions.scope(input.sessionId)
  const session = live === undefined ? undefined : input.sessions.sessionOf(live)
  const fitted = fitDiff(input.documentPath, input.diff)
  if (fitted.hidden > 0) {
    await attachFile({
      fileUpload: input.fileUpload,
      session,
      sessionId: input.sessionId,
      content,
      warnings,
      zh,
      attachment: {
        bytes: new TextEncoder().encode(input.editedText),
        name: `${baseNameOf(input.documentPath)}.edited.md`,
        noun: { zh: '编辑后的副本', en: 'edited copy' },
      },
    })
  }
  content.push({
    type: 'text',
    text: buildEditMessage({
      documentPath: input.documentPath,
      diff: input.diff,
      fitted,
      notes: input.notes,
      stale: input.stale,
      locale: input.locale,
    }),
  })
  await promptSession(input.sessions, input.sessionId, session, content, 'the session refused the edit message')
  return warnings
}
