// @vitest-environment jsdom
/** The seat the entry half hands the PDF chunk: the document, its save, and its delivery. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPagedDocument, createDocumentSeat, type PagedAnnotationInput } from '../src/client/document-seat'
import type { FileUploadLike, SessionsLike } from '../src/client/session'
import { defined, stubRasterizer } from './dom'

/** One input document, as the body that owns the pages reports it. */
function input(overrides: Partial<PagedAnnotationInput> = {}): PagedAnnotationInput {
  return {
    figure: {
      address: 'dsh-resource://file/session/s1/report.pdf',
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'c'.repeat(64),
      pageCount: 4,
    },
    marks: [
      { id: 'm1', kind: 'rect', color: '#1971c2', points: [[10, 20], [60, 90]], page: 1 },
      { id: 'm3', kind: 'arrow', color: '#e03131', points: [[1, 2], [3, 4]], text: '第三页', page: 3 },
    ],
    summary: '整份文档的说明',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** One recorded fetch call. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** Install a fetch stub answering one read and one write. */
function stubFetch(answers: { readonly annotation?: unknown; readonly readError?: string } = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const respond = (body: unknown, status = 200): { readonly json: () => Promise<unknown>; readonly status: number } =>
      ({ json: async () => body, status })
    if (init?.method === 'POST') {
      return respond({ ok: true, annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' })
    }
    if (answers.readError !== undefined) return respond({ ok: false, error: answers.readError }, 404)
    return respond({
      ok: true,
      figure: { path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'c'.repeat(64) },
      annotation: answers.annotation ?? null,
    })
  }))
  return calls
}

/** A sessions service stub that records the message it was handed. */
function stubSessions(): { readonly sessions: SessionsLike; readonly prompts: unknown[][] } {
  const prompts: unknown[][] = []
  const face = { prompt: async (content: readonly unknown[]) => { prompts.push([...content]); return { ok: true } } }
  return {
    prompts,
    sessions: {
      scope: () => ({ live: true }),
      sessionOf: () => face,
      using: async (_id: string, _options: unknown, operation: (reference: unknown) => unknown) =>
        await Promise.resolve(operation({ ready: Promise.resolve({ session: face }) })),
    } as unknown as SessionsLike,
  }
}

/** One upload service stub. */
function stubUpload(): { readonly fileUpload: FileUploadLike; readonly uploads: string[] } {
  const uploads: string[] = []
  return {
    uploads,
    fileUpload: {
      upload: async (_sessionId, data, name) => {
        uploads.push(`${name}:${data.byteLength}`)
        return { ok: true, value: { file: { attachmentId: 'a'.repeat(64), name, bytes: data.byteLength } } }
      },
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the document one whole-document save writes', () => {
  it('carries the figure, every page of marks, and one timestamp pair', () => {
    const document_ = buildPagedDocument(input())
    expect(document_).toMatchObject({
      version: 1,
      figure: { path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'c'.repeat(64), pageCount: 4 },
      createdAt: '2026-01-01T00:00:00.000Z',
      summary: '整份文档的说明',
    })
    expect(document_.figure.width).toBeUndefined()
    expect(document_.marks.map(mark => mark.page)).toEqual([1, 3])
    expect(Number.isNaN(Date.parse(document_.updatedAt))).toBe(false)
  })

  it('stamps the save time as the creation time when the document is new', () => {
    const document_ = buildPagedDocument(input({ createdAt: null }))
    expect(Number.isNaN(Date.parse(document_.createdAt))).toBe(false)
    expect(document_.createdAt).toBe(document_.updatedAt)
  })

  it('drops an overall note the user only filled with blanks', () => {
    expect(buildPagedDocument(input({ summary: '   ' })).summary).toBeUndefined()
  })
})

describe('reading the document again', () => {
  it('asks the plugin route for the whole document', async () => {
    const calls = stubFetch()
    const seat = createDocumentSeat({ sessions: undefined, fileUpload: undefined, sessionId: 's1', locale: 'zh' })
    const loaded = await seat.load('dsh-resource://file/session/s1/report.pdf', new AbortController().signal)
    expect(loaded.path).toBe('/w/report.pdf')
    expect(loaded.annotation).toBeNull()
    expect(calls[0]?.url).toContain('/dsh-annotator/annotation?address=')
  })
})

describe('saving the document', () => {
  it('posts the whole document with its annotated copy', async () => {
    const calls = stubFetch()
    const seat = createDocumentSeat({ sessions: undefined, fileUpload: undefined, sessionId: 's1', locale: 'zh' })
    const saved = await seat.save('dsh-resource://file/session/s1/report.pdf', input(), new Uint8Array([0x25, 0x50]))
    expect(saved).toEqual({ annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' })
    const raw = calls[0]?.init?.body
    if (typeof raw !== 'string') throw new Error('the write carried no JSON body')
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(body['address']).toBe('dsh-resource://file/session/s1/report.pdf')
    expect(body['annotatedPdf']).toBe('JVA=')
    expect(body['annotation']).toMatchObject({ version: 1, figure: { pageCount: 4 } })
  })
})

describe('delivering the document', () => {
  it('sends the annotated copy, one picture per marked page, and the list of marks', async () => {
    stubFetch()
    stubRasterizer()
    const upload = stubUpload()
    const stub = stubSessions()
    const seat = createDocumentSeat({
      sessions: stub.sessions,
      fileUpload: upload.fileUpload,
      sessionId: 's1',
      locale: 'zh',
    })
    const pages = [
      { page: 1, dataUrl: 'data:image/png;base64,cGFnZTE=', width: 595, height: 842 },
      { page: 3, dataUrl: 'data:image/png;base64,cGFnZTM=', width: 595, height: 842 },
    ]
    const warnings = await seat.send(
      input(),
      { annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' },
      pages,
      new Uint8Array([0x25, 0x50]),
    )
    expect(warnings).toEqual([])
    expect(upload.uploads).toEqual(['report.pdf.annotated.pdf:2'])
    const parts = (stub.prompts[0] ?? []) as { readonly type: string; readonly name?: string; readonly text?: string }[]
    expect(parts.map(part => part.type)).toEqual(['file', 'image', 'image', 'text'])
    expect(parts[1]?.name).toBe('report.pdf.p1.annotated.png')
    expect(parts[2]?.name).toBe('report.pdf.p3.annotated.png')
    // The message names every page of every mark, and where the annotated copy is.
    expect(parts[3]?.text).toContain('① 第 1 页 矩形 (10,20)-(60,90)')
    expect(parts[3]?.text).toContain('② 第 3 页 箭头 (1,2) → (3,4)：第三页')
    expect(parts[3]?.text).toContain('带批注 PDF：/w/report.pdf.annotated.pdf')
  })

  it('refuses to deliver without a sessions service', async () => {
    const seat = createDocumentSeat({ sessions: undefined, fileUpload: undefined, sessionId: 's1', locale: 'zh' })
    await expect(seat.send(input(), { annotationPath: '/w/a.annot.json', reviewPath: null }, [], new Uint8Array([1])))
      .rejects.toThrow('the sessions service is unavailable')
  })

  it('delivers in English when the panel runs in an English locale', async () => {
    stubFetch()
    stubRasterizer()
    const stub = stubSessions()
    const seat = createDocumentSeat({ sessions: stub.sessions, fileUpload: undefined, sessionId: 's1', locale: 'en' })
    await seat.send(input(), { annotationPath: '/w/a.annot.json', reviewPath: null }, [], new Uint8Array([1]))
    const parts = (stub.prompts[0] ?? []) as { readonly text?: string }[]
    expect(defined(parts[0]).text).toContain('[figure annotations]')
  })
})
