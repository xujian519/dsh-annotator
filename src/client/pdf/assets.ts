/**
 * The PDF.js resources the lazy chunk carries.
 *
 * A preview runs with no file access and no CDN, so the parser's worker, its
 * CMaps, its standard fonts and its wasm decoders all travel inside the chunk:
 * the worker becomes a Blob URL, and the three data directories are read
 * through PDF.js's own `BinaryDataFactory` hook. Every byte arrives from the
 * build, so opening a PDF never touches the network beyond the chunk itself.
 * @module dsh-annotator/client/pdf/assets
 */
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

export { workerSource }

/** The three resource kinds PDF.js 6 asks a binary factory for. */
export type PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

/** Original file names mapped to base64, all from the installed PDF.js version. */
export type PdfAssetMap = Readonly<Record<PdfAssetKind, Readonly<Record<string, string>>>>

declare global {
  /**
   * Base64 resources the production build substitutes for this identifier.
   * Tests inject their own map through the same global.
   */
  const __DSH_ANNOTATOR_PDF_ASSETS__: PdfAssetMap
}

/**
 * The resources this build inlined.
 * @returns the asset map.
 */
export function bundledPdfAssets(): PdfAssetMap {
  return __DSH_ANNOTATOR_PDF_ASSETS__
}

/** The shape PDF.js calls when it needs one CMap, font or wasm module. */
export interface PdfBinaryDataFactory {
  /**
   * @param request - the resource kind and exact file name PDF.js asked for.
   * @returns the resource bytes.
   * @throws {Error} when this build did not inline that file.
   */
  fetch(request: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array>
}

/**
 * Build the factory PDF.js reads its data through.
 * @param assets - base64 resources, read only when a page needs one.
 * @returns the constructor passed to `getDocument`.
 */
export function createPdfBinaryDataFactory(assets: PdfAssetMap): new () => PdfBinaryDataFactory {
  return class implements PdfBinaryDataFactory {
    fetch({ kind, filename }: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array> {
      return Promise.resolve().then(() => {
        const encoded = assets[kind][filename]
        if (encoded === undefined) throw new Error(`pdf.js asset is not bundled: ${kind}/${filename}`)
        const binary = atob(encoded)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return bytes
      })
    }
  }
}
