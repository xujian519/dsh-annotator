// @vitest-environment jsdom
/** The PDF body: opening the document, one page at a time, and one save for all of it. */
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationDocument, AnnotationMark } from '../src/shared/annotation'
import type { AnnotatorBodyProps } from '../src/client/AnnotatorBody'
import type { DocumentSeat, PagedAnnotationInput, PageImage } from '../src/client/document-seat'
import type { PdfBodyProps } from '../src/client/pdf/PdfBody'
import { PdfBody } from '../src/client/pdf/pdf'
import { zh } from '../src/client/locales'
import { defined } from './dom'

/** What the runtime double answers, per spec. */
const runtime = vi.hoisted(() => ({
  pages: 3,
  size: { width: 600, height: 800 } as { width: number; height: number; transform: readonly number[] },
  openFails: null as unknown,
  sizeFails: null as unknown,
  renderFails: null as unknown,
  destroyed: 0,
  rendered: [] as { readonly page: number; readonly scale: number }[],
  deferOpen: false,
  deferRender: false,
  settleOpen: null as null | (() => void),
  settleRender: null as null | (() => void),
}))

vi.mock('../src/client/pdf/runtime', () => ({
  openPdf: async () => {
    if (runtime.deferOpen) await new Promise<void>((resolve) => { runtime.settleOpen = resolve })
    if (runtime.openFails !== null) throw runtime.openFails
    return {
      pageCount: runtime.pages,
      size: async (page: number) => {
        if (runtime.sizeFails !== null) throw runtime.sizeFails
        return { ...runtime.size, transform: [1, 0, 0, -1, 0, page] }
      },
      render: async (page: number, scale: number) => {
        if (runtime.deferRender) await new Promise<void>((resolve) => { runtime.settleRender = resolve })
        runtime.rendered.push({ page, scale })
        if (runtime.renderFails !== null) throw runtime.renderFails
        return {
          dataUrl: `data:image/png;base64,page${page}`,
          width: runtime.size.width,
          height: runtime.size.height,
          pixelWidth: runtime.size.width,
          pixelHeight: runtime.size.height,
        }
      },
      destroy: async () => { runtime.destroyed += 1 },
    }
  },
}))

/** The writer double: the real one parses the document, which a two-byte fixture is not. */
const writer = vi.hoisted(() => ({ calls: [] as { readonly page: number; readonly transform: readonly number[]; readonly marks: readonly AnnotationMark[] }[][] }))

vi.mock('../src/client/pdf/annotate', () => ({
  annotatePdf: async (_bytes: Uint8Array, pages: { readonly page: number; readonly transform: readonly number[]; readonly marks: readonly AnnotationMark[] }[]) => {
    writer.calls.push(pages.map(page => ({ ...page })))
    return new TextEncoder().encode('%PDF-1.7 annotated')
  },
}))

/** What one seat stub recorded, and how it should behave. */
const seatState = vi.hoisted(() => ({
  loaded: null as { path: string; mediaType: string; sha256: string; annotation: AnnotationDocument | null } | null,
  loadFails: null as unknown,
  saveFails: null as unknown,
  sendFails: null as unknown,
  warnings: [] as readonly string[],
  saved: { annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' } as { annotationPath: string; reviewPath: string | null },
  loads: [] as string[],
  saves: [] as { readonly address: string; readonly input: PagedAnnotationInput; readonly bytes: Uint8Array }[],
  sends: [] as {
    readonly input: PagedAnnotationInput
    readonly images: readonly PageImage[]
    readonly bytes: Uint8Array
  }[],
}))

/** The seat the entry half would inject. */
function stubSeat(): DocumentSeat {
  return {
    load: async (address) => {
      seatState.loads.push(address)
      if (seatState.loadFails !== null) throw seatState.loadFails
      return seatState.loaded ?? { path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), annotation: null }
    },
    save: async (address, input, bytes) => {
      if (seatState.saveFails !== null) throw seatState.saveFails
      seatState.saves.push({ address, input, bytes })
      return seatState.saved
    },
    send: async (input, saved, images, bytes) => {
      if (seatState.sendFails !== null) throw seatState.sendFails
      seatState.sends.push({ input, images, bytes })
      return [...seatState.warnings, ...(saved.reviewPath === null ? [] : [])]
    },
  }
}

