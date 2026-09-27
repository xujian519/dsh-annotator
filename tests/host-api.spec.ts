/** The plugin's own routes as the browser calls them: guard header, encoding, failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationDocument } from '../src/shared/annotation'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import { AnnotatorHostError, loadAnnotation, saveAnnotation } from '../src/client/host-api'
import { defined } from './dom'

/** One call the stub fetch was handed. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

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
  marks: [{ id: 'm1', kind: 'arrow', color: '#e03131', points: [[1, 1], [2, 2]] }],
}

/** A response stub carrying one JSON body. */
function jsonResponse(body: unknown, status = 200): { readonly json: () => Promise<unknown>; readonly status: number } {
  return { json: async () => body, status }
}

/**
 * Install a fetch stub answering with one body.
 * @param body - the JSON body to answer with.
 * @param status - the status to report.
 * @returns the recorded calls.
 */
function stubFetch(body: unknown, status = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return jsonResponse(body, status)
  }))
  return calls
}

/** The parsed JSON body of one recorded call. */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  const raw = call?.init?.body
  if (typeof raw !== 'string') throw new Error('the call carried no JSON body')
  return JSON.parse(raw) as Record<string, unknown>
}

afterEach(() => { vi.unstubAllGlobals() })

describe('reading a saved annotation', () => {
  it('asks the guarded route with the address and reports what the host knows', async () => {
    const calls = stubFetch({
      ok: true,
      figure: { path: '/w/fig1.svg', mediaType: 'image/svg+xml', sha256: 'a'.repeat(64) },
      annotation: document_,
    })
    const signal = new AbortController().signal
    const loaded = await loadAnnotation('dsh-resource://file/session/s1/fig1.svg', signal)
    expect(loaded).toEqual({
      path: '/w/fig1.svg',
      mediaType: 'image/svg+xml',
      sha256: 'a'.repeat(64),
      annotation: document_,
    })
    expect(calls[0]?.url).toContain('/dsh-annotator/annotation?address=')
    expect(calls[0]?.url).toContain('dsh-resource%3A%2F%2Ffile%2Fsession%2Fs1%2Ffig1.svg')
    expect(calls[0]?.init?.headers).toEqual({ 'x-dsh-annotator': '1' })
    expect(calls[0]?.init?.signal).toBe(signal)
  })

  it('answers null when the figure was never annotated', async () => {
    stubFetch({ ok: true, figure: { path: '/w/a.svg', mediaType: 'image/svg+xml', sha256: 'a'.repeat(64) } })
    const loaded = await loadAnnotation('dsh-resource://file/session/s1/a.svg', new AbortController().signal)
    expect(loaded.annotation).toBeNull()
  })

  it('surfaces the host message when the host refuses the address', async () => {
    stubFetch({ ok: false, error: 'not an annotatable figure: /w/a.md' }, 404)
    await expect(loadAnnotation('dsh-resource://file/session/s1/a.md', new AbortController().signal))
      .rejects.toThrow('not an annotatable figure: /w/a.md')
  })

  it('reports the status when the host refuses without a message', async () => {
    stubFetch({ ok: false }, 500)
    const failure = loadAnnotation('dsh-resource://file/session/s1/a.svg', new AbortController().signal)
    await expect(failure).rejects.toBeInstanceOf(AnnotatorHostError)
    await expect(failure).rejects.toThrow('annotation read failed with status 500')
  })
})

describe('writing an annotation', () => {
  it('posts the document without an image part when the browser exported none', async () => {
    const calls = stubFetch({ ok: true, annotationPath: '/w/fig1.annot.json', annotatedImagePath: null })
    const saved = await saveAnnotation('dsh-resource://file/session/s1/fig1.svg', document_)
    expect(saved).toEqual({ annotationPath: '/w/fig1.annot.json', annotatedImagePath: null })
    const body = bodyOf(calls[0])
    expect(body['address']).toBe('dsh-resource://file/session/s1/fig1.svg')
    expect(body['annotation']).toEqual(document_)
    expect(body['reviewImage']).toBeUndefined()
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('encodes the flattened review image as base64 alongside the document', async () => {
    const calls = stubFetch({ ok: true, annotationPath: '/w/fig1.annot.json', annotatedImagePath: '/w/fig1.annotated.png' })
    const saved = await saveAnnotation(
      'dsh-resource://file/session/s1/fig1.svg',
      document_,
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    )
    expect(saved.annotatedImagePath).toBe('/w/fig1.annotated.png')
    expect(bodyOf(calls[0])['reviewImage']).toBe('AQID')
  })

  it('encodes an image larger than one base64 chunk', async () => {
    // The encoder walks the bytes in 32 KiB chunks; a single chunk would not exist.
    const bytes = new Uint8Array(0x8000 + 4).fill(7)
    const calls = stubFetch({ ok: true, annotationPath: '/w/fig1.annot.json' })
    await saveAnnotation('dsh-resource://file/session/s1/fig1.svg', document_, new Blob([bytes], { type: 'image/png' }))
    const encoded = bodyOf(calls[0])['reviewImage']
    expect(typeof encoded).toBe('string')
    expect(String(encoded).length).toBeGreaterThan(0x8000)
  })

  it('surfaces the host message when the write is refused', async () => {
    stubFetch({ ok: false, error: 'annotation document version 9 is not 1' }, 400)
    await expect(saveAnnotation('dsh-resource://file/session/s1/fig1.svg', document_))
      .rejects.toThrow('annotation document version 9 is not 1')
  })

  it('reports the status when the write is refused without a message', async () => {
    stubFetch({ ok: true }, 500)
    await expect(saveAnnotation('dsh-resource://file/session/s1/fig1.svg', document_))
      .rejects.toThrow('annotation save failed with status 500')
  })
})

describe('reading one page of a paged document', () => {
  it('names the page in the query, and leaves it out for a whole figure', async () => {
    const calls = stubFetch({
      ok: true,
      figure: { path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'c'.repeat(64) },
      annotation: null,
    })
    await loadAnnotation('dsh-resource://file/session/s1/report.pdf', new AbortController().signal, 3)
    expect(calls[0]?.url).toContain('page=3')
    await loadAnnotation('dsh-resource://file/session/s1/report.pdf', new AbortController().signal)
    expect(calls[1]?.url).not.toContain('page=')
  })

  it('round-trips an address that carries the characters a query would mangle', async () => {
    const calls = stubFetch({
      ok: true,
      figure: { path: '/w/fig+1.svg', mediaType: 'image/svg+xml', sha256: 'c'.repeat(64) },
      annotation: null,
    })
    const address = 'dsh-resource://file/session/s1/fig+1%20a.svg'
    const loaded = await loadAnnotation(address, new AbortController().signal)
    expect(loaded.path).toBe('/w/fig+1.svg')
    expect(new URL(defined(calls[0]?.url), 'http://localhost').searchParams.get('address')).toBe(address)
  })
})
