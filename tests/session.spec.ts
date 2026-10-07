/** Delivering an annotation into a session: the attached document, the page images, and the failures. */
import { describe, expect, it } from 'vitest'
import type { AnnotationDocument } from '../src/shared/annotation'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import {
  MAX_DIFF_LINES,
  MAX_PAGE_IMAGES,
  buildAnnotationMessage,
  buildEditMessage,
  deliverAnnotation,
  deliverEdit,
  describeNotes,
  fitDiff,
  type FileUploadLike,
  type SessionsLike,
} from '../src/client/session'
import { EMPTY_DIFF, diffLines } from '../src/shared/text-diff'

const document_: AnnotationDocument = {
  version: ANNOTATION_VERSION,
  figure: {
    address: 'dsh-resource://file/session/s1/fig1.svg',
    path: '/w/fig1.svg',
    mediaType: 'image/svg+xml',
    width: 10,
    height: 10,
    sha256: 'b'.repeat(64),
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  marks: [{ id: 'm1', kind: 'arrow', color: '#e03131', points: [[1, 1], [2, 2]], text: '指错了' }],
  summary: '标号要往左',
}

const pagedDocument: AnnotationDocument = {
  ...document_,
  figure: { address: 'dsh-resource://file/session/s1/report.pdf', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'c'.repeat(64), pageCount: 12 },
  marks: [
    { id: 'p1', kind: 'arrow', color: '#e03131', points: [[1, 1], [2, 2]], text: '第一页', page: 1 },
    { id: 'p2', kind: 'rect', color: '#1971c2', points: [[3, 3], [4, 4]], page: 3 },
    { id: 'p3', kind: 'pen', color: '#2f9e44', points: [[5, 5], [6, 6]], page: 3 },
  ],
}

const paths = { annotationPath: '/w/fig1.annot.json', reviewPath: '/w/fig1.annotated.png' }
const pagedPaths = { annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' }

/** A rendered HTML document: one surface, measured in the pixels it was laid out in. */
const htmlDocument: AnnotationDocument = {
  ...document_,
  figure: {
    address: 'dsh-resource://file/session/s1/report.html',
    path: '/w/report.html',
    mediaType: 'text/html',
    width: 1024,
    height: 1843,
    sha256: 'd'.repeat(64),
  },
  marks: [{
    id: 'h1',
    kind: 'rect',
    color: '#e03131',
    points: [[10, 20], [60, 90]],
    text: '这段要改',
    anchor: { tag: 'p', bbox: [0, 0, 1024, 200], text: '第一段', selector: '#s > p:nth-of-type(1)' },
  }],
}

/** The marks file a rendered document writes: never a second artifact. */
const htmlPaths = { annotationPath: '/w/report.html.annot.json', reviewPath: null }

/** One content part handed to the session. */
interface Part {
  readonly type: string
  readonly text?: string
  readonly mediaType?: string
  readonly data?: string
  readonly name?: string
  readonly attachment?: { readonly attachmentId: string }
}

/** One PNG blob of a size a spec chooses. */
function blobOf(bytes = 3): Blob {
  return new Blob([new Uint8Array(bytes).fill(1)], { type: 'image/png' })
}

/** One upload service stub. */
function stubUpload(outcome: 'ok' | 'refused' | 'throws' | 'missing' = 'ok'): {
  readonly fileUpload: FileUploadLike | undefined
  readonly uploads: { readonly sessionId: string; readonly bytes: number; readonly name: string }[]
} {
  const uploads: { sessionId: string; bytes: number; name: string }[] = []
  if (outcome === 'missing') return { fileUpload: undefined, uploads }
  const fileUpload: FileUploadLike = {
    upload: async (sessionId, data, name) => {
      uploads.push({ sessionId, bytes: data.byteLength, name })
      if (outcome === 'throws') throw new Error('upload transport failed')
      if (outcome === 'refused') return { ok: false, error: {} }
      return { ok: true, value: { file: { attachmentId: 'a'.repeat(64), name, bytes: data.byteLength } } }
    },
  }
  return { fileUpload, uploads }
}

/** A sessions service stub with one live session. */
function stubSessions(subagent = false): {
  readonly sessions: SessionsLike
  /** The same service seen from a session with no live binding. */
  readonly detached: SessionsLike
  readonly prompts: Part[][]
  readonly modes: string[]
  readonly sources: string[]
} {
  const prompts: Part[][] = []
  const modes: string[] = []
  const sources: string[] = []
  const face = {
    prompt: async (content: readonly unknown[], mode: string) => {
      prompts.push(content as Part[])
      modes.push(mode)
      return { ok: true }
    },
    ...(subagent ? { address: { parentSessionId: 'p', childSessionId: 'c' } } : {}),
  }
  const using = async (
    _id: string,
    options: { readonly source: string },
    operation: (reference: unknown) => unknown,
  ): Promise<unknown> => {
    sources.push(options.source)
    return await Promise.resolve(operation({ ready: Promise.resolve({ session: face }) }))
  }
  return {
    prompts,
    modes,
    sources,
    sessions: { scope: () => ({ live: true }), sessionOf: () => face, using } as unknown as SessionsLike,
    detached: { scope: () => undefined, sessionOf: () => undefined, using } as unknown as SessionsLike,
  }
}

/** Everything one delivery needs, with only the interesting parts spelled out. */
function delivery(overrides: Partial<Parameters<typeof deliverAnnotation>[0]> = {}): Parameters<typeof deliverAnnotation>[0] {
  return {
    sessions: stubSessions().sessions,
    fileUpload: undefined,
    sessionId: 's1',
    document: document_,
    paths,
    pageImages: [{ page: 1, image: blobOf() }],
    annotatedPdf: undefined,
    locale: 'zh',
    ...overrides,
  }
}

describe('delivering an annotation', () => {
  it('queues one image part and one text part on the live session', async () => {
    const stub = stubSessions()
    await deliverAnnotation(delivery({ sessions: stub.sessions }))
    expect(stub.modes).toEqual(['queue'])
    expect(stub.prompts).toHaveLength(1)
    const parts = stub.prompts[0] ?? []
    expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'AQEB', name: 'fig1.svg.annotated.png' })
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.text).toContain('【附图标注】/w/fig1.svg')
    expect(parts[1]?.text).toContain('标注文件：/w/fig1.annot.json')
    expect(parts[1]?.text).toContain('标注图：/w/fig1.annotated.png')
  })

  it('sends text alone when the browser could not render a page', async () => {
    const stub = stubSessions()
    await deliverAnnotation(delivery({ sessions: stub.sessions, pageImages: [], locale: 'en' }))
    const parts = stub.prompts[0] ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    expect(parts[0]?.text).toContain('[figure annotations]')
  })

  it('encodes an image larger than one base64 chunk', async () => {
    const stub = stubSessions()
    await deliverAnnotation(delivery({ sessions: stub.sessions, pageImages: [{ page: 1, image: blobOf(0x8000 + 3) }] }))
    expect((stub.prompts[0]?.[0]?.data ?? '').length).toBeGreaterThan(0x8000)
  })

  it('opens the session through the service when no live binding exists', async () => {
    const stub = stubSessions()
    await deliverAnnotation(delivery({ sessions: stub.detached, pageImages: [] }))
    expect(stub.sources).toEqual(['dsh-annotator'])
    expect(stub.prompts).toHaveLength(1)
  })

  it('names the annotation file when the review artifact was not written', async () => {
    const stub = stubSessions()
    await deliverAnnotation(delivery({
      sessions: stub.sessions,
      paths: { annotationPath: '/w/fig1.annot.json', reviewPath: null },
      pageImages: [],
    }))
    expect(stub.prompts[0]?.[0]?.text).not.toContain('标注图：')
  })

  it('reports the reason the session refused the message', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false, error: { message: 'session is closed' } }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverAnnotation(delivery({ sessions }))).rejects.toThrow('session is closed')
  })

  it('falls back to a plain message when the refusal carries no reason', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverAnnotation(delivery({ sessions }))).rejects.toThrow('the session refused the annotation message')
  })
})

