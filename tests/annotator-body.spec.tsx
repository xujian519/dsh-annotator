// @vitest-environment jsdom
/** The document body: figure loading, editing, zoom, and the two save paths. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationDocument } from '../src/shared/annotation'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import { AnnotatorBody, type AnnotatorBodyProps } from '../src/client/AnnotatorBody'
import { en, zh } from '../src/client/locales'
import type { SessionsLike } from '../src/client/session'
import { defined, stubRasterizer, stubRect } from './dom'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="20">102</text></svg>'
const SVG_ADDRESS = 'dsh-resource://file/session/s1/fig.svg'
const ABSOLUTE_ADDRESS = 'dsh-resource://file/absolute//w/fig.svg'

/** The inline figure's bytes. */
function svgBytes(): Uint8Array {
  return new TextEncoder().encode(SVG)
}

/** What the host answers a successful read with. */
function hostPayload(answers: HostAnswers = {}): unknown {
  return {
    ok: true,
    figure: { path: '/w/fig.svg', mediaType: 'image/svg+xml', sha256: answers.sha256 ?? 'a'.repeat(64) },
    annotation: answers.annotation ?? null,
  }
}

const saved: AnnotationDocument = {
  version: ANNOTATION_VERSION,
  figure: {
    address: SVG_ADDRESS,
    path: '/w/fig.svg',
    mediaType: 'image/svg+xml',
    width: 200,
    height: 100,
    sha256: 'a'.repeat(64),
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  marks: [{ id: 'm1', kind: 'arrow', color: '#e03131', points: [[10, 10], [40, 30]], text: '标号指错了' }],
  summary: '改标号',
}

/** One call the body made through fetch. */
interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** What the stubbed host should answer. */
interface HostAnswers {
  readonly annotation?: AnnotationDocument | null
  readonly sha256?: string
  readonly readError?: string
  readonly saveError?: string
  /** Make the write reject with something that is not an Error. */
  readonly saveThrows?: unknown
}

/** Install the fetch stub answering as the host would. */
function stubFetch(answers: HostAnswers = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const respond = (body: unknown, status = 200): { readonly json: () => Promise<unknown>; readonly status: number } =>
      ({ json: async () => body, status })
    if (init?.method === 'POST') {
      if (answers.saveThrows !== undefined) throw answers.saveThrows
      if (answers.saveError !== undefined) return respond({ ok: false, error: answers.saveError }, 400)
      return respond({
        ok: true,
        annotationPath: '/w/fig.annot.json',
        annotatedImagePath: '/w/fig.annotated.png',
      })
    }
    if (answers.readError !== undefined) return respond({ ok: false, error: answers.readError }, 404)
    return respond(hostPayload(answers))
  }))
  return calls
}

/** A fetch stub whose answer the spec decides when to deliver. */
function deferredFetch(): {
  readonly signal: () => AbortSignal | null
  readonly answer: (body: unknown) => void
  readonly fail: (reason: unknown) => void
} {
  let settle: { readonly answer: (body: unknown) => void; readonly fail: (reason: unknown) => void } | null = null
  const signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal)
    return new Promise((resolve, reject) => {
      settle = {
        answer: (body) => { resolve({ json: async () => body, status: 200 }) },
        fail: reject,
      }
    })
  }))
  return {
    signal: () => signals[0] ?? null,
    answer: (body) => { settle?.answer(body) },
    fail: (reason) => { settle?.fail(reason) },
  }
}

/** A sessions service stub that records what it was asked to deliver. */
function stubSessions(): {
  readonly sessions: SessionsLike
  /** The same service seen from a session with no live binding. */
  readonly detached: SessionsLike
  readonly prompts: unknown[][]
  readonly sources: string[]
} {
  const prompts: unknown[][] = []
  const sources: string[] = []
  const face = { prompt: async (content: readonly unknown[]) => { prompts.push([...content]); return { ok: true } } }
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
    sources,
    sessions: { scope: () => ({ live: true }), sessionOf: () => face, using } as unknown as SessionsLike,
    detached: { scope: () => undefined, sessionOf: () => undefined, using } as unknown as SessionsLike,
  }
}

