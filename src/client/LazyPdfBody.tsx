/**
 * The PDF renderer, mounted only once a PDF body is.
 *
 * `react.lazy` is the whole point of the split: the browser fetches
 * `client.pdf.js` on demand, so PDF.js and the data it reads never load for a
 * session that never opens a PDF.
 * @module dsh-annotator/client/LazyPdfBody
 */
import { Suspense, lazy, type ReactNode } from 'react'
import type { AnnotatorBodyProps } from './AnnotatorBody'
import type { PdfBodyInjected } from './pdf/PdfBody'
import { fallbackTranslate } from './locales'

/** The chunk's renderer, fetched when this body first mounts. */
const LoadedPdfBody = lazy(async () => {
  const chunk = await import('./pdf/pdf')
  return { default: chunk.PdfBody }
})

/**
 * Suspend while the PDF chunk arrives.
 * @param props - the annotator's props plus the main bundle's own annotator body.
 * @returns the deferred PDF renderer.
 */
export function LazyPdfBody(props: AnnotatorBodyProps & PdfBodyInjected): ReactNode {
  const t = (key: string): string => props.t?.(key) ?? fallbackTranslate(props.localeId ?? 'zh', key)
  return (
    <Suspense fallback={<p className="da-hint">{t('pdfRendering')}</p>}>
      {/* Copy is resolved here: the chunk carries no dictionary, so nothing it
          needs is shared with this bundle. */}
      <LoadedPdfBody {...props} t={t} />
    </Suspense>
  )
}