describe('a document that has pages', () => {
  it('attaches the annotated PDF and one image per annotated page', async () => {
    const upload = stubUpload()
    const stub = stubSessions()
    const warnings = await deliverAnnotation({
      ...delivery(),
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1, 2, 3, 4]),
      pageImages: [{ page: 1, image: blobOf() }, { page: 3, image: blobOf() }],
    })
    expect(warnings).toEqual([])
    expect(upload.uploads).toEqual([{ sessionId: 's1', bytes: 4, name: 'report.pdf.annotated.pdf' }])
    const parts = stub.prompts[0] ?? []
    expect(parts[0]).toMatchObject({ type: 'file', attachment: { attachmentId: 'a'.repeat(64) } })
    expect(parts[1]).toMatchObject({ type: 'image', name: 'report.pdf.p1.annotated.png' })
    expect(parts[2]).toMatchObject({ type: 'image', name: 'report.pdf.p3.annotated.png' })
    expect(parts[3]?.text).toContain('带批注 PDF：/w/report.pdf.annotated.pdf（已作为本条消息的附件发送）')
  })

  it('caps the page images and says how many were left out', async () => {
    const stub = stubSessions()
    const pages = Array.from({ length: MAX_PAGE_IMAGES + 2 }, (_value, index) => ({ page: index + 1, image: blobOf() }))
    const warnings = await deliverAnnotation({ ...delivery(), sessions: stub.sessions, document: pagedDocument, paths: pagedPaths, pageImages: pages })
    expect(stub.prompts[0]?.filter(part => part.type === 'image')).toHaveLength(MAX_PAGE_IMAGES)
    expect(warnings).toEqual(['另有 2 页标注未附图，请看带批注 PDF。'])
  })

  it('warns instead of failing when the composition has no upload service', async () => {
    const stub = stubSessions()
    const warnings = await deliverAnnotation({
      ...delivery(),
      sessions: stub.sessions,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(stub.prompts[0]?.map(part => part.type)).toEqual(['text'])
    expect(warnings[0]).toContain('没有附件服务')
  })

  it('says the same warnings in English when the panel runs in English', async () => {
    const noUpload = await deliverAnnotation({
      ...delivery(),
      locale: 'en',
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(noUpload[0]).toContain('no upload service')
    const subagent = await deliverAnnotation({
      ...delivery(),
      sessions: stubSessions(true).sessions,
      locale: 'en',
      fileUpload: stubUpload().fileUpload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(subagent[0]).toContain('subagent continuation')
    const capped = await deliverAnnotation({
      ...delivery(),
      locale: 'en',
      document: pagedDocument,
      paths: pagedPaths,
      pageImages: Array.from({ length: MAX_PAGE_IMAGES + 1 }, (_value, index) => ({ page: index + 1, image: blobOf() })),
    })
    expect(capped[0]).toContain('1 more annotated pages')
  })

  it('reports an upload failure that is not an Error as its own text', async () => {
    const upload = { upload: async () => { throw 'the socket died' } } as unknown as FileUploadLike
    const warnings = await deliverAnnotation({
      ...delivery(),
      locale: 'en',
      fileUpload: upload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(warnings[0]).toBe('The annotated PDF was not attached: the socket died')
  })

  it('warns when the upload service refuses, and when it throws', async () => {
    const refused = stubUpload('refused')
    const first = await deliverAnnotation({
      ...delivery(),
      fileUpload: refused.fileUpload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(first[0]).toContain('未能随消息发送')
    const thrown = stubUpload('throws')
    const second = await deliverAnnotation({
      ...delivery(),
      fileUpload: thrown.fileUpload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(second[0]).toContain('upload transport failed')
  })

  it('does not attach a file to a subagent continuation, which refuses one', async () => {
    const upload = stubUpload()
    const stub = stubSessions(true)
    const warnings = await deliverAnnotation({
      ...delivery(),
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      document: pagedDocument,
      paths: pagedPaths,
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(upload.uploads).toEqual([])
    expect(warnings[0]).toContain('子会话')
  })

  it('names the attachment after the saved document when the save wrote no path', async () => {
    const upload = stubUpload()
    await deliverAnnotation({
      ...delivery(),
      fileUpload: upload.fileUpload,
      document: pagedDocument,
      paths: { annotationPath: '/w/report.pdf.annot.json', reviewPath: null },
      annotatedPdf: new Uint8Array([1]),
      pageImages: [],
    })
    expect(upload.uploads[0]?.name).toBe('report.pdf.annotated.pdf')
  })
})

describe('the message the agent reads', () => {
  it('names the pages a document has, and where its annotated copy is', () => {
    const zh = buildAnnotationMessage(pagedDocument, pagedPaths, 'zh')
    expect(zh).toContain('（共 12 页，其中 2 页有标注，标注 3 处')
    expect(zh).toContain('① 第 1 页 箭头 (1,1) → (2,2)：第一页')
    expect(zh).toContain('② 第 3 页 矩形 (3,3)-(4,4)')
    expect(zh).toContain('我的总体说明：标号要往左')
    const en = buildAnnotationMessage(pagedDocument, pagedPaths, 'en')
    expect(en).toContain('(12 pages, 2 pages marked, 3 marks')
    expect(en).toContain('page 3 rectangle')
    expect(en).toContain('annotated PDF: /w/report.pdf.annotated.pdf')
  })

  it('measures a single-surface figure instead of counting pages', () => {
    const zh = buildAnnotationMessage(document_, paths, 'zh')
    expect(zh).toContain('（图面 10×10，标注 1 处')
    expect(zh).toContain('① 箭头 (1,1) → (2,2)：指错了')
    expect(zh).not.toContain('带批注 PDF')
    expect(buildAnnotationMessage(document_, paths, 'en')).toContain('(figure 10x10, 1 marks')
  })

  it('leaves the overall note out when the user wrote none', () => {
    const withoutSummary: AnnotationDocument = { ...document_ }
    delete (withoutSummary as { summary?: string }).summary
    expect(buildAnnotationMessage(withoutSummary, paths, 'zh')).not.toContain('我的总体说明')
  })

  it('names a rendered document as one, with the locators that are its whole payload', () => {
    const zh = buildAnnotationMessage(htmlDocument, htmlPaths, 'zh')
    expect(zh).toContain('【HTML 标注】/w/report.html（渲染面 1024×1843，标注 1 处，文件 sha256:')
    expect(zh).toContain('标注文件：/w/report.html.annot.json')
    // Nothing was flattened: there is no annotated image to point at.
    expect(zh).not.toContain('标注图：')
    expect(zh).toContain('① 矩形 (10,20)-(60,90)（元素文字「第一段」，选择器 #s > p:nth-of-type(1)）：这段要改')
    // The closing tells the agent where the marks really live and what to change.
    expect(zh).toContain('这份 HTML 的生成源')
    expect(zh).toContain('anchor.selector')
    const en = buildAnnotationMessage(htmlDocument, htmlPaths, 'en')
    expect(en).toContain('[HTML annotations] /w/report.html (rendered surface 1024x1843, 1 marks')
    expect(en).toContain('annotation file: /w/report.html.annot.json')
    expect(en).toContain('selector #s > p:nth-of-type(1)')
    expect(en).toContain('the HTML source that generates this document')
  })
})

/** One line changed in a three-line document. */
function editedDiff(): ReturnType<typeof diffLines> {
  return diffLines('a\nb\nc', 'a\nB\nc')
}

/** A difference with more hunks than a message's budget holds. */
function wideDiff(): ReturnType<typeof diffLines> {
  const before = Array.from({ length: 400 }, (_, index) => `line ${index}`)
  const after = [...before]
  for (let index = 5; index < 400; index += 8) after[index] = `changed ${index}`
  return diffLines(before.join('\n'), after.join('\n'))
}

describe('fitting a difference into a message', () => {
  it('carries every hunk that fits', () => {
    const fitted = fitDiff('/w/docs/report.md', editedDiff())
    expect(fitted.hidden).toBe(0)
    expect(fitted.text).toContain('--- a/report.md')
    expect(fitted.text).toContain('+++ b/report.md')
    expect(fitted.text).toContain('-b')
    expect(fitted.text).toContain('+B')
    expect(MAX_DIFF_LINES).toBe(400)
  })

  it('keeps the first hunk however large it is', () => {
    const huge = diffLines('a', Array.from({ length: 500 }, (_, index) => `x${index}`).join('\n'))
    const fitted = fitDiff('/w/docs/report.md', huge, 3)
    expect(fitted.hidden).toBe(0)
    expect(fitted.text.split('\n').length).toBeGreaterThan(3)
  })

  it('drops trailing hunks once the budget is spent, and counts them', () => {
    const diff = wideDiff()
    const fitted = fitDiff('/w/docs/report.md', diff, 20)
    expect(diff.hunks.length).toBeGreaterThan(2)
    expect(fitted.hidden).toBeGreaterThan(0)
    // What it does carry is whole hunks: the text never stops mid-hunk.
    expect(fitted.text).toContain('@@')
  })

  it('writes the file header alone for a difference with no hunk', () => {
    const fitted = fitDiff('/w/docs/report.md', EMPTY_DIFF)
    expect(fitted.text).toBe('--- a/report.md\n+++ b/report.md')
    expect(fitted.hidden).toBe(0)
  })
})

describe('the edit message the agent reads', () => {
  it('names the document, its hunk count, and both line counts', () => {
    const diff = editedDiff()
    const fitted = fitDiff('/w/docs/report.md', diff)
    const zh = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'zh' })
    expect(zh).toContain('【文档修改建议】/w/docs/report.md（Markdown，改动 1 处，+1 −1 行）')
    expect(zh).toContain('```diff')
    expect(zh).toContain('-b')
    expect(zh).toContain('+B')
    expect(zh).toContain('没有落盘')
    const en = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'en' })
    expect(en).toContain('[document edits] /w/docs/report.md (Markdown, 1 hunks, +1 -1 lines)')
    expect(en).toContain('did **not** write them to disk')
  })

  it('warns that the loaded version moved while the reader was editing', () => {
    const diff = editedDiff()
    const fitted = fitDiff('/w/docs/report.md', diff)
    const zh = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: true, locale: 'zh' })
    expect(zh).toContain('文件在编辑期间被改动过')
    const en = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: true, locale: 'en' })
    expect(en).toContain('the file changed while it was being edited')
  })

  it('names the attachment when the message could not carry every hunk', () => {
    const diff = wideDiff()
    const fitted = fitDiff('/w/docs/report.md', diff, 20)
    const zh = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'zh' })
    expect(zh).toContain(`另有 ${fitted.hidden} 处改动未在本消息里展开`)
    expect(zh).toContain('report.md.edited.md')
    const en = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'en' })
    expect(en).toContain(`${fitted.hidden} more hunks are not expanded here`)
    expect(en).toContain('report.md.edited.md')
  })

  it('says a difference too large for the exact algorithm reads as one block', () => {
    const diff = { ...editedDiff(), coarse: true }
    const fitted = fitDiff('/w/docs/report.md', diff)
    expect(buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'zh' }))
      .toContain('diff 以整块替换呈现')
    expect(buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'en' }))
      .toContain('reads as one replacement block')
  })
})