/** Every props object the annotator body was rendered with, in order. */
const surfaces: AnnotatorBodyProps[] = []
/** Every `onDraftChange` identity the body was handed, in render order. */
const callbacks: (AnnotatorBodyProps['onDraftChange'])[] = []
let roots: Root[] = []

/** The number of spans on screen, so a render loop is visible as a count. */
let renders = 0

/**
 * The annotator double: it records what the document handed it, and reports its
 * draft from an effect keyed on that callback — the shape the real body has, and
 * the one that turns an unstable callback into a render loop.
 */
function StubBody(props: AnnotatorBodyProps): ReactNode {
  surfaces.push(props)
  callbacks.push(props.onDraftChange)
  renders += 1
  // Keyed on the callback alone, the way the real body keys its report on its own
  // marks: a body that reported on every render would be the loop this guards.
  useEffect(() => {
    props.onDraftChange?.({ marks: props.draft?.marks ?? [] })
  }, [props.onDraftChange])
  return <span>{`page ${String(props.page?.width ?? 0)} marks ${String(props.draft?.marks.length ?? 0)}`}</span>
}

/** The props the annotator body is currently rendered with. */
function currentProps(): AnnotatorBodyProps {
  return defined(surfaces[surfaces.length - 1])
}

/** Localized copy for the fallback dictionary. */
function copy(key: string, vars?: Record<string, number | string>): string {
  const text = (zh as Record<string, string>)[key] ?? key
  return vars === undefined
    ? text
    : text.replace(/\{(\w+)\}/gu, (placeholder, name: string) => String(vars[name] ?? placeholder))
}

/** Pane width the body measures, changed by the specs that resize it. */
let paneWidth = 800
let notifyResize: (() => void) | null = null

/** The props one mounted body is rendered with, with only the spec's own spelled out. */
function bodyProps(props: Partial<PdfBodyProps> = {}): PdfBodyProps {
  return {
    content: { kind: 'bytes', data: new Uint8Array([1, 2]) },
    resourceAddress: 'dsh-resource://file/session/s1/report.pdf',
    AnnotatorBody: StubBody,
    seat: stubSeat(),
    t: copy,
    ...props,
  } as PdfBodyProps
}

/** Mount one PDF body and let its chain of effects settle. */
async function mount(props: Partial<PdfBodyProps> = {}): Promise<{ readonly host: HTMLElement; readonly root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(<PdfBody {...bodyProps(props)} />) })
  await settle()
  return { host, root }
}

/** Render one more prop set into a body that is already mounted. */
async function rerender(root: Root, props: Partial<PdfBodyProps>): Promise<void> {
  await act(async () => { root.render(<PdfBody {...bodyProps(props)} />) })
  await settle()
}

/** Let every promise the body is waiting on run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

/** One toolbar button by its own label. */
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/** Click one button, letting the handler's promises settle. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

/** Report one page's marks the way the page body does. */
async function edit(marks: readonly AnnotationMark[]): Promise<void> {
  await act(async () => { currentProps().onDraftChange?.({ marks }) })
  await settle()
}

/** One mark on one page. */
function mark(id: string, page: number): AnnotationMark {
  return { id, kind: 'rect', color: '#1971c2', points: [[10, 20], [60, 90]], page }
}