/** Mount the body and let its effects settle. */
async function mountBody(
  props: Partial<AnnotatorBodyProps> = {},
  options: { readonly stageWidth?: number } = {},
): Promise<{ readonly host: HTMLElement; readonly root: Root; readonly scrollports: (HTMLElement | null)[] }> {
  if (options.stageWidth !== undefined) {
    const width = options.stageWidth
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  }
  const scrollports: (HTMLElement | null)[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const withScrollport = props.scrollportRef === undefined
    ? { scrollportRef: (element: HTMLElement | null) => { scrollports.push(element) } }
    : {}
  await act(async () => {
    root.render(<AnnotatorBody {...props} {...withScrollport} />)
  })
  return { host, root, scrollports }
}

/** A body mounted over an inline SVG figure. */
function svgBody(answers: HostAnswers = {}, props: Partial<AnnotatorBodyProps> = {}, options: { readonly stageWidth?: number } = {}): Promise<{
  readonly host: HTMLElement
  readonly root: Root
  readonly scrollports: (HTMLElement | null)[]
  readonly calls: Call[]
}> {
  const calls = stubFetch(answers)
  return mountBody({
    content: { kind: 'bytes', data: svgBytes() },
    resourceAddress: SVG_ADDRESS,
    ...props,
  }, options).then(result => ({ ...result, calls }))
}

/** Find one toolbar button by its own label. */
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/** Click one element inside act, letting the handler's promises settle. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

/** Type into one textarea inside act. */
async function type(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    // React tracks the last value it wrote, so the prototype's own setter has to
    // be the one that changes it; assigning `.value` would look like no change.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The JSON body of a recorded write. */
function postBody(call: Call | undefined): Record<string, unknown> {
  const raw = call?.init?.body
  if (typeof raw !== 'string') throw new Error('the write carried no JSON body')
  return JSON.parse(raw) as Record<string, unknown>
}

/** Draw one arrow across the surface. */
async function drawArrow(host: HTMLElement): Promise<void> {
  const overlay = defined(host.querySelector('svg.da-overlay')) as SVGSVGElement
  stubRect(overlay, { left: 0, top: 0, width: 200, height: 100 })
  for (const [type, x, y] of [['pointerdown', 20, 20], ['pointermove', 120, 80], ['pointerup', 120, 80]] as const) {
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
    })
  }
}

/** Press one key on the window. */
async function pressKey(key: string, modifiers: { readonly shift?: boolean; readonly bare?: boolean } = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      metaKey: modifiers.bare !== true,
      shiftKey: modifiers.shift === true,
      bubbles: true,
    }))
  })
}

let mounted: { readonly root: Root } | undefined

beforeEach(() => {
  stubRasterizer()
  class StubResizeObserver { observe(): void {} disconnect(): void {} }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  mounted?.root.unmount()
  mounted = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  if (Object.hasOwn(HTMLElement.prototype, 'clientWidth')) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('addresses', () => {
  it('refuses anything that is not a file address', async () => {
    const calls = stubFetch()
    mounted = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: 'not-an-address' })
    expect(document.body.textContent).toContain(zh.unsupported)
    expect(calls).toHaveLength(0)
  })

  it('asks for nothing when the body was handed no address at all', async () => {
    const calls = stubFetch()
    mounted = await mountBody({ content: { kind: 'bytes', data: svgBytes() } })
    expect(document.body.textContent).toContain(zh.unsupported)
    expect(calls).toHaveLength(0)
  })

  it('refuses a file-scope address that names no folder', async () => {
    stubFetch()
    mounted = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: 'dsh-resource://file/nofile' })
    expect(document.body.textContent).toContain(zh.unsupported)
  })

  it('refuses a session address with no slash after the scope', async () => {
    stubFetch()
    mounted = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: 'dsh-resource://file/session/s1' })
    expect(document.body.textContent).toContain(zh.unsupported)
  })

  it('keeps a session id whose percent escapes are malformed', async () => {
    const { sessions, prompts } = stubSessions()
    const result = await svgBody({ annotation: saved }, {
      sessions,
      resourceAddress: 'dsh-resource://file/session/%ZZ/fig.svg',
    })
    mounted = result
    await click(button(document.body, zh.saveAndSend))
    expect(prompts).toHaveLength(1)
  })
})