describe('delivering an edit proposal', () => {
  it('queues the difference as text, and attaches nothing when it fits', async () => {
    const upload = stubUpload()
    const stub = stubSessions()
    const warnings = await deliverEdit({
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: editedDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })
    expect(warnings).toEqual([])
    expect(upload.uploads).toEqual([])
    expect(stub.modes).toEqual(['queue'])
    const parts = stub.prompts[0] ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    expect(parts[0]?.text).toContain('【文档修改建议】/w/docs/report.md')
  })

  it('attaches the edited text when the difference did not fit', async () => {
    const upload = stubUpload()
    const stub = stubSessions()
    const warnings = await deliverEdit({
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: wideDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })
    expect(warnings).toEqual([])
    expect(upload.uploads).toHaveLength(1)
    expect(upload.uploads[0]?.name).toBe('report.md.edited.md')
    expect(upload.uploads[0]?.bytes).toBe(6)
    const parts = stub.prompts[0] ?? []
    expect(parts[0]).toMatchObject({ type: 'file', attachment: { attachmentId: 'a'.repeat(64) } })
    expect(parts[1]?.type).toBe('text')
  })

  it('warns instead of failing when the composition has no upload service', async () => {
    const stub = stubSessions()
    const warnings = await deliverEdit({
      sessions: stub.sessions,
      fileUpload: undefined,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: wideDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: true,
      locale: 'en',
    })
    expect(warnings[0]).toBe('This composition has no upload service, so the edited copy was not attached.')
    expect(stub.prompts[0]?.[0]?.type).toBe('text')
  })

  it('does not attach a file to a subagent continuation, which refuses one', async () => {
    const upload = stubUpload()
    const stub = stubSessions(true)
    const warnings = await deliverEdit({
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: wideDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })
    expect(upload.uploads).toEqual([])
    expect(warnings[0]).toContain('子会话')
  })

  it('opens the session through the service when no live binding exists', async () => {
    const stub = stubSessions()
    await deliverEdit({
      sessions: stub.detached,
      fileUpload: undefined,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: editedDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })
    expect(stub.sources).toEqual(['dsh-annotator'])
    expect(stub.prompts).toHaveLength(1)
  })

  it('reports the reason the session refused the message', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false, error: { message: 'session is closed' } }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverEdit({
      sessions,
      fileUpload: undefined,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: editedDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })).rejects.toThrow('session is closed')
  })

  it('falls back to a plain message when the refusal carries no reason', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverEdit({
      sessions,
      fileUpload: undefined,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: editedDiff(),
      editedText: 'a\nB\nc\n',
      notes: {},
      stale: false,
      locale: 'zh',
    })).rejects.toThrow('the session refused the edit message')
  })
})

