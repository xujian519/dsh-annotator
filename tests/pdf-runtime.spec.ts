// @vitest-environment jsdom
/** The PDF.js seam: worker startup, parser options, page measurement, and rendering. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledPdfAssets, createPdfBinaryDataFactory, workerSource } from '../src/client/pdf/assets'
import { openPdf } from '../src/client/pdf/runtime'
import { defined, stubRasterizer, stubWorkers, type StubWorker } from './dom'

/** What the parser double recorded, and what it should answer next. */
const recorded = vi.hoisted(() => ({
  /** Every `getDocument` options object. */
  documents: [] as Record<string, unknown>[],
  /** Every page proxy that was handed back, so cleanup can be asserted. */
  pages: [] as Record<string, unknown>[],
  /** Every worker bridge PDF.js was given, with the argument it was created from. */
  bridges: [] as { readonly argument: Record<string, unknown>; readonly bridge: Record<string, unknown> }[],
  /** Whether `getDocument` should throw instead of returning a loading task. */
  refuse: false,
  /** What `getDocument` should return. */
  task: null as unknown,
}))

vi.mock('pdfjs-dist', () => ({
  getDocument: (options: Record<string, unknown>) => {
    recorded.documents.push(options)
    if (recorded.refuse) throw new Error('no parser')
    return recorded.task
  },
  PDFWorker: {
    create: (argument: Record<string, unknown>) => {
      const bridge = { destroy: vi.fn() }
      recorded.bridges.push({ argument, bridge })
      return bridge
    },
  },
}))

/** One page's geometry the fake parser answers with. */
interface PageSize {
  /** Page width in PDF units. */
  readonly width: number
  /** Page height in PDF units. */
  readonly height: number
}

/** A page proxy answering the two viewport calls the runtime makes. */
function pageProxy(size: PageSize = { width: 595, height: 842 }, faults: { readonly renderFails?: boolean } = {}): Record<string, unknown> {
  const proxy: Record<string, unknown> = {
    getViewport: ({ scale }: { readonly scale: number }) => ({ width: size.width * scale, height: size.height * scale }),
    render: () => ({ promise: faults.renderFails === true ? Promise.reject(new Error('render refused')) : Promise.resolve() }),
    cleanup: vi.fn(),
  }
  recorded.pages.push(proxy)
  return proxy
}

/** A parser document answering the pages a spec lists. */
function pdfDocument(pages: Record<string, unknown>[]): Record<string, unknown> {
  return { numPages: pages.length, getPage: async (number: number) => defined(pages[number - 1]) }
}

/** A loading task that settles with one parser document. */
function loadingTask(pdf: Record<string, unknown>): { readonly promise: Promise<unknown>; readonly destroy: () => Promise<void> } {
  return { promise: Promise.resolve(pdf), destroy: async () => {} }
}

/** The options one recorded `getDocument` received. */
function documentOptions(index = 0): Record<string, unknown> {
  return defined(recorded.documents[index])
}

let workers: StubWorker[] = []
let rasterizer = stubRasterizer()

/** The global the production build replaces with the inlined asset map. */
const ASSETS = {
  cMapUrl: { 'Adobe-Japan1-UCS2.bcmap': 'AAEC' },
  standardFontDataUrl: { 'FoxitSans.pfb': '' },
  wasmUrl: {},
} as const

beforeEach(() => {
  recorded.documents.length = 0
  recorded.pages.length = 0
  recorded.bridges.length = 0
  recorded.refuse = false
  recorded.task = null
  ;(globalThis as Record<string, unknown>)['__DSH_ANNOTATOR_PDF_ASSETS__'] = ASSETS
  rasterizer = stubRasterizer()
  workers = stubWorkers()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__DSH_ANNOTATOR_PDF_ASSETS__']
})

