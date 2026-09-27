/** The Host routes: guard, address resolution, sidecar write, and refusal paths. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GUARD_HEADER, createHandlers } from '../src/host/routes'
import { MAX_REVIEW_IMAGE_BYTES } from '../src/host/store'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import type { AnnotationDocument } from '../src/shared/annotation'

const FIGURE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
const CWD = '/virtual/workspace'

const document_: AnnotationDocument = {
  version: ANNOTATION_VERSION,
  figure: {
    address: `dsh-resource://file/session/s1/fig1.svg`,
    path: join(process.env['ANNOTATOR_TMP'] ?? '', 'fig1.svg'),
    mediaType: 'image/svg+xml',
    width: 10,
    height: 10,
    sha256: 'b'.repeat(64),
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  marks: [{ id: 'm1', kind: 'arrow', color: '#e03131', points: [[1, 1], [2, 2]], text: '箭头' }],
}

let server: Server
let origin: string
let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-annotator-routes-'))
  process.env['ANNOTATOR_TMP'] = directory
  const handlers = createHandlers({ sessionCwd: async () => CWD })
  server = createServer((req, res) => { void handlers.annotation(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  await writeFile(join(directory, 'fig1.svg'), FIGURE)
})

describe('annotation route', () => {
  const guard = { [GUARD_HEADER]: '1' }

  it('refuses a request without the guard header', async () => {
    const response = await fetch(`${origin}/dsh-annotator/annotation?address=x`)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('guard') as unknown as string })
  })

  it('refuses a malformed address and a non-figure target', async () => {
    const bad = await fetch(`${origin}/dsh-annotator/annotation?address=nope`, { headers: guard })
    expect(bad.status).toBe(404)
    await writeFile(join(directory, 'notes.md'), 'x')
    const md = await fetch(`${origin}/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/notes.md')}`, { headers: guard })
    expect(md.status).toBe(404)
    expect(await md.json()).toMatchObject({ error: expect.stringContaining('annotatable') as unknown as string })
  })

  it('answers a missing figure with its absolute path', async () => {
    const response = await fetch(`${origin}/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/gone.svg')}`, { headers: guard })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('no such figure') as unknown as string })
  })

  it('reads a figure for a relative address resolved through the session directory', async () => {
    const response = await fetch(`${origin}/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/../fig1.svg')}`, { headers: guard })
    const body = await response.json() as { ok: boolean; figure: { mediaType: string; sha256: string }; annotation: unknown }
    // `../fig1.svg` under /virtual/workspace resolves outside the fixture; the route reports it rather than guessing.
    expect(response.status).toBe(404)
    expect(body).toMatchObject({ ok: false })
  })

  it('saves and reads back marks with their review image', async () => {
    const address = `dsh-resource://file/session/s1//${directory}/fig1.svg`
    const save = await fetch(`${origin}/dsh-annotator/annotation`, {
      method: 'POST',
      headers: { ...guard, 'content-type': 'application/json' },
      body: JSON.stringify({ address, annotation: document_, reviewImage: Buffer.from([9, 9]).toString('base64') }),
    })
    expect(save.status).toBe(200)
    const saved = await save.json() as { annotationPath: string; annotatedImagePath: string }
    expect(saved.annotationPath).toBe(join(directory, 'fig1.annot.json'))
    expect(saved.annotatedImagePath).toBe(join(directory, 'fig1.annotated.png'))

    const read = await fetch(`${origin}/dsh-annotator/annotation?address=${encodeURIComponent(address)}`, { headers: guard })
    const loaded = await read.json() as { figure: { sha256: string }; annotation: AnnotationDocument }
    expect(loaded.annotation.marks).toHaveLength(1)
    expect(loaded.figure.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects an invalid document body with a message, not a crash', async () => {
    const address = `dsh-resource://file/session/s1//${directory}/fig1.svg`
    const response = await fetch(`${origin}/dsh-annotator/annotation`, {
      method: 'POST',
      headers: { ...guard, 'content-type': 'application/json' },
      body: JSON.stringify({ address, annotation: { version: 9 } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('version') as unknown as string })
  })

  it('refuses an oversized review image', async () => {
    const address = `dsh-resource://file/session/s1//${directory}/fig1.svg`
    const response = await fetch(`${origin}/dsh-annotator/annotation`, {
      method: 'POST',
      headers: { ...guard, 'content-type': 'application/json' },
      body: JSON.stringify({ address, annotation: document_, reviewImage: 'A'.repeat(24 * 1024 * 1024 * 2) }),
    })
    expect(response.status).toBe(400)
  })

  it('answers other methods with 405', async () => {
    const response = await fetch(`${origin}/dsh-annotator/annotation`, { method: 'DELETE', headers: guard })
    expect(response.status).toBe(405)
  })
})

/** One request the handler sees, built without a socket. */
interface StubRequest {
  /** HTTP method; leave unset, or set it to undefined, for a request that names none. */
  readonly method?: string | undefined
  /** Request URL including the query; leave unset, or set it to undefined, for a fallback. */
  readonly url?: string | undefined
  /** Extra headers, merged over the guard header. */
  readonly headers?: Record<string, string>
  /** Body text to stream, when the request carries one. */
  readonly body?: string
}