describe('the notes a reader attaches to a change', () => {
  it('pairs a note with the hunk that starts on its line', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    const lines = describeNotes(diff, { 1: '为什么这么改' }, 'zh')
    expect(lines).toEqual(['1. 第 1 行（@@ -1,3 +1,3 @@）：为什么这么改'])
    expect(describeNotes(diff, { 1: 'why' }, 'en')).toEqual(['1. line 1 (@@ -1,3 +1,3 @@): why'])
  })

  it('still carries a note whose change the reader has since dropped', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    expect(describeNotes(diff, { 99: '这一行也要看' }, 'zh')).toEqual(['1. 第 99 行：这一行也要看'])
    expect(describeNotes(diff, { 99: 'read this too' }, 'en')).toEqual(['1. line 99: read this too'])
  })

  it('skips notes the reader emptied and keeps the rest in line order', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    const lines = describeNotes(diff, { 3: '  ', 1: 'first', 2: 'second' }, 'zh')
    // Only the hunk's own baseline start line pairs with it; a note on any
    // other line travels with its line number alone.
    expect(lines).toEqual([
      '1. 第 1 行（@@ -1,3 +1,3 @@）：first',
      '2. 第 2 行：second',
    ])
    expect(describeNotes(diff, {}, 'zh')).toEqual([])
  })

  it('counts them in the message header and lists them under the diff', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    const fitted = fitDiff('/w/docs/report.md', diff)
    const zh = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: { 1: '参数要留空' }, stale: false, locale: 'zh' })
    expect(zh).toContain('改动 1 处，+1 −1 行，说明 1 条')
    expect(zh).toContain('我的说明：')
    expect(zh).toContain('1. 第 1 行（@@ -1,3 +1,3 @@）：参数要留空')
    const en = buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: { 1: 'leave it empty' }, stale: false, locale: 'en' })
    expect(en).toContain('1 hunks, +1 -1 lines, 1 notes')
    expect(en).toContain('My notes:')
    expect(en).toContain('1. line 1 (@@ -1,3 +1,3 @@): leave it empty')
    // No notes, no section: the message stays as short as it was.
    expect(buildEditMessage({ documentPath: '/w/docs/report.md', diff, fitted, notes: {}, stale: false, locale: 'zh' }))
      .not.toContain('我的说明')
  })

  it('carries the notes of every hunk into the delivery', async () => {
    const stub = stubSessions()
    const upload = stubUpload()
    await deliverEdit({
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      sessionId: 's1',
      documentPath: '/w/docs/report.md',
      diff: wideDiff(),
      editedText: 'a\nB\nc\n',
      notes: { 5: '这一处先别改' },
      stale: false,
      locale: 'zh',
    })
    const text = (stub.prompts[0] ?? []).find(part => part.type === 'text')?.text ?? ''
    expect(text).toContain('说明 1 条')
    expect(text).toContain('这一处先别改')
  })
})
