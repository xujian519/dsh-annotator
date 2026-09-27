// @vitest-environment jsdom
/** The lazy boundary: the chunk is fetched on demand, and copy resolves before it does. */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotatorBodyProps } from '../src/client/AnnotatorBody'
import { LazyPdfBody, type LazyPdfBodyProps } from '../src/client/LazyPdfBody'
import { en, zh } from '../src/client/locales'
// For its side effect: React only flushes a lazy boundary from act() when the
// environment says the test is an act environment, and that flag is global.
import './dom'

vi.mock('../src/client/pdf/runtime', () => ({
  openPdf: async () => ({
    pageCount: 1,
    size: async () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
    render: async () => ({ dataUrl: 'data:image/png;base64,p1', width: 100, height: 100, pixelWidth: 100, pixelHeight: 100 }),
    destroy: async () => {},
  }),
}))

/** The annotator double the chunk receives through its props. */
/** The annotator double the chunk receives through its props. */
function StubBody(props: AnnotatorBodyProps): ReactNode {
  return <span>{`stub page ${String(props.page?.dataUrl ?? 'none')}`}</span>
}

/** Record the measure callback the body registers, then fire it. */
class StubResizeObserver {
  /**
   * @param callback - the measure callback the body registered.
   */
  constructor(callback: () => void) { this.callback = callback }
  private readonly callback: () => void
  /** Fire the measurement once, so the pane has a width. */
  observe(): void { this.callback() }
  /** Nothing to release. */
  disconnect(): void {}
}

let roots: Root[] = []

/** Render the lazy boundary without waiting for the chunk. */
function renderSync(props: Partial<LazyPdfBodyProps> = {}): { readonly host: HTMLElement; readonly root: Root } {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  // The defaults are the injected seats the slot would supply; a spec that
  // passes its own overrides them, including by leaving one out on purpose.
  const seats = {
    content: { kind: 'bytes', data: new Uint8Array([1]) },
    resourceAddress: 'dsh-resource://file/session/s1/report.pdf',
    AnnotatorBody: StubBody,
    seat: {
      load: async () => ({ path: '/w/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), annotation: null }),
      save: async () => ({ annotationPath: '/w/a.annot.json', reviewPath: null }),
      send: async () => [],
    },
    ...props,
  } as LazyPdfBodyProps
  act(() => {
    root.render(<LazyPdfBody {...seats} />)
  })
  return { host, root }
}

/**
 * The chunk this spec drives, imported once up front.
 *
 * What is under test is the boundary, not how long the transform of a megabyte of
 * inlined PDF.js takes: awaiting this in `settle` means the first check waits for
 * the module, and every later one finds it in the cache.
 */
const chunkLoaded = import('../src/client/pdf/pdf')

/** Let the chunk arrive and the page render. */
async function settle(): Promise<void> {
  await chunkLoaded
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
  }
}

beforeEach(() => {
  roots = []
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  for (const root of roots) root.unmount()
  roots = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('the lazy PDF body', () => {
  it('suspends on the fallback copy, then renders the chunk', async () => {
    const { host } = renderSync({ localeId: 'zh' })
    expect(host.textContent).toContain(zh.pdfRendering)
    await settle()
    expect(host.textContent).toContain('stub page data:image/png;base64,p1')
  })

  it('uses the bound translator when the shell supplies one', async () => {
    const seen: string[] = []
    const { host } = renderSync({
      localeId: 'en',
      t: (key: string) => { seen.push(key); return `bound:${key}` },
    })
    expect(host.textContent).toContain('bound:pdfRendering')
    expect(seen).toContain('pdfRendering')
  })

  it('falls back to English copy when no translator is bound', async () => {
    const { host } = renderSync({ localeId: 'en-US' })
    expect(host.textContent).toContain(en.pdfRendering)
  })

  it('falls back to the product language when the locale service reports none', async () => {
    const { host } = renderSync({})
    expect(host.textContent).toContain(zh.pdfRendering)
  })
})
