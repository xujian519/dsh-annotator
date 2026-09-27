// @vitest-environment jsdom
/** The PDF body: opening bytes, rendering the page on screen, paging, and unsaved edits. */
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotatorBodyProps } from '../src/client/AnnotatorBody'
import type { PdfBodyProps } from '../src/client/pdf/PdfBody'
import { PdfBody } from '../src/client/pdf/pdf'
import { zh } from '../src/client/locales'
import { defined } from './dom'

/** What the runtime double answers, per spec. */
const runtime = vi.hoisted(() => ({
  pages: 3,
  size: { width: 600, height: 800 } as { width: number; height: number },
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
      size: async () => {
        if (runtime.sizeFails !== null) throw runtime.sizeFails
        return runtime.size
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

/** Every props object the annotator body was rendered with, in order. */
const surfaces: AnnotatorBodyProps[] = []
/** Every `onDraftChange` identity the body was handed, in render order. */
const callbacks: (AnnotatorBodyProps['onDraftChange'])[] = []
let roots: Root[] = []

/** The number of spans on screen, so a render loop is visible as a count. */
let renders = 0

/**
 * The annotator double: it records what the PDF half handed it, and reports a
 * draft from an effect keyed on the callback — the shape the real body has, and
 * the one that turns an unstable callback into a render loop.
 */
function StubBody(props: AnnotatorBodyProps): ReactNode {
  surfaces.push(props)
  callbacks.push(props.onDraftChange)
  renders += 1
  useEffect(() => {
    // Idempotent per page, so a re-report never looks like a new edit.
    props.onDraftChange?.({ marks: [], summary: `draft of page ${String(props.page?.page)}` })
  }, [props.onDraftChange])
  return <span>{`page ${String(props.page?.page ?? 0)}`}</span>
}

/** The props the annotator body is currently rendered with. */
function currentProps(): AnnotatorBodyProps {
  return defined(surfaces[surfaces.length - 1])
}

/** Localized copy for the fallback dictionary. */
function copy(key: string): string {
  return (zh as Record<string, string>)[key] ?? key
}

/** Pane width the body measures, changed by the specs that resize it. */
let paneWidth = 800
let notifyResize: (() => void) | null = null

/** Mount one PDF body and let its chain of effects settle. */
async function mount(props: Partial<PdfBodyProps> = {}): Promise<{ readonly host: HTMLElement; readonly root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(
      <PdfBody
        content={{ kind: 'bytes', data: new Uint8Array([1, 2]) }}
        resourceAddress="dsh-resource://file/session/s1/report.pdf"
        AnnotatorBody={StubBody}
        sessions={undefined}
        sessionId="s1"
        localeId="zh"
        t={copy}
        {...props}
      />,
    )
  })
  await settle()
  return { host, root }
}

/** Let every promise the body is waiting on run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  surfaces.length = 0
  callbacks.length = 0
  renders = 0
  roots = []
  paneWidth = 800
  runtime.pages = 3
  runtime.size = { width: 600, height: 800 }
  runtime.openFails = null
  runtime.sizeFails = null
  runtime.renderFails = null
  runtime.destroyed = 0
  runtime.rendered = []
  runtime.deferOpen = false
  runtime.deferRender = false
  runtime.settleOpen = null
  runtime.settleRender = null
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
  it('renders the page the runtime produced, and not the file bytes', async () => {
    await mount()
    const props = currentProps()
    expect(props.page).toMatchObject({
      page: 1,
      pageCount: 3,
      source: { dataUrl: 'data:image/png;base64,page1', width: 600, height: 800 },
    })
    expect(typeof props.page?.goTo).toBe('function')
    // The bytes belong to the PDF half; the annotator body annotates the page.
    expect(props.content).toBeUndefined()
    expect(props.resourceAddress).toBe('dsh-resource://file/session/s1/report.pdf')
    expect(props.t).toBe(copy)
  })

  it('shows a hint while the page is not ready', async () => {
    runtime.deferOpen = true
    const { host } = await mount()
    expect(host.textContent).toContain(zh.pdfRendering)
    expect(surfaces).toHaveLength(0)
    runtime.settleOpen?.()
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(1)
  })

  it('renders nothing, and opens nothing, without bytes', async () => {
    const { host } = await mount({ content: { kind: 'text' } })
    expect(host.textContent).toContain(zh.pdfRendering)
    expect(surfaces).toHaveLength(0)
    expect(runtime.rendered).toEqual([])
  })

  it('reports a failed open, including a rejection that is not an Error', async () => {
    runtime.openFails = new Error('bad pdf')
    const first = await mount()
    expect(first.host.textContent).toContain(`${zh.pdfOpenFailed}bad pdf`)
    runtime.openFails = 'unreadable'
    const second = await mount()
    expect(second.host.textContent).toContain(`${zh.pdfOpenFailed}unreadable`)
  })

  it('reports a failed measurement and a failed render', async () => {
    runtime.sizeFails = new Error('no page 9')
    const first = await mount()
    expect(first.host.textContent).toContain(`${zh.pdfOpenFailed}no page 9`)
    runtime.sizeFails = null
    runtime.renderFails = 'raster broke'
    const second = await mount()
    expect(second.host.textContent).toContain(`${zh.pdfOpenFailed}raster broke`)
  })

  it('waits for a pane wide enough to render into, then follows a resize', async () => {
    paneWidth = 40
    const { host } = await mount()
    expect(surfaces).toHaveLength(0)
    expect(runtime.rendered).toEqual([])
    paneWidth = 900
    await act(async () => { notifyResize?.() })
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(1)
    expect(host.textContent).toContain('page 1')
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
  it('clamps every navigation request to the document', async () => {
    await mount()
    const goTo = defined(currentProps().page?.goTo)
    await act(async () => { goTo(2) })
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(2)
    expect(runtime.rendered.map(entry => entry.page)).toContain(2)
    await act(async () => { goTo(9) })
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(3)
    await act(async () => { goTo(0) })
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(1)
    // A request for the page already on screen is not a change at all.
    const renders = runtime.rendered.length
    await act(async () => { goTo(1) })
    await settle()
    expect(runtime.rendered).toHaveLength(renders)
  })

  it('clamps to page one when the document reports no pages', async () => {
    runtime.pages = 0
    await mount()
    const goTo = defined(currentProps().page?.goTo)
    await act(async () => { goTo(4) })
    await settle()
    expect(defined(surfaces[surfaces.length - 1]).page?.page).toBe(1)
  })

  it('hands the annotator body one report callback, so a draft cannot loop', async () => {
    // The body reports its draft from an effect keyed on this callback; an
    // inline arrow would change identity every render, report again, and store
    // state — "Maximum update depth exceeded" in the browser.
    await mount()
    expect(new Set(callbacks).size).toBe(1)
    expect(renders).toBeLessThan(8)
  })

  it('hands each page its own unsaved edits back', async () => {
    await mount()
    const first = defined(currentProps().draft)
    await act(async () => { defined(currentProps().page?.goTo)(2) })
    await settle()
    expect(defined(currentProps().draft)).not.toEqual(first)
    await act(async () => { defined(currentProps().page?.goTo)(1) })
    await settle()
    expect(defined(currentProps().draft)).toEqual(first)
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
})