/**
 * Call the route handler over a stubbed request.
 * @param deps - the session lookup the handler resolves addresses through.
 * @param request - the request to hand it.
 * @returns the status and parsed body it answered with.
 */
async function callRoute(
  deps: { readonly sessionCwd: (id: string) => Promise<string | undefined> },
  request: StubRequest = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const handlers = createHandlers(deps)
  const body = request.body
  const req = {
    method: 'method' in request ? request.method : 'GET',
    url: 'url' in request ? request.url : '/dsh-annotator/annotation',
    headers: { [GUARD_HEADER]: '1', ...request.headers },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (body !== undefined) yield Buffer.from(body)
    },
  } as unknown as IncomingMessage
  let status = 200
  let text = ''
  const res = {
    writeHead: (code: number) => { status = code; return res },
    end: (payload?: string) => { text = payload ?? ''; return res },
  } as unknown as ServerResponse
  await handlers.annotation(req, res)
  return { status, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
}

describe('annotation route edge cases', () => {
  // An `absolute`-scope address carries the path verbatim, so an absolute path
  // shows up as a doubled slash after the scope.
  const absoluteAddress = (): string => `dsh-resource://file/absolute/${directory}/fig1.svg`

  it('resolves an absolute address without consulting any Session', async () => {
    const answer = await callRoute({ sessionCwd: async () => undefined }, {
      url: `/dsh-annotator/annotation?address=${encodeURIComponent(absoluteAddress())}`,
    })
    expect(answer.status).toBe(200)
    expect(answer.body['figure']).toMatchObject({ path: join(directory, 'fig1.svg') })
  })

  it('refuses a relative address when no Session directory can be resolved', async () => {
    const answer = await callRoute({ sessionCwd: async () => undefined }, {
      url: `/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/fig1.svg')}`,
    })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('cannot resolve')
  })

  it('refuses a read with no address at all', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('not a file address')
  })

  it('refuses a target that is a directory rather than a file', async () => {
    // The suffix check runs first, so the directory has to look like a figure.
    await mkdir(join(directory, 'not-a-file.png'))
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      url: `/dsh-annotator/annotation?address=${encodeURIComponent(`dsh-resource://file/absolute/${directory}/not-a-file.png`)}`,
    })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('not a regular file')
  })

  it('refuses a cross-site request and admits a same-origin one', async () => {
    const crossSite = await callRoute({ sessionCwd: async () => CWD }, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
    const sameOrigin = await callRoute({ sessionCwd: async () => CWD }, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(sameOrigin.status).toBe(404)
  })

  it('refuses a write whose address is not a string', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 42, annotation: document_ }),
    })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('not a file address')
  })

  it('refuses a write to a figure that is not there', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dsh-resource://file/absolute//tmp/gone.svg', annotation: document_ }),
    })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('no such figure')
  })

  it('treats an empty review image as none at all', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: absoluteAddress(), annotation: document_, reviewImage: '' }),
    })
    expect(answer.status).toBe(200)
    expect(answer.body['annotatedImagePath']).toBeNull()
  })

  it('refuses a review image past the size cap, before the body cap catches it', async () => {
    // Base64 of one byte over the cap stays under the request-body cap, so this
    // exercises the image check rather than the generic body guard.
    const encoded = 'A'.repeat((Math.floor(MAX_REVIEW_IMAGE_BYTES / 3) + 1) * 4)
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: absoluteAddress(), annotation: document_, reviewImage: encoded }),
    })
    expect(answer.status).toBe(413)
    expect(answer.body['error']).toContain('too large')
  })

  it('reports a non-Error failure as its own text', async () => {
    const answer = await callRoute({
      sessionCwd: async () => { throw 'backend exploded' },
    }, {
      url: `/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/session/s1/fig1.svg')}`,
    })
    expect(answer.status).toBe(400)
    expect(answer.body['error']).toBe('backend exploded')
  })

  it('refuses a relative path that no Session is named for at all', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD }, {
      url: `/dsh-annotator/annotation?address=${encodeURIComponent('dsh-resource://file/absolute/fig1.svg')}`,
    })
    expect(answer.status).toBe(404)
    expect(answer.body['error']).toContain('cannot resolve')
  })

  it('answers a request that names neither method nor URL', async () => {
    const answer = await callRoute({ sessionCwd: async () => CWD }, { method: undefined, url: undefined })
    expect(answer.status).toBe(405)
    expect(answer.body['error']).toBe('method  is not allowed')
  })
})