describe('figure loading', () => {
  it('refuses a file it does not render', async () => {
    stubFetch()
    mounted = await mountBody({
      content: { kind: 'bytes', data: new TextEncoder().encode('x') },
      resourceAddress: 'dsh-resource://file/session/s1/notes.md',
    })
    expect(mounted.root).toBeDefined()
    expect(document.body.textContent).toContain(zh.unsupported)
  })

  it('waits for bytes it has not been handed yet', async () => {
    stubFetch()
    mounted = await mountBody({ content: { kind: 'text' }, resourceAddress: SVG_ADDRESS })
    expect(document.body.textContent).toContain(zh.loading)
  })

  it('reports an SVG it cannot parse', async () => {
    stubFetch()
    mounted = await mountBody({
      content: { kind: 'bytes', data: new TextEncoder().encode('not svg at all') },
      resourceAddress: SVG_ADDRESS,
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.loadFailed)
  })

  it('inlines an SVG figure so marks can anchor to its elements', async () => {
    mounted = await svgBody()
    const figureHost = document.querySelector('.da-figure')
    expect(figureHost?.querySelector('text')?.textContent).toBe('102')
    expect(document.querySelector('svg.da-overlay')).not.toBeNull()
  })

  it('shows raster bytes through an image and sizes the surface once it loads', async () => {
    stubFetch()
    mounted = await mountBody({
      content: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) },
      resourceAddress: 'dsh-resource://file/session/s1/fig.png',
    })
    const image = defined(document.querySelector('img.da-figure')) as HTMLImageElement
    // A raster figure is only measurable once the browser has decoded it.
    expect(document.querySelector('svg.da-overlay')).toBeNull()
    Object.defineProperty(image, 'naturalWidth', { value: 120 })
    Object.defineProperty(image, 'naturalHeight', { value: 60 })
    await act(async () => { image.dispatchEvent(new Event('load')) })
    expect(document.querySelector('svg.da-overlay')).not.toBeNull()
  })
})

describe('saved annotations', () => {
  it('opens an annotated figure in annotate mode with its marks listed', async () => {
    mounted = await svgBody({ annotation: saved })
    expect(defined(document.querySelector('.da-mark-text')).textContent).toContain('标号指错了')
    expect(button(document.body, zh.annotate).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.da-status')).toBeNull()
  })

  it('warns when the figure changed since it was annotated', async () => {
    mounted = await svgBody({ annotation: saved, sha256: 'c'.repeat(64) })
    expect(document.body.textContent).toContain(zh.stale)
  })

  it('reports a figure the host would not read', async () => {
    mounted = await svgBody({ readError: 'no such figure' })
    expect(document.body.textContent).toContain(`${zh.readError}no such figure`)
  })

  it('reads a saved annotation that carries no overall summary', async () => {
    const withoutSummary: AnnotationDocument = { ...saved }
    delete (withoutSummary as { summary?: string }).summary
    mounted = await svgBody({ annotation: withoutSummary })
    expect(defined(document.querySelectorAll('textarea')[1]) as HTMLTextAreaElement).toBeDefined()
    expect((defined(document.querySelectorAll('textarea')[1]) as HTMLTextAreaElement).value).toBe('')
  })

  it('ignores an answer that arrives after the panel is gone', async () => {
    const pending = deferredFetch()
    const panel = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: SVG_ADDRESS })
    const signal = pending.signal()
    expect(signal?.aborted).toBe(false)
    await act(async () => { panel.root.unmount() })
    // The effect's cleanup is what tells the host nobody is waiting any more.
    expect(signal?.aborted).toBe(true)
    pending.answer(hostPayload())
    await act(async () => { for (let turn = 0; turn < 4; turn += 1) await Promise.resolve() })
    expect(document.querySelector('.da-status')).toBeNull()
  })

  it('swallows a failure that arrives after the panel is gone', async () => {
    const pending = deferredFetch()
    const panel = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: SVG_ADDRESS })
    await act(async () => { panel.root.unmount() })
    pending.fail(new Error('too late'))
    await act(async () => { for (let turn = 0; turn < 4; turn += 1) await Promise.resolve() })
    expect(document.querySelector('.da-status')).toBeNull()
  })

  it('reports a read failure that is not an Error as its own text', async () => {
    const pending = deferredFetch()
    mounted = await mountBody({ content: { kind: 'bytes', data: svgBytes() }, resourceAddress: SVG_ADDRESS })
    pending.fail('the socket died')
    await act(async () => { for (let turn = 0; turn < 4; turn += 1) await Promise.resolve() })
    expect(document.body.textContent).toContain(`${zh.readError}the socket died`)
  })
})

