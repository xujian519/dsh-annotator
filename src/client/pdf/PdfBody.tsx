/**
 * The PDF body: the whole document, one page on screen at a time.
 *
 * This module is the lazy chunk, so PDF.js, the PDF writer and their data are paid
 * for only when a PDF is opened. It owns what is PDF-specific — opening the
 * document, deciding the raster resolution for the pane, keeping unsaved edits per
 * page, writing the marks into a copy of the document — and it is the document's
 * one writer: every page's marks are saved as one annotation and delivered as one
 * message. Each page on screen is handed to the annotator body, which owns the
 * drawing surface and the marks of that page.
 * @module dsh-annotator/client/pdf/PdfBody
 */
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { AnnotationMark } from '../../shared/annotation'
import type { AnnotatorBodyProps, BodyContent, SurfaceDraft, Translate } from '../AnnotatorBody'
import type { DocumentSeat, PageImage, PagedAnnotationInput } from '../document-seat'
import { annotatePdf, type PageAnnotateInput } from './annotate'
import { openPdf, type PdfDocument } from './runtime'

/**
 * What the chunk needs from the main bundle.
 *
 * Both seats cross as props because a package-local chunk cannot import its own
 * package's entry bundle: the import would either duplicate the whole client half
 * or resolve through a module table that carries only the shell's modules.
 */
export interface PdfBodyInjected {
  /** The annotator body, mounted once per page. */
  readonly AnnotatorBody: ComponentType<AnnotatorBodyProps>
  /** The entry half's document work: read, save and deliver the whole sidecar. */
  readonly seat: DocumentSeat
}

/** Everything the PDF body renders with. */
export type PdfBodyProps = PdfBodyInjected & {
  /** Document content: complete bytes for a `bytes-complete` renderer. */
  readonly content?: BodyContent | undefined
  /** The tab's `dsh-resource://file/…` address. */
  readonly resourceAddress?: string | undefined
  /** Owner callback that registers the body's scrollport. */
  readonly scrollportRef?: ((element: HTMLElement | null) => void) | undefined
  /** Copy, already resolved against the shell's locale or the fallback dictionary. */
  readonly t: Translate
}

/** Gap kept around a page inside the pane, matching the annotator's own inset. */
const PANE_INSET = 24

/** Highest device-pixel ratio one page bitmap is rendered at. */
const MAX_DENSITY = 2

/** Narrowest pane a page is rendered for; below it the pane is still settling. */
const MIN_PANE_WIDTH = 120

/** The document's own facts, as the Host reported them. */
interface FigureFacts {
  readonly path: string
  readonly mediaType: string
  readonly sha256: string
}

/** One page's marks, keyed by 1-based page number. */
type MarksByPage = ReadonlyMap<number, readonly AnnotationMark[]>

/** One rendered page, as the pane and the annotator body use it. */
interface PageBitmap {
  /** PNG data URL of the page. */
  readonly dataUrl: string
  /** Page width in page units. */
  readonly width: number
  /** Page height in page units. */
  readonly height: number
}

/**
 * Group one document's marks by the page they belong to.
 * @param marks - every mark of the document.
 * @returns the marks of each page; a mark without a page is on page 1.
 */
function groupByPage(marks: readonly AnnotationMark[]): MarksByPage {
  const grouped = new Map<number, readonly AnnotationMark[]>()
  for (const mark of marks) {
    const page = mark.page ?? 1
    grouped.set(page, [...(grouped.get(page) ?? []), mark])
  }
  return grouped
}

/** One marked page, with the marks it carries. */
interface MarkedPage {
  /** 1-based page number. */
  readonly page: number
  /** The marks drawn on it. */
  readonly marks: readonly AnnotationMark[]
}

/**
 * The pages that carry at least one mark.
 * @param marks - every page's marks.
 * @returns the marked pages, ascending, each with its own marks.
 */
function markedPages(marks: MarksByPage): MarkedPage[] {
  return [...marks.entries()]
    .filter(([, pageMarks]) => pageMarks.length > 0)
    .sort(([left], [right]) => left - right)
    .map(([page, pageMarks]) => ({ page, marks: pageMarks }))
}

/** Every mark, in page then draw order, each stamped with the page it is on. */
function allMarks(marks: MarksByPage): AnnotationMark[] {
  // The page is the document's own knowledge: a surface knows the marks it holds,
  // not which page it is mounted for, so the stamp is added here — once, where the
  // whole document is in view.
  return markedPages(marks).flatMap(entry => entry.marks.map(mark => ({ ...mark, page: entry.page })))
}

/**
 * Render one PDF, one page at a time, annotating it as a whole document.
 * @param props - document content, addressed resource, copy, and the injected seats.
 * @returns the document's toolbar and the page on screen, or why it is not there yet.
 */
