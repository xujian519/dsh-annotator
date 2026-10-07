// @vitest-environment jsdom
/** The document body: figure loading, editing, zoom, and the two save paths. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationDocument, MarkAnchor } from '../src/shared/annotation'
import { ANNOTATION_VERSION } from '../src/shared/annotation'
import { AnnotatorBody, type AnnotatorBodyProps, type PageSurface, type SurfaceDraft } from '../src/client/AnnotatorBody'
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
  const found = maybeButton(host, label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found
}

/** The toolbar button with one label, when the body renders one at all. */
function maybeButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(element => element.textContent === label) as HTMLButtonElement | undefined
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
    for (let turn = 0; turn < 2; turn += 1) await Promise.resolve()
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

  it('names an anchor by whatever it says, and shows no label for one that says nothing', async () => {
    const anchored: AnnotationDocument = {
      ...saved,
      marks: [
        { id: 'm1', kind: 'rect', color: '#1971c2', points: [[1, 1], [9, 9]], anchor: { tag: 'p', text: '第二段', bbox: [0, 0, 5, 5], selector: '#s > p:nth-of-type(2)' } },
        { id: 'm2', kind: 'rect', color: '#1971c2', points: [[2, 2], [8, 8]], anchor: { tag: 'g', bbox: [0, 0, 5, 5] } },
      ],
    }
    mounted = await svgBody({ annotation: anchored })
    const entries = [...document.querySelectorAll('.da-mark-text')].map(element => element.textContent ?? '')
    // Text before path: the quote is what a reader recognizes, the selector is how
    // a source reader resolves it.
    expect(entries[0]).toContain(`${zh.anchor}: 第二段`)
    expect(entries[1]).not.toContain(zh.anchor)
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

  it('hands the owner the scrollport once, and takes it back when the body goes', async () => {
    // The owner writes the reader's saved scroll position onto whatever it is
    // handed, so being handed the stage again on every render would put that
    // position back over wherever the reader had scrolled to — the page jumps
    // while it is being annotated. The stage crosses once, and null on the way out.
    const owner: (HTMLElement | null)[] = []
    const result = await svgBody({}, { scrollportRef: (element) => { owner.push(element) } })
    mounted = result
    expect(owner).toHaveLength(1)
    expect(owner[0]?.className).toBe('da-stage')
    // A render of its own, and one the owner's own state asks for.
    await click(button(document.body, zh.annotate))
    await click(button(document.body, zh.toolPen))
    expect(owner).toHaveLength(1)
    await act(async () => { result.root.unmount() })
    expect(owner).toEqual([owner[0], null])
    mounted = undefined
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

describe('a page a renderer supplies', () => {
  const PAGE_ADDRESS = 'dsh-resource://file/session/s1/report.pdf'
  const PAGE_IMAGE = 'data:image/png;base64,cGFnZTI='

  /** One page of a document, as the renderer that owns it supplies it. */
  function pageSurface(): PageSurface {
    return { dataUrl: PAGE_IMAGE, width: 595, height: 842 }
  }

  it('annotates the supplied raster rather than the file bytes', async () => {
    const calls = stubFetch()
    mounted = await mountBody({ page: pageSurface(), resourceAddress: PAGE_ADDRESS })
    const image = defined(document.body.querySelector('img.da-figure'))
    expect(image.getAttribute('src')).toBe(PAGE_IMAGE)
    // The page's own units are the coordinate space, not the bitmap's pixels.
    expect(image.getAttribute('width')).toBe('595')
    expect(document.body.textContent).not.toContain(zh.loading)
    // A page body neither reads nor writes the sidecar: its owner does, once, for
    // the whole document — so it touches the host not at all.
    expect(calls).toEqual([])
  })

  it('takes the choice to annotate from its owner, and reports every change', async () => {
    const chosen: string[] = []
    stubFetch()
    mounted = await mountBody({
      page: pageSurface(),
      resourceAddress: PAGE_ADDRESS,
      mode: 'annotate',
      onModeChange: (next) => { chosen.push(next) },
    })
    expect(maybeButton(document.body, zh.annotate)?.getAttribute('aria-pressed')).toBe('true')
    await click(button(document.body, zh.view))
    expect(chosen).toEqual(['view'])
  })

  it('keeps its own choice when no owner supplies one', async () => {
    stubFetch()
    mounted = await mountBody({ page: pageSurface(), resourceAddress: PAGE_ADDRESS })
    await click(button(document.body, zh.annotate))
    expect(maybeButton(document.body, zh.annotate)?.getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves the document actions to the owner, which keeps every page', async () => {
    stubFetch()
    mounted = await mountBody({ page: pageSurface(), resourceAddress: PAGE_ADDRESS })
    expect(maybeButton(document.body, zh.save)).toBeUndefined()
    expect(maybeButton(document.body, zh.saveAndSend)).toBeUndefined()
    expect(maybeButton(document.body, zh.previousPage)).toBeUndefined()
    // Drawing stays: the surface and its tools are what a page body is for.
    expect(maybeButton(document.body, zh.annotate)).toBeDefined()
  })

  it('takes its overall note from the owner and reports every change', async () => {
    const changed: string[] = []
    stubFetch()
    mounted = await mountBody({
      page: pageSurface(),
      resourceAddress: PAGE_ADDRESS,
      summary: '整份文档的说明',
      onSummaryChange: (text) => { changed.push(text) },
    })
    await click(button(document.body, zh.annotate))
    const note = defined([...document.body.querySelectorAll('textarea')][1]) as HTMLTextAreaElement
    expect(note.value).toBe('整份文档的说明')
    await type(note, '改成这样')
    expect(changed).toEqual(['改成这样'])
  })

  it('seeds marks from the draft and reports every edit back', async () => {
    const drafts: SurfaceDraft[] = []
    stubFetch()
    mounted = await mountBody({
      page: pageSurface(),
      resourceAddress: PAGE_ADDRESS,
      draft: { marks: [{ id: 'd1', kind: 'rect', color: '#2f9e44', points: [[10, 10], [40, 40]] }] },
      onDraftChange: (draft) => { drafts.push(draft) },
    })
    await click(button(document.body, zh.annotate))
    await drawArrow(document.body)
    const last = defined(drafts[drafts.length - 1])
    expect(last.marks.map(mark => mark.id === 'd1' ? 'draft' : 'drawn')).toEqual(['draft', 'drawn'])
  })

  it('keeps its own note when no owner supplies one', async () => {
    stubFetch()
    mounted = await mountBody({ page: pageSurface(), resourceAddress: PAGE_ADDRESS })
    await click(button(document.body, zh.annotate))
    const note = defined([...document.body.querySelectorAll('textarea')][1]) as HTMLTextAreaElement
    await type(note, '自己写一句')
    expect(note.value).toBe('自己写一句')
  })
})

describe('a rendered document', () => {
  const HTML_ADDRESS = 'dsh-resource://file/session/s1/report.html'
  const HTML_PATH = '/w/report.html'
  const HTML = '<!doctype html><html><head><title>报告</title></head>'
    + '<body><section id="s"><p id="lead">第一段</p><p>第二段</p></section></body></html>'

  /** The document's own bytes. */
  function htmlBytes(): Uint8Array {
    return new TextEncoder().encode(HTML)
  }

  /** What the host answers a read of this document with. */
  function htmlPayload(answers: HostAnswers = {}): unknown {
    return {
      ok: true,
      figure: { path: HTML_PATH, mediaType: 'text/html', sha256: answers.sha256 ?? 'b'.repeat(64) },
      annotation: answers.annotation ?? null,
    }
  }

  /** A marks file for this document. */
  const savedHtml: AnnotationDocument = {
    version: ANNOTATION_VERSION,
    figure: {
      address: HTML_ADDRESS,
      path: HTML_PATH,
      mediaType: 'text/html',
      width: 1024,
      height: 1843,
      sha256: 'b'.repeat(64),
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    marks: [{ id: 'm1', kind: 'rect', color: '#e03131', points: [[10, 10], [80, 40]], text: '这段要改' }],
    summary: '改第二段',
  }

  /** Resize callbacks the frame body registered, so a spec can fire a layout pass. */
  const resizeCallbacks: (() => void)[] = []

  /** Mount a body over the rendered document. */
  async function htmlBody(answers: HostAnswers = {}, props: Partial<AnnotatorBodyProps> = {}): Promise<{
    readonly host: HTMLElement
    readonly root: Root
    readonly calls: Call[]
  }> {
    const calls: Call[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const respond = (body: unknown, status = 200): { readonly json: () => Promise<unknown>; readonly status: number } =>
        ({ json: async () => body, status })
      if (init?.method === 'POST') {
        if (answers.saveError !== undefined) return respond({ ok: false, error: answers.saveError }, 400)
        return respond({ ok: true, annotationPath: `${HTML_PATH}.annot.json`, reviewPath: null })
      }
      if (answers.readError !== undefined) return respond({ ok: false, error: answers.readError }, 404)
      return respond(htmlPayload(answers))
    }))
    const result = await mountBody({
      content: { kind: 'bytes', data: htmlBytes() },
      resourceAddress: HTML_ADDRESS,
      ...props,
    })
    return { ...result, calls }
  }

  /** The frame the body rendered the document into. */
  function frame(): HTMLIFrameElement {
    return defined(document.querySelector('iframe.da-html')) as HTMLIFrameElement
  }

  /** Report one content height for the frame, the way a layout pass would. */
  async function reportHeight(height: number): Promise<void> {
    const frameDocument = frame().contentDocument
    if (frameDocument === null) throw new Error('the frame has no document')
    Object.defineProperty(frameDocument.documentElement, 'scrollHeight', { configurable: true, get: () => height })
    await act(async () => {
      for (const callback of resizeCallbacks) callback()
    })
  }

  /** Draw one arrow on the document, in the frame's own pixels. */
  async function drawOnDocument(host: HTMLElement): Promise<void> {
    const overlay = defined(host.querySelector('svg.da-overlay')) as SVGSVGElement
    stubRect(overlay, { left: 0, top: 0, width: 1024, height: 1843 })
    for (const [type, x, y] of [['pointerdown', 10, 10], ['pointermove', 120, 80], ['pointerup', 120, 80]] as const) {
      await act(async () => {
        overlay.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
      })
    }
  }

  beforeEach(() => {
    resizeCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', class {
      /** @param callback - the observer's callback, kept so a spec can fire it. */
      constructor(callback: () => void) { resizeCallbacks.push(callback) }
      /** @param _target - the observed element; this double never fires on its own. */
      observe(_target: Element): void {}
      /** Stop observing. */
      disconnect(): void {}
    })
  })

  it('renders the document into a frame that cannot run and cannot reach out', async () => {
    mounted = await htmlBody()
    const element = frame()
    expect(element.getAttribute('sandbox')).toBe('allow-same-origin')
    const frameDocument = defined(element.contentDocument)
    expect(frameDocument.querySelector('#lead')?.textContent).toBe('第一段')
    expect(frameDocument.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull()
    // The frame is the surface: one fixed width, and whatever height it reports.
    expect(element.style.width).toBe('1024px')
    // Nothing has laid out yet, so there is no surface to describe.
    expect(element.style.height).toBe('0px')
    await reportHeight(1843)
    expect(element.style.height).toBe('1843px')
    expect(element.getAttribute('title')).toBe(zh.htmlFrame)
  })

  it('waits for bytes with the document wording rather than the figure wording', async () => {
    stubFetch()
    mounted = await mountBody({ content: { kind: 'text' }, resourceAddress: HTML_ADDRESS })
    expect(document.body.textContent).toContain(zh.htmlLoading)
    expect(document.body.textContent).not.toContain(zh.loading)
  })

  it('warns that the document moved on, in the wording a document takes', async () => {
    mounted = await htmlBody({ annotation: savedHtml, sha256: 'c'.repeat(64) })
    expect(document.body.textContent).toContain(zh.htmlStale)
    expect(document.body.textContent).not.toContain(zh.stale)
  })

  it('records what a mark on the document points at, and saves the marks file alone', async () => {
    const result = await htmlBody()
    mounted = result
    await reportHeight(1843)
    await click(button(document.body, zh.annotate))
    const frameDocument = defined(frame().contentDocument)
    stubRect(defined(frameDocument.querySelector('#s')), { left: 0, top: 0, width: 1024, height: 800 })
    stubRect(defined(frameDocument.querySelector('#lead')), { left: 0, top: 0, width: 1024, height: 200 })
    await drawOnDocument(document.body)
    expect(document.body.textContent).toContain(`${zh.anchor}: 第一段`)
    await click(button(document.body, zh.save))
    const post = result.calls.find(call => call.init?.method === 'POST')
    const body = postBody(post) as {
      reviewImage?: string
      annotatedPdf?: string
      annotation?: { figure: { mediaType: string; width: number; height: number }; marks: { anchor?: MarkAnchor }[] }
    }
    // A rendered document cannot be flattened into a picture, so the marks file is
    // the whole artifact and the locator inside it is what a source reader uses.
    expect(body.reviewImage).toBeUndefined()
    expect(body.annotatedPdf).toBeUndefined()
    expect(body.annotation?.figure).toMatchObject({ mediaType: 'text/html', width: 1024, height: 1843 })
    expect(body.annotation?.marks[0]?.anchor).toEqual({
      tag: 'p',
      id: 'lead',
      text: '第一段',
      // An element that names itself is named by its own id, which is the one
      // locator a reader of the source can resolve without counting siblings.
      selector: '#lead',
      bbox: [0, 0, 1024, 200],
    })
    expect(document.body.textContent).toContain(`${zh.saved}${HTML_PATH}.annot.json`)
  })

  it('sends the marks with no picture attached and the document wording in the message', async () => {
    const { sessions, prompts } = stubSessions()
    mounted = await htmlBody({ annotation: savedHtml }, { sessions })
    await reportHeight(1843)
    await click(button(document.body, zh.saveAndSend))
    expect(prompts).toHaveLength(1)
    const parts = defined(prompts[0]) as { readonly type: string; readonly text?: string }[]
    // The marks travel as the message's text; nothing is attached as an image.
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    expect(parts[0]?.text).toContain('【HTML 标注】')
    expect(parts[0]?.text).toContain('渲染面 1024×1843')
    expect(parts[0]?.text).toContain(`文件 sha256:${'b'.repeat(12)}`)
    expect(parts[0]?.text).toContain('anchor.selector')
  })

  it('refuses to save a surface the frame never gave a height to', async () => {
    const result = await htmlBody()
    mounted = result
    expect(frame().style.height).toBe('0px')
    await click(button(document.body, zh.annotate))
    await drawArrow(document.body)
    await click(button(document.body, zh.save))
    expect(result.calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it('keeps the last height when the frame reports none later', async () => {
    mounted = await htmlBody()
    await reportHeight(1843)
    expect(frame().style.height).toBe('1843px')
    // A frame that has laid out nothing reports no height; the surface must not
    // collapse under a reader who is drawing on it.
    await reportHeight(0)
    expect(frame().style.height).toBe('1843px')
  })

  it('renders the frame without a document rather than failing', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', { configurable: true, value: null })
    try {
      const result = await htmlBody()
      mounted = result
      expect(frame()).not.toBeNull()
      expect(document.body.textContent).not.toContain(zh.loading)
      await click(button(document.body, zh.annotate))
      await drawArrow(document.body)
      expect(document.body.textContent).toContain(zh.emptyText)
    } finally {
      if (original !== undefined) Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', original)
    }
  })
})