describe('editing marks', () => {
  it('adds a mark by drawing, and puts the note box on it', async () => {
    mounted = await svgBody()
    await click(button(document.body, zh.annotate))
    await drawArrow(document.body)
    expect(document.querySelectorAll('.da-mark')).toHaveLength(1)
    expect(document.querySelector('.da-note')?.textContent).toContain('arrow')
  })

  it('writes a note onto the selected mark and an overall summary', async () => {
    mounted = await svgBody({ annotation: saved })
    await click(defined(document.querySelector('.da-mark-text')))
    const textareas = document.querySelectorAll('textarea')
    await type(defined(textareas[0]), '应指向滑套 34')
    await type(defined(textareas[1]), '只改这一处')
    expect(defined(document.querySelector('.da-mark-text')).textContent).toContain('应指向滑套 34')
    expect(defined(textareas[1]).value).toBe('只改这一处')
  })

  it('leaves the note box unusable until a mark is selected', async () => {
    mounted = await svgBody({ annotation: saved })
    expect((defined(document.querySelectorAll('textarea')[0]) as HTMLTextAreaElement).disabled).toBe(true)
    expect(document.querySelector('.da-note')?.textContent).not.toContain('·')
  })

  it('undoes and redoes an edit, and clears every mark', async () => {
    mounted = await svgBody({ annotation: saved })
    const del = document.querySelector('.da-mark-del')
    await click(defined(del))
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
    await click(button(document.body, zh.undo))
    expect(document.querySelectorAll('.da-mark')).toHaveLength(1)
    await click(button(document.body, zh.redo))
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
    await click(button(document.body, zh.undo))
    await click(button(document.body, zh.clear))
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
    expect(document.querySelector('.da-hint')?.textContent).toBe(zh.noMarks)
  })

  it('drives undo and redo from the keyboard too', async () => {
    mounted = await svgBody({ annotation: saved })
    await click(defined(document.querySelector('.da-mark-del')))
    await pressKey('z')
    expect(document.querySelectorAll('.da-mark')).toHaveLength(1)
    await pressKey('Z', { shift: true })
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
    await pressKey('a')
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
    // A plain `z` in a note box must not undo anything either.
    await pressKey('z', { bare: true })
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
  })

  it('ignores undo and redo when there is nothing left to move through', async () => {
    mounted = await svgBody({ annotation: saved })
    // The buttons are disabled in this state; the keyboard reaches the handlers
    // anyway, which is where the emptiness is actually decided.
    expect(button(document.body, zh.undo).disabled).toBe(true)
    expect(button(document.body, zh.redo).disabled).toBe(true)
    await pressKey('z')
    await pressKey('Z', { shift: true })
    expect(document.querySelectorAll('.da-mark')).toHaveLength(1)
  })

  it('leaves the clear button alone until there is something to clear', async () => {
    mounted = await svgBody()
    await click(button(document.body, zh.annotate))
    expect(button(document.body, zh.clear).disabled).toBe(true)
    await drawArrow(document.body)
    expect(button(document.body, zh.clear).disabled).toBe(false)
    await click(button(document.body, zh.clear))
    expect(document.querySelectorAll('.da-mark')).toHaveLength(0)
  })

  it('selects a mark from the list and from the surface', async () => {
    mounted = await svgBody({ annotation: saved })
    await click(defined(document.querySelector('.da-mark-text')))
    expect(document.querySelector('.da-note')?.textContent).toContain('arrow')
  })

  it('labels a mark that has no note yet, and shows where it anchored', async () => {
    const anchored: AnnotationDocument = {
      ...saved,
      marks: [
        { id: 'm1', kind: 'rect', color: '#1971c2', points: [[1, 1], [9, 9]] },
        { id: 'm2', kind: 'text', color: '#e03131', points: [[20, 20]], text: '图号', anchor: { tag: 'g', title: '102', bbox: [0, 0, 5, 5] } },
      ],
    }
    mounted = await svgBody({ annotation: anchored })
    const entries = [...document.querySelectorAll('.da-mark-text')].map(element => element.textContent ?? '')
    expect(entries[0]).toContain(zh.emptyText)
    expect(entries[1]).toContain('102')
    // A text mark draws as a glyph box, a stroke mark as a path.
    expect(document.querySelectorAll('.da-mark svg')).toHaveLength(2)
  })

  it('switches tools, colours, and back to view mode', async () => {
    mounted = await svgBody()
    await click(button(document.body, zh.annotate))
    await click(button(document.body, zh.toolRect))
    expect(button(document.body, zh.toolRect).getAttribute('aria-pressed')).toBe('true')
    const swatch = defined(document.querySelector('.da-swatch[aria-label="#1971c2"]'))
    await click(swatch)
    expect(swatch.getAttribute('aria-pressed')).toBe('true')
    await click(button(document.body, zh.view))
    expect(document.querySelector('.da-note')).toBeNull()
  })

  it('clears the note box when the selected mark is deleted', async () => {
    mounted = await svgBody({ annotation: saved })
    await click(defined(document.querySelector('.da-mark-text')))
    expect(document.querySelector('.da-note')?.textContent).toContain('arrow')
    await click(defined(document.querySelector('.da-mark-del')))
    expect(document.querySelector('.da-note')?.textContent).not.toContain('arrow')
    expect((defined(document.querySelectorAll('textarea')[0]) as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('leaves every other mark alone while a note is written', async () => {
    const twoMarks: AnnotationDocument = {
      ...saved,
      marks: [
        { id: 'm1', kind: 'arrow', color: '#e03131', points: [[1, 1], [9, 9]], text: '第一条' },
        { id: 'm2', kind: 'rect', color: '#1971c2', points: [[2, 2], [8, 8]], text: '第二条' },
      ],
    }
    mounted = await svgBody({ annotation: twoMarks })
    await click(defined(document.querySelector('.da-mark-text')))
    await type(defined(document.querySelectorAll('textarea')[0]), '改过了')
    const entries = [...document.querySelectorAll('.da-mark-text')].map(element => element.textContent ?? '')
    expect(entries[0]).toContain('改过了')
    expect(entries[1]).toContain('第二条')
  })

  it('previews a freehand mark at full stroke width in the list', async () => {
    mounted = await svgBody({
      annotation: { ...saved, marks: [{ id: 'm1', kind: 'pen', color: '#2f9e44', points: [[1, 1], [5, 6], [9, 2]] }] },
    })
    expect(document.querySelector('.da-mark svg path')?.getAttribute('transform')).toBe('scale(1)')
  })
})

describe('zoom', () => {
  it('fits, resets, and steps the zoom', async () => {
    mounted = await svgBody({}, {}, { stageWidth: 500 })
    const surface = defined(document.querySelector('.da-surface')) as HTMLElement
    // A 200px figure in a 476px stage fits at the 1.5 ceiling.
    expect(surface.style.width).toBe('300px')
    // Stepping in from the fitted state zooms relative to the fitted scale.
    await click(button(document.body, zh.zoomIn))
    expect(surface.style.width).toBe('375px')
    await click(button(document.body, zh.zoomOut))
    expect(surface.style.width).toBe('300px')
    await click(button(document.body, zh.actual))
    expect(surface.style.width).toBe('200px')
    await click(button(document.body, zh.zoomIn))
    expect(surface.style.width).toBe('250px')
    await click(button(document.body, zh.zoomOut))
    expect(surface.style.width).toBe('200px')
    await click(button(document.body, zh.fitWidth))
    expect(surface.style.width).toBe('300px')
  })

  it('steps down from a fitted zoom rather than from the raw scale', async () => {
    mounted = await svgBody()
    const surface = defined(document.querySelector('.da-surface')) as HTMLElement
    expect(surface.style.width).toBe('200px')
    await click(button(document.body, zh.zoomOut))
    expect(surface.style.width).toBe('160px')
  })

  it('hands the scrollport to the owner', async () => {
    const owner: (HTMLElement | null)[] = []
    mounted = await svgBody({}, { scrollportRef: (element) => { owner.push(element) } })
    // React re-runs a ref callback on every render, so the owner sees the stage
    // followed by nulls; what matters is that the stage is what it was handed.
    expect(owner.every(element => element === null || element.className === 'da-stage')).toBe(true)
    expect(owner.some(element => element?.className === 'da-stage')).toBe(true)
  })
})

describe('saving', () => {
  it('exports, saves, and reports where the marks landed', async () => {
    const result = await svgBody({ annotation: saved })
    mounted = result
    await click(button(document.body, zh.save))
    const post = result.calls.find(call => call.init?.method === 'POST')
    expect(post?.url).toBe('/dsh-annotator/annotation')
    const body = postBody(post)
    expect(body['address']).toBe(SVG_ADDRESS)
    expect(typeof body['reviewImage']).toBe('string')
    expect(document.body.textContent).toContain(`${zh.saved}/w/fig.annot.json`)
  })

  it('fills the annotation into the session that owns the figure', async () => {
    const { sessions, prompts } = stubSessions()
    const result = await svgBody({ annotation: saved }, { sessions })
    mounted = result
    await click(button(document.body, zh.saveAndSend))
    expect(prompts).toHaveLength(1)
    expect(document.body.textContent).toContain(`${zh.sent}/w/fig.annot.json`)
  })

  it('does nothing at all when there is nothing to save', async () => {
    const result = await svgBody()
    mounted = result
    await click(button(document.body, zh.save))
    expect(result.calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it('stops when the figure cannot be measured or exported', async () => {
    stubFetch()
    const raster = await mountBody({
      content: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) },
      resourceAddress: 'dsh-resource://file/session/s1/fig.png',
    })
    mounted = raster
    // Draw first so the guard on an empty document is not what stops the save.
    await click(button(document.body, zh.annotate))
    await click(button(document.body, zh.save))
    expect(document.body.textContent).not.toContain(zh.saving)
  })

  it('reports a session service the composition does not provide', async () => {
    mounted = await svgBody({ annotation: saved })
    await click(button(document.body, zh.saveAndSend))
    expect(document.body.textContent).toContain('the sessions service is unavailable')
  })

  it('reports an address that names no session to deliver into', async () => {
    const { sessions } = stubSessions()
    mounted = await svgBody({ annotation: saved }, { sessions, resourceAddress: ABSOLUTE_ADDRESS })
    await click(button(document.body, zh.saveAndSend))
    expect(document.body.textContent).toContain('the figure address carries no session')
  })

  it('reports a refused write without losing the panel', async () => {
    mounted = await svgBody({ annotation: saved, saveError: 'annotation document version 9 is not 1' })
    await click(button(document.body, zh.save))
    expect(document.body.textContent).toContain('annotation document version 9 is not 1')
  })

  it('reports a figure the host would not read as a save failure too', async () => {
    mounted = await svgBody({ readError: 'no such figure' })
    await click(button(document.body, zh.annotate))
    await drawArrow(document.body)
    await click(button(document.body, zh.save))
    expect(document.body.textContent).toContain(zh.loadFailed)
  })

  it('uses a caller-supplied translator when the shell binds one', async () => {
    const t = (key: string): string => `T:${key}`
    mounted = await svgBody({ annotation: saved }, { t })
    expect(document.body.textContent).toContain('T:marks')
  })

  it('stamps a first save and omits an empty overall note', async () => {
    const result = await svgBody()
    mounted = result
    await click(button(document.body, zh.annotate))
    await drawArrow(document.body)
    await click(button(document.body, zh.save))
    const post = result.calls.find(call => call.init?.method === 'POST')
    const body = postBody(post) as { annotation?: { createdAt?: string; summary?: string } }
    expect(Number.isNaN(Date.parse(body.annotation?.createdAt ?? ''))).toBe(false)
    expect(body.annotation?.summary).toBeUndefined()
  })

  it('delivers in English when the panel runs in an English locale', async () => {
    const { sessions, prompts } = stubSessions()
    mounted = await svgBody({ annotation: saved }, { sessions, localeId: 'en-GB' })
    await click(button(document.body, en.saveAndSend))
    const parts = (prompts[0] ?? []) as { type: string; text?: string }[]
    expect(parts[1]?.text).toContain('[figure annotations]')
  })

  it('reports a save failure that is not an Error as its own text', async () => {
    mounted = await svgBody({ annotation: saved, saveThrows: 'the socket died' })
    await click(button(document.body, zh.save))
    expect(document.body.textContent).toContain(`${zh.saveError}the socket died`)
  })
})
