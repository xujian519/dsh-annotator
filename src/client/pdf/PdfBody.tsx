/**
 * The PDF body: one page at a time, annotated by the shared annotator body.
 *
 * This module is the lazy chunk, so PDF.js and its data are paid for only when a
 * PDF is opened. It owns what is PDF-specific — opening the document, deciding
 * the raster resolution for the pane, keeping unsaved edits per page — and hands
 * each rendered page to the annotator body, which owns the marks, the toolbar and
 * the trip to the Host.
 * @module dsh-annotator/client/pdf/PdfBody
 */
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { AnnotatorBodyProps, AnnotatorInjected, SurfaceDraft } from '../AnnotatorBody'
import { openPdf, type PdfDocument } from './runtime'

/**
 * What the chunk needs from the main bundle.
 *
 * The annotator body crosses as a prop because a package-local chunk cannot
 * import its own package's entry bundle: the import would either duplicate the
 * whole client half or resolve through a module table that carries only the
 * shell's modules.
 */
export interface PdfBodyInjected extends AnnotatorInjected {
  /** The annotator body, mounted once per page. */
  readonly AnnotatorBody: ComponentType<AnnotatorBodyProps>
}

/**
 * Everything the PDF body renders with.
 *
 * Copy arrives resolved: a shared module between the entry bundle and this chunk
 * would be emitted as a second artifact that the entry's static `require` cannot
 * fetch, so the chunk owns no dictionary of its own.
 */
export type PdfBodyProps = Omit<AnnotatorBodyProps, 't'> & {
  /** Copy, already resolved against the shell's locale or the fallback dictionary. */
  readonly t: (key: string) => string
} & PdfBodyInjected

/** Gap kept around a page inside the pane, matching the annotator's own inset. */
const PANE_INSET = 24

/** Highest device-pixel ratio one page bitmap is rendered at. */
const MAX_DENSITY = 2

/** Narrowest pane a page is rendered for; below it the pane is still settling. */
const MIN_PANE_WIDTH = 120

/** One rendered page, as the annotator body receives it. */
interface PageBitmap {
  /** PNG data URL of the page. */
  readonly dataUrl: string
  /** Page width in page units. */
  readonly width: number
  /** Page height in page units. */
  readonly height: number
}

/**
 * Render one PDF, one page at a time.
 * @param props - document content, addressed resource, locale seat, session face, and the annotator body.
 * @returns the PDF page, or why it is not on screen yet.
 */
export function PdfBody(props: PdfBodyProps): ReactNode {
  const { AnnotatorBody, t, ...bodyProps } = props
  const bytes = props.content?.kind === 'bytes' ? props.content.data : undefined
  const observerRef = useRef<ResizeObserver | null>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [page, setPage] = useState(1)
  const [bitmap, setBitmap] = useState<PageBitmap | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyMap<number, SurfaceDraft>>(new Map())
  const pageCount = pdf === null ? 0 : pdf.pageCount

  // --- the document ---------------------------------------------------------

  useEffect(() => {
    if (bytes === undefined) return
    let live = true
    let opened: PdfDocument | undefined
    void openPdf(bytes).then(
      (document_) => {
        // Opening can outlive the tab; the document it produced owns a worker
        // and a Blob URL, so an abandoned one is released rather than dropped.
        if (!live) {
          void document_.destroy()
          return
        }
        opened = document_
        setPdf(document_)
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => {
      live = false
      if (opened !== undefined) void opened.destroy()
    }
  }, [bytes])

  // --- pane width -----------------------------------------------------------

  /**
   * Measure the pane when it appears and whenever it changes. The ref callback
   * owns the observer for exactly the element's lifetime: a null element is the
   * unmount, which is where the observer goes.
   */
  const attachHost = useCallback((element: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (element === null) return
    setPaneWidth(element.clientWidth)
    const observer = new ResizeObserver(() => { setPaneWidth(element.clientWidth) })
    observer.observe(element)
    observerRef.current = observer
  }, [])

  // --- the page on screen ---------------------------------------------------

  useEffect(() => {
    if (pdf === null || paneWidth < MIN_PANE_WIDTH) return
    let live = true
    setBitmap(null)
    void (async () => {
      try {
        const size = await pdf.size(page)
        // Render at the scale the pane will show, times the display density, so
        // fit width is crisp without asking the parser for pixels CSS discards.
        const fit = Math.max(0.1, (paneWidth - PANE_INSET) / size.width)
        const density = Math.min(MAX_DENSITY, globalThis.devicePixelRatio || 1)
        const rendered = await pdf.render(page, fit * density)
        if (!live) return
        setBitmap({ dataUrl: rendered.dataUrl, width: rendered.width, height: rendered.height })
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { live = false }
  }, [pdf, page, paneWidth])

  /** The only place a page number is decided: requests are clamped, not trusted. */
  const goTo = useCallback((next: number): void => {
    const highest = pageCount < 1 ? 1 : pageCount
    setPage((current) => {
      const bounded = Math.min(Math.max(next, 1), highest)
      return bounded === current ? current : bounded
    })
  }, [pageCount])

  /** Keep one page's unsaved edits while another page is on screen. */
  const remember = useCallback((edited: number, draft: SurfaceDraft): void => {
    setDrafts((current) => new Map(current).set(edited, draft))
  }, [])

  /**
   * The page the annotator body is showing, as a stable callback.
   *
   * Identity matters here: the body reports its draft from an effect keyed on
   * that callback, so an inline arrow would make every render report again, and
   * the report stores state — a render loop, not a slow path.
   */
  const reportDraft = useCallback((draft: SurfaceDraft): void => { remember(page, draft) }, [remember, page])

  const surface = bitmap === null
    ? null
    : { page, pageCount, source: bitmap, goTo }

  return (
    <div className="da-pdf" ref={attachHost}>
      {error !== null ? (
        <p className="da-hint" role="alert">{`${t('pdfOpenFailed')}${error}`}</p>
      ) : surface === null ? (
        <p className="da-hint">{t('pdfRendering')}</p>
      ) : (
        <AnnotatorBody
          {...bodyProps}
          // The resolved copy travels with the body; the bytes stay here, because
          // the annotator body annotates the page rather than the file.
          t={t}
          content={undefined}
          page={surface}
          draft={drafts.get(page)}
          onDraftChange={reportDraft}
        />
      )}
    </div>
  )
}
