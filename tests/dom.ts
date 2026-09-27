/** Shared test setup: a jsdom document, the stub geometry jsdom does not compute, and helpers. */
import { Blob as NodeBlob } from 'node:buffer'
import { JSDOM } from 'jsdom'

// React only batches updates inside act() when the environment says so.
;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

/**
 * Assert a value a spec expects to exist, so specs need no non-null assertion.
 * @param value - the value under test.
 * @returns the same value with `null` and `undefined` removed.
 * @throws {Error} when the value is absent.
 */
export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value, got nothing')
  return value
}

/**
 * Install a jsdom document on the global scope.
 * @returns the window the tests run against.
 */
export function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const globals = globalThis as Record<string, unknown>
  globals['window'] = dom.window
  globals['document'] = dom.window.document
  globals['DOMParser'] = dom.window.DOMParser
  globals['XMLSerializer'] = dom.window.XMLSerializer
  globals['Image'] = dom.window.Image
  globals['Blob'] = dom.window.Blob
  globals['FileReader'] = dom.window.FileReader
  globals['HTMLElement'] = dom.window.HTMLElement
  globals['SVGElement'] = dom.window.SVGElement
  globals['Element'] = dom.window.Element
  globals['Node'] = dom.window.Node
  return dom
}

/** One rectangle a stubbed `getBoundingClientRect` reports. */
export interface StubRect {
  /** Left edge in client space. */
  readonly left: number
  /** Top edge in client space. */
  readonly top: number
  /** Width in client pixels. */
  readonly width: number
  /** Height in client pixels. */
  readonly height: number
}

/**
 * Give one element a fixed client rectangle.
 * @param element - element to stub.
 * @param rect - the rectangle it reports.
 */
export function stubRect(element: Element, rect: StubRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  })
}

/** Which stage of the rasterizer a spec wants to fail. */
export interface RasterizerFaults {
  /** Make `getContext('2d')` answer null. */
  readonly noContext?: boolean
  /** Make the canvas refuse to encode a PNG. */
  readonly noBlob?: boolean
  /** Make the composed SVG fail to decode as an image. */
  readonly imageError?: boolean
}

/** What a stubbed rasterizer observed. */
export interface RasterizerLog {
  /** Canvas sizes the export asked for, in order. */
  readonly canvasSizes: { readonly width: number; readonly height: number }[]
  /** Object URLs that were revoked. */
  readonly revoked: string[]
}

/** 2D context calls a spec can assert on. */
interface StubContext {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
  drawImage(image: unknown, x: number, y: number, width: number, height: number): void
}

/**
 * Install the canvas, `Image`, and object-URL plumbing jsdom does not implement.
 *
 * jsdom has no rasterizer, so the export path would fail for the wrong reason
 * without this: the spec has to supply a canvas that reports the size it was
 * given, and an `Image` that decodes on the next microtask.
 * @param faults - which stage should fail instead of succeeding.
 * @returns the recorded sizes and revocations.
 */
export function stubRasterizer(faults: RasterizerFaults = {}): RasterizerLog {
  const globals = globalThis as Record<string, unknown>
  const log: RasterizerLog = { canvasSizes: [], revoked: [] }
  const context: StubContext = {
    fillStyle: '',
    fillRect: () => {},
    drawImage: () => {},
  }
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => 'blob:stub-review',
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => { log.revoked.push(url) },
  })
  const image = {
    decoding: '',
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    set src(_value: string) {
      queueMicrotask(() => {
        if (faults.imageError === true) image.onerror?.()
        else image.onload?.()
      })
    },
  }
  globals['Image'] = function StubImage(): unknown { return image }

  const document_ = globals['document'] as Document
  const original = document_.createElement.bind(document_)
  document_.createElement = ((tag: string): unknown => {
    if (tag !== 'canvas') return original(tag)
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (faults.noContext === true ? null : context),
      toBlob: (callback: (blob: Blob | null) => void): void => {
        log.canvasSizes.push({ width: canvas.width, height: canvas.height })
        // Node's Blob, not jsdom's: the export path reads `arrayBuffer()`, which
        // jsdom has never implemented.
        callback(faults.noBlob === true ? null : new NodeBlob([new Uint8Array([9])], { type: 'image/png' }) as Blob)
      },
      // The PDF path encodes the page through the canvas rather than a Blob.
      toDataURL: (): string => {
        log.canvasSizes.push({ width: canvas.width, height: canvas.height })
        return `data:image/png;base64,${'c3R1Yg=='}`
      },
    }
    return canvas
  }) as typeof document_.createElement
  return log
}

/** One `Worker` a spec constructed, and whether it was terminated. */
export interface StubWorker {
  /** URL the worker was constructed with. */
  readonly url: string
  /** Options the worker was constructed with. */
  readonly options: WorkerOptions | undefined
  /** Whether `terminate()` was called. */
  terminated: boolean
}

/**
 * Install a `Worker` double. jsdom ships no worker implementation, so the PDF
 * path would otherwise fail before it reached PDF.js.
 * @returns the workers that were constructed, in order.
 */
export function stubWorkers(): StubWorker[] {
  const workers: StubWorker[] = []
  ;(globalThis as Record<string, unknown>)['Worker'] = class {
    readonly record: StubWorker
    /**
     * @param url - the worker's source URL.
     * @param options - the worker's options.
     */
    constructor(url: string, options?: WorkerOptions) {
      this.record = { url, options, terminated: false }
      workers.push(this.record)
    }
    /** Record that the worker was stopped. */
    terminate(): void { this.record.terminated = true }
  }
  return workers
}