export function PdfBody(props: PdfBodyProps): ReactNode {
  const { AnnotatorBody, seat, t } = props
  const address = props.resourceAddress ?? ''
  const bytes = props.content?.kind === 'bytes' ? props.content.data : undefined
  const observerRef = useRef<ResizeObserver | null>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [page, setPage] = useState(1)
  const [bitmap, setBitmap] = useState<PageBitmap | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [figure, setFigure] = useState<FigureFacts | null>(null)
  const [marks, setMarks] = useState<MarksByPage>(new Map())
  const [summary, setSummary] = useState('')
  /** Viewing or annotating, kept here so paging does not reset it. */
  const [mode, setMode] = useState<'view' | 'annotate'>('view')
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState<'saving' | 'sending' | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
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

  // --- the saved annotation -------------------------------------------------

  useEffect(() => {
    if (address === '') return
    const controller = new AbortController()
    void (async () => {
      try {
        const loaded = await seat.load(address, controller.signal)
        if (controller.signal.aborted) return
        setFigure({ path: loaded.path, mediaType: loaded.mediaType, sha256: loaded.sha256 })
        const saved = loaded.annotation
        if (saved === null) return
        setMarks(groupByPage(saved.marks))
        setSummary(saved.summary ?? '')
        // A document that already carries marks opens ready to edit them.
        if (saved.marks.length > 0) setMode('annotate')
        setCreatedAt(saved.createdAt)
        setStale(saved.figure.sha256 !== loaded.sha256)
      } catch (cause) {
        if (controller.signal.aborted) return
        setStatus({ tone: 'error', text: `${t('readError')}${cause instanceof Error ? cause.message : String(cause)}` })
      }
    })()
    return () => { controller.abort() }
  }, [address, seat, t])

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
        const rendered = await renderPage(pdf, page, paneWidth)
        if (!live) return
        setBitmap(rendered)
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { live = false }
  }, [pdf, page, paneWidth])

  /** The only place a page number is decided: requests are clamped, not trusted. */
  const goTo = useCallback((next: number): void => {
    // A document that reports no pages still shows page one, so the clamp carries
    // its own floor. Asking for the page already on screen returns the same number,
    // which React treats as no change at all.
    setPage(() => Math.min(Math.max(next, 1), Math.max(pageCount, 1)))
  }, [pageCount])

  /** Keep one page's unsaved edits while another page is on screen. */
  const remember = useCallback((edited: number, draft: SurfaceDraft): void => {
    // The same array is the same edits: storing it again would rebuild the map,
    // re-render the document, and let a talkative page report its way into a loop.
    setMarks((current) => (current.get(edited) === draft.marks ? current : new Map(current).set(edited, draft.marks)))
  }, [])

  /**
   * The page the annotator body is showing, as a stable callback.
   *
   * Identity matters here: the body reports its draft from an effect keyed on
   * that callback, so an inline arrow would make every render report again, and
   * the report stores state — a render loop, not a slow path.
   */
  const reportDraft = useCallback((draft: SurfaceDraft): void => { remember(page, draft) }, [remember, page])

  // --- save and delivery ----------------------------------------------------

  /** Everything one save persists, or null while the document is still unknown. */
  const collect = useCallback((): PagedAnnotationInput | null => {
    if (figure === null || pageCount < 1) return null
    return {
      figure: { address, ...figure, pageCount },
      marks: allMarks(marks),
      summary,
      createdAt,
    }
  }, [address, createdAt, figure, marks, pageCount, summary])

  const run = useCallback(async (deliver: boolean): Promise<void> => {
    // The only enforcement point: the toolbar buttons stay clickable so this
    // guard is what decides, not a disabled attribute that hides the reason.
    const input = collect()
    if (input === null) {
      setStatus({ tone: 'error', text: t('notReady') })
      return
    }
    if (input.marks.length === 0 || pdf === null || bytes === undefined) return
    setBusy(deliver ? 'sending' : 'saving')
    setStatus({ tone: 'info', text: t(deliver ? 'sending' : 'saving') })
    try {
      const pages = markedPages(marks)
      const annotatedPdf = await annotatePdf(bytes, await annotateInputs(pdf, pages))
      const saved = await seat.save(address, input, annotatedPdf)
      setCreatedAt(input.createdAt ?? new Date().toISOString())
      setStale(false)
      if (!deliver) {
        // The annotated document is the artifact the user asked for; the marks file
        // is named by the message when the annotation is sent.
        setStatus({ tone: 'ok', text: `${t('saved')}${saved.reviewPath ?? saved.annotationPath}` })
        return
      }
      const warnings = await seat.send(input, saved, await reviewPages(pdf, pages), annotatedPdf)
      const text = `${t('sent')}${saved.annotationPath}${warnings.length === 0 ? '' : ` ${warnings.join(' ')}`}`
      setStatus({ tone: warnings.length === 0 ? 'ok' : 'info', text })
    } catch (cause) {
      setStatus({ tone: 'error', text: `${t('saveError')}${cause instanceof Error ? cause.message : String(cause)}` })
    } finally {
      setBusy(null)
    }
  }, [address, bytes, collect, marks, pdf, seat, t])

  // --- render ---------------------------------------------------------------

  const total = allMarks(marks).length
  const surface: PageBitmap | null = bitmap
  return (
    <div className="da-pdf" ref={attachHost}>
      <div className="da-toolbar">
        {/* Navigation belongs to the document: one page at a time, and the page
            number is what every surface's marks are keyed by. */}
        <button type="button" className="da-btn" disabled={page <= 1}
          onClick={() => { goTo(page - 1) }}>{t('previousPage')}</button>
        <span className="da-page">{`${page} / ${pageCount}`}</span>
        <button type="button" className="da-btn" disabled={page >= pageCount}
          onClick={() => { goTo(page + 1) }}>{t('nextPage')}</button>
        <span className="da-spacer" />
        <span className="da-page">{t('documentScope', { pages: pageCount, marks: total })}</span>
        <button type="button" className="da-btn" disabled={busy !== null}
          onClick={() => { void run(false) }}>{t('save')}</button>
        <button type="button" className="da-btn" disabled={busy !== null}
          onClick={() => { void run(true) }}>{t('saveAndSend')}</button>
      </div>
      {stale ? <div className="da-status" data-tone="error">{t('stale')}</div> : null}
      {status === null ? null : <div className="da-status" data-tone={status.tone === 'info' ? undefined : status.tone}>{status.text}</div>}
      {error !== null ? (
        <p className="da-hint" role="alert">{`${t('pdfOpenFailed')}${error}`}</p>
      ) : surface === null ? (
        <p className="da-hint">{t('pdfRendering')}</p>
      ) : (
        <AnnotatorBody
          // Each page is its own surface with its own undo history, so switching
          // pages mounts a fresh body seeded from that page's marks.
          key={page}
          resourceAddress={props.resourceAddress}
          scrollportRef={props.scrollportRef}
          t={t}
          content={undefined}
          page={surface}
          draft={{ marks: marks.get(page) ?? [] }}
          onDraftChange={reportDraft}
          summary={summary}
          onSummaryChange={setSummary}
          mode={mode}
          onModeChange={setMode}
        />
      )}
    </div>
  )
}

