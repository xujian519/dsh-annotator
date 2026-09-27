/** Delivering an annotation into a session: the image part, the queue, and the failures. */
import { describe, expect, it } from 'vitest'
import type { AnnotationDocument } from '../src/shared/annotation'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import { deliverAnnotation, type SessionsLike } from '../src/client/session'

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

const paths = { annotationPath: '/w/fig1.annot.json', annotatedImagePath: '/w/fig1.annotated.png' }

/** One content part handed to the session. */
interface Part {
  readonly type: string
  readonly text?: string
  readonly mediaType?: string
  readonly data?: string
  readonly name?: string
}

/** A sessions service stub with one live session. */
function stubSessions(): {
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

describe('delivering an annotation', () => {
  it('queues one image part and one text part on the live session', async () => {
    const stub = stubSessions()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await deliverAnnotation(stub.sessions, 's1', document_, paths, blob, 'zh')
    expect(stub.modes).toEqual(['queue'])
    expect(stub.prompts).toHaveLength(1)
    const parts = stub.prompts[0] ?? []
    expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'fig1.svg.annotated.png' })
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.text).toContain('【附图标注】/w/fig1.svg')
    expect(parts[1]?.text).toContain('标注文件：/w/fig1.annot.json')
  })

  it('sends text alone when the browser could not export an image', async () => {
    const stub = stubSessions()
    await deliverAnnotation(stub.sessions, 's1', document_, paths, undefined, 'en')
    const parts = stub.prompts[0] ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    expect(parts[0]?.text).toContain('[figure annotations]')
  })

  it('encodes an image larger than one base64 chunk', async () => {
    const stub = stubSessions()
    const blob = new Blob([new Uint8Array(0x8000 + 3).fill(9)], { type: 'image/png' })
    await deliverAnnotation(stub.sessions, 's1', document_, paths, blob, 'zh')
    expect((stub.prompts[0]?.[0]?.data ?? '').length).toBeGreaterThan(0x8000)
  })

  it('opens the session through the service when no live binding exists', async () => {
    const stub = stubSessions()
    await deliverAnnotation(stub.detached, 's1', document_, paths, undefined, 'zh')
    expect(stub.sources).toEqual(['dsh-annotator'])
    expect(stub.prompts).toHaveLength(1)
  })

  it('names the annotation file when the review image was not written', async () => {
    const stub = stubSessions()
    await deliverAnnotation(
      stub.sessions,
      's1',
      document_,
      { annotationPath: '/w/fig1.annot.json', annotatedImagePath: null },
      undefined,
      'zh',
    )
    expect(stub.prompts[0]?.[0]?.text).not.toContain('标注图：')
  })

  it('reports the reason the session refused the message', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false, error: { message: 'session is closed' } }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverAnnotation(sessions, 's1', document_, paths, undefined, 'zh'))
      .rejects.toThrow('session is closed')
  })

  it('falls back to a plain message when the refusal carries no reason', async () => {
    const sessions = {
      scope: () => ({ live: true }),
      sessionOf: () => ({ prompt: async () => ({ ok: false }) }),
      using: async () => { throw new Error('unused') },
    } as unknown as SessionsLike
    await expect(deliverAnnotation(sessions, 's1', document_, paths, undefined, 'zh'))
      .rejects.toThrow('the session refused the annotation message')
  })
})