beforeEach(() => {
  surfaces.length = 0
  callbacks.length = 0
  renders = 0
  roots = []
  paneWidth = 800
  runtime.pages = 3
  runtime.size = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }
  runtime.openFails = null
  runtime.sizeFails = null
  runtime.renderFails = null
  runtime.destroyed = 0
  runtime.rendered = []
  runtime.deferOpen = false
  runtime.deferRender = false
  runtime.settleOpen = null
  runtime.settleRender = null
  writer.calls = []
  seatState.loaded = null
  seatState.loadFails = null
  seatState.saveFails = null
  seatState.sendFails = null
  seatState.warnings = []
  seatState.saved = { annotationPath: '/w/report.pdf.annot.json', reviewPath: '/w/report.pdf.annotated.pdf' }
  seatState.loads = []
  seatState.saves = []
  seatState.sends = []
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => paneWidth })
  class StubResizeObserver {
    /**
     * @param callback - the measure callback the body registered.
     */
    constructor(callback: () => void) { notifyResize = callback }
    /** Nothing to observe: the spec fires the callback itself. */
    observe(): void {}
    /** Nothing to release. */
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  for (const root of roots) root.unmount()
  roots = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  notifyResize = null
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('opening a PDF', () => {
  it('renders the page the runtime produced, and hands it to the annotator body', async () => {
    await mount()
    const props = currentProps()
    expect(props.page).toEqual({ dataUrl: 'data:image/png;base64,page1', width: 600, height: 800 })
    // The bytes belong to the PDF half; the annotator body annotates the page.
    expect(props.content).toBeUndefined()
    expect(props.resourceAddress).toBe('dsh-resource://file/session/s1/report.pdf')
    expect(props.t).toBe(copy)
    expect(props.summary).toBe('')
    expect(typeof props.onSummaryChange).toBe('function')
    expect(seatState.loads).toEqual(['dsh-resource://file/session/s1/report.pdf'])
  })

  it('shows the document toolbar with the page it is on and how much is marked', async () => {
    const { host } = await mount()
    expect(host.textContent).toContain('1 / 3')
    expect(host.textContent).toContain(copy('documentScope', { pages: 3, marks: 0 }))
    await edit([mark('m1', 1), mark('m2', 1)])
    expect(host.textContent).toContain(copy('documentScope', { pages: 3, marks: 2 }))
  })

  it('shows a hint while the page is not ready', async () => {
    runtime.deferOpen = true
    const { host } = await mount()
    expect(host.textContent).toContain(zh.pdfRendering)
    expect(surfaces).toHaveLength(0)
    runtime.settleOpen?.()
    await settle()
    expect(currentProps().page?.dataUrl).toBe('data:image/png;base64,page1')
  })

  it('renders nothing, and opens nothing, without bytes', async () => {
    const { host } = await mount({ content: { kind: 'text' } })
    expect(host.textContent).toContain(zh.pdfRendering)
    expect(surfaces).toHaveLength(0)
    expect(runtime.rendered).toEqual([])
  })

  it('reports a failed open, measurement, and render', async () => {
    runtime.openFails = new Error('bad pdf')
    const first = await mount()
    expect(first.host.textContent).toContain(`${zh.pdfOpenFailed}bad pdf`)
    runtime.openFails = 'unreadable'
    const second = await mount()
    expect(second.host.textContent).toContain(`${zh.pdfOpenFailed}unreadable`)
    runtime.openFails = null
    runtime.sizeFails = new Error('no page 9')
    const third = await mount()
    expect(third.host.textContent).toContain(`${zh.pdfOpenFailed}no page 9`)
    runtime.sizeFails = null
    runtime.renderFails = 'raster broke'
    const fourth = await mount()
    expect(fourth.host.textContent).toContain(`${zh.pdfOpenFailed}raster broke`)
  })

  it('reports a failed read of the saved annotation as a status, not a broken page', async () => {
    seatState.loadFails = new Error('no such figure')
    const { host } = await mount()
    expect(host.textContent).toContain(`${zh.readError}no such figure`)
    expect(currentProps().page?.dataUrl).toBe('data:image/png;base64,page1')
  })

  it('reports a failed read that is not an Error as its own text', async () => {
    seatState.loadFails = 'the socket died'
    const { host } = await mount()
    expect(host.textContent).toContain(`${zh.readError}the socket died`)
  })

  it('waits for a pane wide enough to render into, then follows a resize', async () => {
    paneWidth = 40
    const { host } = await mount()
    expect(surfaces).toHaveLength(0)
    expect(runtime.rendered).toEqual([])
    paneWidth = 900
    await act(async () => { notifyResize?.() })
    await settle()
    expect(currentProps().page?.dataUrl).toBe('data:image/png;base64,page1')
    expect(host.textContent).toContain('page 600')
  })

  it('asks the parser for device pixels at the fit scale, within what the display can show', async () => {
    // 800px pane, 24px inset, 600pt page = a fit scale of 1.293.
    await mount()
    expect(defined(runtime.rendered[0]).scale).toBeCloseTo((800 - 24) / 600, 3)
    vi.stubGlobal('devicePixelRatio', 3)
    paneWidth = 1000
    await act(async () => { notifyResize?.() })
    await settle()
    // Denser than 2 is not worth the pixels.
    expect(defined(runtime.rendered[runtime.rendered.length - 1]).scale).toBeCloseTo(((1000 - 24) / 600) * 2, 3)
    vi.stubGlobal('devicePixelRatio', 0)
    paneWidth = 800
    await act(async () => { notifyResize?.() })
    await settle()
    // A display that reports nothing still renders at 1:1.
    expect(defined(runtime.rendered[runtime.rendered.length - 1]).scale).toBeCloseTo((800 - 24) / 600, 3)
  })
})

describe('paging', () => {
  it('keeps the choice to annotate across pages', async () => {
    // The page body is remounted per page, so the document keeps the choice; a
    // reader paging through a document is not put back into viewing mode each time.
    const { host } = await mount()
    await edit([mark('m1', 1)])
    expect(currentProps().mode).toBe('view')
    currentProps().onModeChange?.('annotate')
    await settle()
    expect(currentProps().mode).toBe('annotate')
    await click(button(host, zh.nextPage))
    expect(currentProps().mode).toBe('annotate')
  })

  it('opens ready to edit a document that already carries marks', async () => {
    seatState.loaded = {
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      annotation: {
        version: 1,
        figure: { address: 'a', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), pageCount: 3 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        marks: [mark('saved1', 1)],
      },
    }
    await mount()
    expect(currentProps().mode).toBe('annotate')
  })

  it('walks the document with the toolbar, and stops at both ends', async () => {
    const { host } = await mount()
    expect(button(host, zh.previousPage).disabled).toBe(true)
    await click(button(host, zh.nextPage))
    expect(host.textContent).toContain('2 / 3')
    expect(runtime.rendered.map(entry => entry.page)).toContain(2)
    await click(button(host, zh.nextPage))
    expect(host.textContent).toContain('3 / 3')
    expect(button(host, zh.nextPage).disabled).toBe(true)
    await click(button(host, zh.previousPage))
    expect(host.textContent).toContain('2 / 3')
  })

  it('hands the annotator body one report callback, so a draft cannot loop', async () => {
    // The body reports its draft from an effect keyed on this callback; an
    // inline arrow would change identity every render, report again, and store
    // state — "Maximum update depth exceeded" in the browser.
    await mount()
    expect(new Set(callbacks).size).toBe(1)
    expect(renders).toBeLessThan(8)
  })

  it('keeps each page its own marks while another page is on screen', async () => {
    const { host } = await mount()
    await edit([mark('m1', 1)])
    expect(host.textContent).toContain('marks 1')
    await click(button(host, zh.nextPage))
    expect(host.textContent).toContain('marks 0')
    await edit([mark('m9', 2)])
    await click(button(host, zh.previousPage))
    expect(host.textContent).toContain('marks 1')
  })

  it('keeps the marks a saved document carried, and warns when the file changed', async () => {
    seatState.loaded = {
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      annotation: {
        version: 1,
        figure: { address: 'a', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'b'.repeat(64), pageCount: 3 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        marks: [mark('saved1', 1), mark('saved2', 3)],
        summary: '已保存的总体说明',
      },
    }
    const { host } = await mount()
    expect(host.textContent).toContain(zh.stale)
    expect(host.textContent).toContain('marks 1')
    expect(currentProps().summary).toBe('已保存的总体说明')
    await click(button(host, zh.nextPage))
    await click(button(host, zh.nextPage))
    expect(host.textContent).toContain('marks 1')
    expect(host.textContent).toContain(copy('documentScope', { pages: 3, marks: 2 }))
  })

  it('puts a saved mark that names no page on the first one', async () => {
    // A single-surface figure's document read against a PDF has no page numbers at
    // all; its marks belong on the page the reader is looking at.
    seatState.loaded = {
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      annotation: {
        version: 1,
        figure: { address: 'a', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), pageCount: 3 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        marks: [{ id: 'pageless', kind: 'rect', color: '#1971c2', points: [[1, 2], [3, 4]] }],
      },
    }
    const { host } = await mount()
    expect(host.textContent).toContain('marks 1')
    await edit([{ id: 'pageless', kind: 'rect', color: '#1971c2', points: [[1, 2], [3, 4]], page: 1 }])
    await click(button(host, zh.save))
    expect(defined(seatState.saves[0]).input.marks).toEqual([{ id: 'pageless', kind: 'rect', color: '#1971c2', points: [[1, 2], [3, 4]], page: 1 }])
  })

  it('reads nothing, and saves nothing, without an address', async () => {
    const { host } = await mount({ resourceAddress: undefined })
    expect(seatState.loads).toEqual([])
    await edit([mark('m1', 1)])
    await click(button(host, zh.save))
    expect(seatState.saves).toEqual([])
    expect(host.textContent).toContain(zh.notReady)
  })

  it('shows one page and disables both ways when the document reports no pages', async () => {
    runtime.pages = 0
    const { host } = await mount()
    expect(host.textContent).toContain('1 / 0')
    expect(button(host, zh.previousPage).disabled).toBe(true)
    expect(button(host, zh.nextPage).disabled).toBe(true)
    await click(button(host, zh.nextPage))
    expect(host.textContent).toContain('1 / 0')
  })

  it('does not warn when the document on disk is the one that was annotated', async () => {
    seatState.loaded = {
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      annotation: {
        version: 1,
        figure: { address: 'a', path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), pageCount: 3 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        marks: [mark('saved1', 1)],
      },
    }
    const { host } = await mount()
    expect(host.textContent).not.toContain(zh.stale)
  })
})

describe('saving the document', () => {
  it('writes every page into the document, and the annotated document beside it', async () => {
    const { host } = await mount()
    await edit([mark('m1', 1)])
    await click(button(host, zh.nextPage))
    await edit([mark('m3', 2)])
    await click(button(host, zh.save))
    const saved = defined(seatState.saves[0])
    expect(saved.address).toBe('dsh-resource://file/session/s1/report.pdf')
    expect(saved.input.figure).toEqual({
      address: 'dsh-resource://file/session/s1/report.pdf',
      path: '/w/report.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      pageCount: 3,
    })
    // The page stamp is the document's own: each surface holds its marks without
    // one, and the document is what knows which page they belong to.
    expect(saved.input.marks.map(entry => [entry.page, entry.id])).toEqual([[1, 'm1'], [2, 'm3']])
    expect(defined(saved.input.marks[0]).points).toEqual(defined(mark('m1', 1)).points)
    // The writer is asked for just the pages that carry marks, each with the
    // transform that carries its page units back into the document.
    expect(defined(writer.calls[0]).map(entry => [entry.page, entry.transform, entry.marks.length]))
      .toEqual([[1, [1, 0, 0, -1, 0, 1], 1], [2, [1, 0, 0, -1, 0, 2], 1]])
    expect(new TextDecoder().decode(saved.bytes)).toBe('%PDF-1.7 annotated')
    expect(host.textContent).toContain(`${zh.saved}/w/report.pdf.annotated.pdf`)
  })

  it('falls back to the marks file when the save wrote no annotated copy', async () => {
    seatState.saved = { annotationPath: '/w/report.pdf.annot.json', reviewPath: null }
    const { host } = await mount()
    await edit([mark('m1', 1)])
    await click(button(host, zh.save))
    expect(host.textContent).toContain(`${zh.saved}/w/report.pdf.annot.json`)
  })

  it('sends the document, its annotated copy and a picture of every marked page', async () => {
    const { host } = await mount()
    await edit([mark('m1', 1)])
    await click(button(host, zh.nextPage))
    await click(button(host, zh.nextPage))
    await edit([mark('m3', 3)])
    await click(button(host, zh.saveAndSend))
    const sent = defined(seatState.sends[0])
    expect(sent.input.marks.map(entry => entry.page)).toEqual([1, 3])
    expect(sent.images.map(entry => [entry.page, entry.width, entry.height]))
      .toEqual([[1, 600, 800], [3, 600, 800]])
    expect(sent.images[0]?.dataUrl).toBe('data:image/png;base64,page1')
    expect(new TextDecoder().decode(sent.bytes)).toBe('%PDF-1.7 annotated')
    // A page rendered for the session is rendered at twice the page's own size:
    // the export draws the marks onto it at that factor.
    expect(defined(runtime.rendered[runtime.rendered.length - 1]).scale).toBe(2)
    expect(host.textContent).toContain(`${zh.sent}/w/report.pdf.annot.json`)
  })

  it('says what the delivery could not do', async () => {
    seatState.warnings = ['带批注 PDF 未随消息发送。']
    const { host } = await mount()
    await edit([mark('m1', 1)])
    await click(button(host, zh.saveAndSend))
    expect(host.textContent).toContain('带批注 PDF 未随消息发送。')
  })

  it('reports a failed save, and a failure that is not an Error', async () => {
    seatState.saveFails = new Error('the disk is full')
    const first = await mount()
    await edit([mark('m1', 1)])
    await click(button(first.host, zh.save))
    expect(first.host.textContent).toContain(`${zh.saveError}the disk is full`)
    seatState.saveFails = 'the socket died'
    const second = await mount()
    await edit([mark('m1', 1)])
    await click(button(second.host, zh.save))
    expect(second.host.textContent).toContain(`${zh.saveError}the socket died`)
  })

  it('reports a failed delivery', async () => {
    seatState.sendFails = new Error('the session refused the annotation message')
    const { host } = await mount()
    await edit([mark('m1', 1)])
    await click(button(host, zh.saveAndSend))
    expect(host.textContent).toContain(`${zh.saveError}the session refused the annotation message`)
  })

  it('saves nothing when no page carries a mark', async () => {
    const { host } = await mount()
    await click(button(host, zh.save))
    await click(button(host, zh.saveAndSend))
    expect(seatState.saves).toEqual([])
    expect(seatState.sends).toEqual([])
    expect(writer.calls).toEqual([])
    expect(host.textContent).not.toContain(zh.saved)
  })

  it('says so when the document facts are not known yet', async () => {
    // Without the Host's own facts there is nothing to write an annotation against,
    // so the action reports rather than silently doing nothing.
    const { host } = await mount({ content: { kind: 'text' } })
    await click(button(host, zh.save))
    expect(host.textContent).toContain(zh.notReady)
  })
})

describe('lifetime', () => {
  it('releases the document when the body is unmounted', async () => {
    const { root } = await mount()
    await act(async () => { root.unmount() })
    expect(runtime.destroyed).toBe(1)
  })

  it('releases a document that arrived after the body was already gone', async () => {
    runtime.deferOpen = true
    const { root } = await mount()
    await act(async () => { root.unmount() })
    runtime.settleOpen?.()
    await settle()
    expect(runtime.destroyed).toBe(1)
  })

  it('drops a page that finished rendering after the body was gone', async () => {
    runtime.deferRender = true
    const { host, root } = await mount()
    expect(host.textContent).toContain(zh.pdfRendering)
    await act(async () => { root.unmount() })
    runtime.settleRender?.()
    await settle()
    // The bitmap belongs to a body that no longer exists, so it is never painted.
    expect(host.textContent).toBe('')
    expect(surfaces).toHaveLength(0)
  })

  it('drops a read that failed after the body moved on', async () => {
    // The same answer, refused instead of delivered: an error the tab has moved
    // away from is not the page it now shows.
    const waiting: { fail?: (reason: unknown) => void } = {}
    const seat = stubSeat()
    const slow: DocumentSeat = {
      ...seat,
      load: (): Promise<never> => new Promise<never>((_resolve, reject) => { waiting.fail = reject }),
    }
    const { host, root } = await mount({ seat: slow })
    await rerender(root, { resourceAddress: undefined })
    waiting.fail?.(new Error('the socket died'))
    await settle()
    expect(host.textContent).not.toContain(zh.readError)
  })

  it('drops an annotation whose read finished after the body moved on', async () => {
    // The tab moved to another document while the read was in flight: the answer
    // belongs to the body that asked for it, so it is dropped rather than shown
    // against the document now on screen.
    const waiting: { release?: () => void } = {}
    const seat = stubSeat()
    const slow: DocumentSeat = {
      ...seat,
      load: async (address, signal) => {
        await new Promise<void>((resolve) => { waiting.release = resolve })
        return await seat.load(address, signal)
      },
    }
    const { host, root } = await mount({ seat: slow })
    await rerender(root, { resourceAddress: undefined })
    waiting.release?.()
    await settle()
    // Without the Host's facts there is nothing to save, which is what the dropped
    // answer leaves behind.
    await edit([mark('m1', 1)])
    await click(button(host, zh.save))
    expect(seatState.saves).toEqual([])
    expect(host.textContent).toContain(zh.notReady)
  })
})