/**
 * Render one page for the pane.
 * @param pdf - the open document.
 * @param page - 1-based page number.
 * @param paneWidth - pane width in CSS pixels.
 * @returns the page bitmap.
 */
async function renderPage(pdf: PdfDocument, page: number, paneWidth: number): Promise<PageBitmap> {
  const size = await pdf.size(page)
  // Render at the scale the pane will show, times the display density, so
  // fit width is crisp without asking the parser for pixels CSS discards.
  const fit = Math.max(0.1, (paneWidth - PANE_INSET) / size.width)
  const density = Math.min(MAX_DENSITY, globalThis.devicePixelRatio || 1)
  const rendered = await pdf.render(page, fit * density)
  return { dataUrl: rendered.dataUrl, width: rendered.width, height: rendered.height }
}

/**
 * Render one annotated page for the session.
 *
 * The picture the agent reads is not the pane's: the pane may be narrow, while the
 * export draws the marks onto the page at up to twice the page's own size. A raster
 * at that same factor is the smallest one that keeps the delivered picture sharp.
 *
 * @param pdf - the open document.
 * @param page - 1-based page number.
 * @returns the page bitmap.
 */
async function renderReviewPage(pdf: PdfDocument, page: number): Promise<PageBitmap> {
  const rendered = await pdf.render(page, MAX_DENSITY)
  return { dataUrl: rendered.dataUrl, width: rendered.width, height: rendered.height }
}

/**
 * Build the writer's input for every marked page.
 * @param pdf - the open document.
 * @param pages - the marked pages.
 * @returns one input per page, each with its marks and its user-space transform.
 */
async function annotateInputs(pdf: PdfDocument, pages: readonly MarkedPage[]): Promise<PageAnnotateInput[]> {
  const inputs: PageAnnotateInput[] = []
  for (const entry of pages) {
    const size = await pdf.size(entry.page)
    inputs.push({ page: entry.page, transform: size.transform, marks: entry.marks })
  }
  return inputs
}

/**
 * Render the annotated pages for the session.
 * @param pdf - the open document.
 * @param pages - the marked pages.
 * @returns one raster per page, in page order.
 */
async function reviewPages(pdf: PdfDocument, pages: readonly MarkedPage[]): Promise<PageImage[]> {
  const images: PageImage[] = []
  for (const entry of pages) {
    const rendered = await renderReviewPage(pdf, entry.page)
    images.push({ page: entry.page, dataUrl: rendered.dataUrl, width: rendered.width, height: rendered.height })
  }
  return images
}