describe('inlined resources', () => {
  it('carries the worker source and the build-inlined bytes', () => {
    expect(typeof workerSource).toBe('string')
    expect(workerSource.length).toBeGreaterThan(0)
    expect(bundledPdfAssets()).toBe(ASSETS)
  })

  it('decodes one resource and refuses a name this build does not carry', async () => {
    const factory = new (createPdfBinaryDataFactory(ASSETS))()
    const bytes = await factory.fetch({ kind: 'cMapUrl', filename: 'Adobe-Japan1-UCS2.bcmap' })
    expect([...bytes]).toEqual([0, 1, 2])
    // An empty file is still a bundled file, not a missing one.
    expect(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSans.pfb' })).toHaveLength(0)
    await expect(factory.fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' })).rejects.toThrow('is not bundled')
  })
})

describe('opening documents', () => {
  it('starts the worker from a Blob URL and hands PDF.js its own bridge', async () => {
    const pdf = pdfDocument([pageProxy()])
    recorded.task = loadingTask(pdf)
    const bytes = new Uint8Array([1, 2, 3])
    const opened = await openPdf(bytes)
    expect(opened.pageCount).toBe(1)
    const worker = defined(workers[0])
    expect(worker.url).toBe('blob:stub-review')
    expect(worker.options).toEqual({ type: 'module', name: 'dsh-annotator-pdf' })
    const options = documentOptions()
    expect(options['cMapPacked']).toBe(true)
    expect(options['useWorkerFetch']).toBe(false)
    expect(options['enableXfa']).toBe(false)
    expect(options['stopAtErrors']).toBe(true)
    expect(options['worker']).toBe(defined(recorded.bridges[0]).bridge)
    // …and the worker it bridges is the one this module started from the Blob URL.
    expect((defined(recorded.bridges[0]).argument['port'] as { readonly record: { readonly url: string } }).record.url).toBe('blob:stub-review')
    // The parser receives a copy, so the preview's own buffer stays usable.
    const passed = options['data'] as Uint8Array
    expect(passed).not.toBe(bytes)
    expect([...passed]).toEqual([1, 2, 3])
    const BinaryDataFactory = options['BinaryDataFactory'] as new () => { fetch: (request: unknown) => Promise<Uint8Array> }
    const asset = await new BinaryDataFactory().fetch({ kind: 'cMapUrl', filename: 'Adobe-Japan1-UCS2.bcmap' })
    expect([...asset]).toEqual([0, 1, 2])
  })

  it('measures and renders one page, releasing the page each time', async () => {
    const first = pageProxy({ width: 200, height: 100 })
    const second = pageProxy({ width: 200, height: 100 })
    recorded.task = loadingTask(pdfDocument([first, second]))
    const opened = await openPdf(new Uint8Array([9]))
    expect(await opened.size(1)).toEqual({ width: 200, height: 100 })
    const bitmap = await opened.render(2, 2)
    expect(bitmap).toMatchObject({
      dataUrl: 'data:image/png;base64,c3R1Yg==',
      width: 200,
      height: 100,
      pixelWidth: 400,
      pixelHeight: 200,
    })
    expect(rasterizer.canvasSizes).toEqual([{ width: 400, height: 200 }])
    expect(first['cleanup']).toHaveBeenCalledTimes(1)
    expect(second['cleanup']).toHaveBeenCalledTimes(1)
  })

  it('bounds a page bitmap by both a floor and a total pixel cap', async () => {
    recorded.task = loadingTask(pdfDocument([pageProxy()]))
    const opened = await openPdf(new Uint8Array([9]))
    // 595x842 at scale 100 would be 50 million pixels; the cap is 16.7 million.
    expect((await opened.render(1, 100)).pixelWidth).toBe(3443)
    expect((await opened.render(1, 0)).pixelWidth).toBe(30)
  })

  it('refuses to render without a 2D context', async () => {
    rasterizer = stubRasterizer({ noContext: true })
    recorded.task = loadingTask(pdfDocument([pageProxy()]))
    const opened = await openPdf(new Uint8Array([9]))
    await expect(opened.render(1, 1)).rejects.toThrow('a 2D canvas is unavailable')
  })

  it('propagates a page render failure', async () => {
    recorded.task = loadingTask(pdfDocument([pageProxy({ width: 10, height: 10 }, { renderFails: true })]))
    const opened = await openPdf(new Uint8Array([9]))
    await expect(opened.render(1, 1)).rejects.toThrow('render refused')
  })

  it('releases worker and parser when startup fails, and never falls back to the main thread', async () => {
    recorded.refuse = true
    await expect(openPdf(new Uint8Array([1]))).rejects.toThrow('no parser')
    expect(defined(workers[0]).terminated).toBe(true)
    expect(rasterizer.revoked).toContain('blob:stub-review')
  })

  it('releases everything when the parser refuses the bytes', async () => {
    const destroy = vi.fn(async () => {})
    recorded.task = { promise: Promise.reject(new Error('broken pdf')), destroy }
    await expect(openPdf(new Uint8Array([1]))).rejects.toThrow('broken pdf')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(defined(workers[0]).terminated).toBe(true)
  })

  it('tears the parser, the bridge and the source URL down on destroy', async () => {
    const destroy = vi.fn(async () => {})
    recorded.task = { promise: Promise.resolve(pdfDocument([pageProxy()])), destroy }
    const opened = await openPdf(new Uint8Array([1]))
    await opened.destroy()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(defined(workers[0]).terminated).toBe(true)
    expect(rasterizer.revoked).toContain('blob:stub-review')
  })
})
