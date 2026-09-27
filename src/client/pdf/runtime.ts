/**
 * The seam over PDF.js.
 *
 * Everything PDF.js-specific lives here: the module worker started from the
 * inlined source, the parser's own `getDocument` options, and page rendering
 * onto a canvas. The rest of the annotator talks to `PdfDocument`, which keeps
 * the page logic above it ordinary testable code.
 * @module dsh-annotator/client/pdf/runtime
 */
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFPageProxy } from 'pdfjs-dist'
import { bundledPdfAssets, createPdfBinaryDataFactory, workerSource } from './assets'

/** One rendered page: the bitmap, and the page size it stands for. */
export interface PdfPageBitmap {
  /** PNG data URL, used both to display the page and to export the review image. */
  readonly dataUrl: string
  /** Page width in PDF units, independent of the rendered pixel count. */
  readonly width: number
  /** Page height in PDF units. */
  readonly height: number
  /** Width of the bitmap in device pixels. */
  readonly pixelWidth: number
  /** Height of the bitmap in device pixels. */
  readonly pixelHeight: number
}

/** One page's size in PDF units. */
export interface PdfPageSize {
  /** Width in PDF units. */
  readonly width: number
  /** Height in PDF units. */
  readonly height: number
}

/** One opened PDF, and the lifetime of everything that opened it. */
export interface PdfDocument {
  /** Number of pages. */
  readonly pageCount: number
  /**
   * Measure one page without rendering it.
   * @param page - 1-based page number.
   * @returns the page's size in PDF units.
   */
  size(page: number): Promise<PdfPageSize>
  /**
   * Render one page.
   * @param page - 1-based page number.
   * @param scale - device pixels per PDF unit.
   * @returns the rendered bitmap.
   */
  render(page: number, scale: number): Promise<PdfPageBitmap>
  /** Release the parser, its worker and the worker's source URL. */
  destroy(): Promise<void>
}

/**
 * Largest bitmap one page may allocate. Rendering is bounded here, where the
 * pixels are asked for, so a large page at a high-density display cannot turn
 * into an allocation the browser refuses.
 */
const MAX_PAGE_PIXELS = 16_777_216

/** Smallest scale a request is clamped to, so a collapsed pane still renders. */
const MIN_SCALE = 0.05

/**
 * Open complete PDF bytes.
 *
 * The worker is a Blob URL built from the inlined source: the client bundle is
 * fetched outside any module URL, so there is no path a relative worker file
 * could resolve against. A startup failure releases everything it started and
 * propagates — parsing never falls back to the main thread.
 * @param data - complete PDF bytes.
 * @returns the open document.
 * @throws {Error} when the worker or the parser refuses the bytes.
 */
export async function openPdf(data: Uint8Array<ArrayBuffer>): Promise<PdfDocument> {
  const sourceUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  const worker = new Worker(sourceUrl, { type: 'module', name: 'dsh-annotator-pdf' })
  const bridge = PDFWorker.create({ port: worker })
  let task: { destroy(): Promise<void> } | undefined
  const release = async (): Promise<void> => {
    if (task !== undefined) await task.destroy()
    bridge.destroy()
    worker.terminate()
    URL.revokeObjectURL(sourceUrl)
  }
  /** Run one page-scoped read and always hand the page back to the parser. */
  const withPage = async <T>(proxy: PDFPageProxy, read: (page: PDFPageProxy) => T): Promise<T> => {
    try {
      return read(proxy)
    } finally {
      proxy.cleanup()
    }
  }
  try {
    const opened = getDocument({
      data: data.slice(),
      worker: bridge,
      BinaryDataFactory: createPdfBinaryDataFactory(bundledPdfAssets()),
      cMapPacked: true,
      // The inlined assets answer every data request; a fetch inside the worker
      // would reach for the network the chunk exists to avoid.
      useWorkerFetch: false,
      enableXfa: false,
      stopAtErrors: true,
    })
    task = opened
    const pdf = await opened.promise
    return {
      pageCount: pdf.numPages,
      size: async (page: number): Promise<PdfPageSize> => {
        const proxy = await pdf.getPage(page)
        return await withPage(proxy, (measured) => {
          const viewport = measured.getViewport({ scale: 1 })
          return { width: viewport.width, height: viewport.height }
        })
      },
      render: async (page: number, scale: number): Promise<PdfPageBitmap> => {
        const proxy = await pdf.getPage(page)
        return await withPage(proxy, async (rendered) => {
          const units = rendered.getViewport({ scale: 1 })
          const bounded = Math.max(MIN_SCALE, Math.min(scale, Math.sqrt(MAX_PAGE_PIXELS / (units.width * units.height))))
          const viewport = rendered.getViewport({ scale: bounded })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(viewport.width))
          canvas.height = Math.max(1, Math.round(viewport.height))
          const context = canvas.getContext('2d')
          if (context === null) throw new Error('a 2D canvas is unavailable')
          await rendered.render({ canvasContext: context, viewport, canvas }).promise
          return {
            dataUrl: canvas.toDataURL('image/png'),
            width: units.width,
            height: units.height,
            pixelWidth: canvas.width,
            pixelHeight: canvas.height,
          }
        })
      },
      destroy: release,
    }
  } catch (error) {
    await release()
    throw error
  }
}
