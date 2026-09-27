/**
 * Delivering one annotation to the agent.
 *
 * The delivery is an ordinary user message: the flattened review image as an
 * image part (the model sees the marks directly when its route accepts images)
 * plus the numbered summary and the two sidecar paths as text. Nothing here
 * bypasses the session log, so what the agent saw is what the transcript holds.
 * @module dsh-annotator/client/session
 */

import type { AnnotationDocument, SummaryLocale } from '../shared/annotation'
import { describeMarks } from '../shared/annotation'

/** The session face this module calls. */
interface SessionFaceLike {
  prompt(
    content: readonly unknown[],
    mode: 'queue' | 'steer',
  ): Promise<{ ok: boolean; error?: { message?: string } }>
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

/** Paths the annotation was written to, as the message must name them. */
export interface DeliveredPaths {
  /** Absolute path of the marks file. */
  readonly annotationPath: string
  /** Absolute path of the flattened review image, when one was written. */
  readonly annotatedImagePath: string | null
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
  const header = zh
    ? `【附图标注】${figure.path}（图面 ${Math.round(figure.width)}×${Math.round(figure.height)}，标注 ${marks.length} 处，图 sha256:${figure.sha256.slice(0, 12)}）`
    : `[figure annotations] ${figure.path} (figure ${Math.round(figure.width)}x${Math.round(figure.height)}, ${marks.length} marks, sha256:${figure.sha256.slice(0, 12)})`
  const files = [
    zh ? `标注文件：${paths.annotationPath}` : `annotation file: ${paths.annotationPath}`,
    ...(paths.annotatedImagePath === null ? [] : [zh ? `标注图：${paths.annotatedImagePath}` : `annotated image: ${paths.annotatedImagePath}`]),
  ]
  const summary = document.summary !== undefined && document.summary.trim() !== ''
    ? [zh ? `我的总体说明：${document.summary.trim()}` : `overall note: ${document.summary.trim()}`, '']
    : []
  const closing = zh
    ? '请按上述标注逐条修复该附图（改生成源，不要涂改导出的位图）；未标注的部分保持不动，改完后逐条回应。'
    : 'Fix the figure for each mark above (change the generating source, not the exported bitmap); leave unmarked parts untouched and answer mark by mark.'
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
 * Send one annotation into the session that owns the figure.
 * @param sessions - the client sessions service.
 * @param sessionId - the Session named by the preview address.
 * @param document - the saved document.
 * @param paths - sidecar paths the Host wrote.
 * @param reviewImage - flattened PNG, attached when present.
 * @param locale - message language.
 * @throws {Error} when the session is unknown or the Host refuses the prompt.
 */
export async function deliverAnnotation(
  sessions: SessionsLike,
  sessionId: string,
  document: AnnotationDocument,
  paths: DeliveredPaths,
  reviewImage: Blob | undefined,
  locale: SummaryLocale,
): Promise<void> {
  const content: unknown[] = []
  if (reviewImage !== undefined) {
    content.push({
      type: 'image',
      mediaType: 'image/png',
      data: await encodePng(reviewImage),
      name: `${baseName(document.figure.path)}.annotated.png`,
    })
  }
  content.push({ type: 'text', text: buildAnnotationMessage(document, paths, locale) })
  const live = sessions.scope(sessionId)
  const session = live === undefined ? undefined : sessions.sessionOf(live)
  const result = session === undefined
    ? await sessions.using(sessionId, { source: 'dsh-annotator' }, async (reference) => {
      const binding = await reference.ready
      return await binding.session.prompt(content, 'queue')
    })
    : await session.prompt(content, 'queue')
  if (!result.ok) throw new Error(result.error?.message ?? 'the session refused the annotation message')
}
