/**
 * The document body: one figure with an optional annotation layer.
 *
 * It reads the figure's bytes from the document preview owner (so the plugin
 * never reads files itself), renders them, and hands finished marks to the Host
 * half for storage before delivering them to the agent as a user message.
 * @module dsh-annotator/client/AnnotatorBody
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { parseFileAddress } from '../shared/address'
import type { AnnotationDocument, AnnotationMark } from '../shared/annotation'
import { ANNOTATION_VERSION } from '../shared/annotation'
import { figureMediaType } from '../shared/figure-kind'
import { Canvas, type Tool } from './Canvas'
import { composeReviewSvg, rasterizePng, bytesToDataUrl, type FigureLayer } from './export'
import { figureSvgMarkup, parseFigureSvg, svgIntrinsicSize, svgViewBox } from './figure-dom'
import { AnnotatorHostError, loadAnnotation, saveAnnotation, type LoadedAnnotation } from './host-api'
import { NAMESPACE, fallbackTranslate } from './locales'
import { MARK_FONT_STACK, markPathData, textMarkBox } from './render'
import { deliverAnnotation, type SessionsLike } from './session'
import { ensureStyles } from './styles'

/** Bytes-or-nothing content the document owner delivers. */
export interface BodyContent {
  /** Kind of content the owner produced. */
  readonly kind: string
  /** Complete file bytes, for a `bytes-complete` renderer. */
  readonly data?: Uint8Array<ArrayBuffer>
}

/** Values interpolated into one copy string. */
export type TranslateVars = Record<string, number | string>

/** The translator seat: a copy key and its interpolation values. */
export type Translate = (key: string, vars?: TranslateVars) => string

/** The props any annotator body receives from its slot's inject factory. */
export interface AnnotatorInjected {
  /** Injected session delivery face. */
  readonly sessions: SessionsLike | undefined
  /** Session this body belongs to, passed by the inject factory. */
  readonly sessionId: string
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId: string
}

/**
 * The page a paged renderer put on screen, as this body annotates it.
 *
 * The body annotates this raster instead of the file's own bytes: the renderer
 * that owns the document decides which page is on screen and at what resolution,
 * and keeps the other pages' edits while this one is mounted. Marks are recorded
 * in page units, so they mean the same thing at any zoom or pane width — and a
 * body with a page is one page of a document, not the document itself, so it
 * neither reads nor writes the sidecar: its owner does, once, for the whole file.
 */
export interface PageSurface {
  /** PNG data URL of the page. */
  readonly dataUrl: string
  /** Page width in page units. */
  readonly width: number
  /** Page height in page units. */
  readonly height: number
}

/** Unsaved edits of one surface, as an owner that unmounts surfaces keeps them. */
export interface SurfaceDraft {
  /** Marks drawn so far. */
  readonly marks: readonly AnnotationMark[]
}

/** Everything the body reads; all of it arrives through the composed props. */
export interface AnnotatorBodyProps {
  /** Document content: complete bytes for a `bytes-complete` renderer. */
  readonly content?: BodyContent | undefined
  /** The page a paged renderer put on screen, when this body annotates one page. */
  readonly page?: PageSurface | undefined
  /** Marks this surface had before it mounted; a saved document still wins over them. */
  readonly draft?: SurfaceDraft | undefined
  /** Reports every edit, so an owner that unmounts surfaces loses no unsaved work. */
  readonly onDraftChange?: ((draft: SurfaceDraft) => void) | undefined
  /** Overall note, when an owner keeps it for the whole document. */
  readonly summary?: string | undefined
  /** Reports every change of the overall note. */
  readonly onSummaryChange?: ((summary: string) => void) | undefined
  /** Viewing or annotating, when an owner keeps the choice across its surfaces. */
  readonly mode?: 'view' | 'annotate' | undefined
  /** Reports every change of that choice. */
  readonly onModeChange?: ((mode: 'view' | 'annotate') => void) | undefined
  /** The tab's `dsh-resource://file/…` address. */
  readonly resourceAddress?: string | undefined
  /** Owner callback that registers the body's scrollport. */
  readonly scrollportRef?: ((element: HTMLElement | null) => void) | undefined
  /** Locale seat bound by the shell when the namespace is registered. */
  readonly t?: Translate | undefined
  /** Injected session delivery face. */
  readonly sessions?: SessionsLike | undefined
  /** Session this body belongs to, passed by the inject factory. */
  readonly sessionId?: string | undefined
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId?: string | undefined
}

/** Palette offered by the toolbar. */
const COLORS = ['#e03131', '#1971c2', '#f08c00', '#2f9e44'] as const

/**
 * The figure once its bytes are readable.
 *
 * One value rather than four pieces of state: a raster's own size only arrives
 * when the browser decodes it, and spread across separate `useState` calls that
 * produced combinations (a size with no layer, a URL with no bytes) the rest of
 * the component would have to defend against.
 */
type LoadedFigure =
  | {
    readonly kind: 'svg'
    readonly width: number
    readonly height: number
    /** Sanitized markup, already sized and classed for both panel and export. */
    readonly markup: string
    /** The `viewBox` the export renders under. */
    readonly viewBox: string
  }
  | {
    readonly kind: 'raster'
    /** Object URL the `<img>` reads, owned until the effect is torn down. */
    readonly objectUrl: string
    /** `data:` URL the export embeds, which an object URL could not be. */
    readonly dataUrl: string
  }

/** Tools in toolbar order. */
const TOOLS: readonly { readonly tool: Tool; readonly label: string }[] = [
  { tool: 'select', label: 'toolSelect' },
  { tool: 'arrow', label: 'toolArrow' },
  { tool: 'rect', label: 'toolRect' },
  { tool: 'ellipse', label: 'toolEllipse' },
  { tool: 'pen', label: 'toolPen' },
  { tool: 'text', label: 'toolText' },
]

/** Render one mark as the overlay preview used inside the marks list. */
function markGlyph(mark: AnnotationMark): ReactNode {
  const path = markPathData(mark)
  const box = textMarkBox(mark)
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" aria-hidden="true">
      {path === undefined ? null : (
        <path
          d={path}
          fill="none"
          stroke={mark.color}
          strokeWidth={3}
          transform={`scale(${mark.kind === 'pen' ? 1 : 0.6})`}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {box === undefined ? null : (
        <text x={2} y={12} fontSize={11} fill={mark.color} fontFamily={MARK_FONT_STACK}>T</text>
      )}
    </svg>
  )
}

/**
 * Render one figure with its annotation layer.
 * @param props - document content, addressed resource, locale seat, and session delivery face.
 * @returns the annotator body.
 */
export function AnnotatorBody(props: AnnotatorBodyProps): ReactNode {
  const address = props.resourceAddress ?? ''
  // One parser for both halves: it already tolerates malformed escapes, which a
  // hand-rolled `decodeURIComponent` here would throw on.
  const parsedAddress = parseFileAddress(address)
  const mediaType = figureMediaType(parsedAddress?.path ?? '')
  const isVector = mediaType === 'image/svg+xml'
  const t = useCallback(
    (key: string): string => props.t?.(key) ?? fallbackTranslate(props.localeId ?? 'zh', key),
    [props.t, props.localeId],
  )
  const sessionId = props.sessionId ?? parsedAddress?.sessionId

  const stageRef = useRef<HTMLDivElement | null>(null)
  const figureHostRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [fileFigure, setFileFigure] = useState<LoadedFigure | null>(null)
  const [fileRasterSize, setFileRasterSize] = useState<{ readonly width: number; readonly height: number } | null>(null)
  const [figureError, setFigureError] = useState<string | null>(null)

  /**
   * The surface being annotated: the page a paged renderer supplied, else the
   * file's own figure. One value either way, so everything below reads one shape.
   */
  const surface = props.page
  /** Whether this body annotates one page of a document its owner persists. */
  const isPage = surface !== undefined
  const figure: LoadedFigure | null = surface === undefined
    ? fileFigure
    : { kind: 'raster', objectUrl: surface.dataUrl, dataUrl: surface.dataUrl }
  const rasterSize = surface === undefined
    ? fileRasterSize
    : { width: surface.width, height: surface.height }

  const [loaded, setLoaded] = useState<LoadedAnnotation | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  /**
   * Whether the surface is being drawn on. An owner that unmounts surfaces keeps
   * the choice (and takes every change back), so paging through a document does
   * not put the reader back into viewing mode on every page.
   */
  const [ownMode, setOwnMode] = useState<'view' | 'annotate'>('view')
  const mode = props.mode ?? ownMode
  const chooseMode = props.onModeChange ?? setOwnMode
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState<string>(COLORS[0])
  const [marks, setMarks] = useState<AnnotationMark[]>(() => [...(props.draft?.marks ?? [])])
  const [past, setPast] = useState<AnnotationMark[][]>([])
  const [future, setFuture] = useState<AnnotationMark[][]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * The overall note. An owner that keeps one for a whole document supplies it
   * (and takes every change back); on its own the body owns it, as it does for a
   * single-surface figure.
   */
  const [ownSummary, setOwnSummary] = useState('')
  const summary = props.summary ?? ownSummary
  const writeSummary = props.onSummaryChange ?? setOwnSummary
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [fitWidth, setFitWidth] = useState(0)
  const [busy, setBusy] = useState<'saving' | 'sending' | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)

  useEffect(() => { ensureStyles(document) }, [])

  const data = props.content?.kind === 'bytes' ? props.content.data : undefined

  const layer = useMemo((): FigureLayer | null => {
    if (figure === null) return null
    if (figure.kind === 'svg') {
      return {
        kind: 'svg',
        markup: figure.markup,
        width: figure.width,
        height: figure.height,
        viewBox: figure.viewBox,
      }
    }
    // A raster has no size until the browser has decoded it.
    if (rasterSize === null) return null
    return { kind: 'raster', dataUrl: figure.dataUrl, width: rasterSize.width, height: rasterSize.height }
  }, [figure, rasterSize])

  /** The figure's measurable size; null until its bytes and dimensions are both known. */
  const size = layer === null ? null : { width: layer.width, height: layer.height }

  // --- figure loading -------------------------------------------------------

  useEffect(() => {
    // A page surface arrives rendered, so the file's bytes are not this body's
    // to decode: decoding them here would fight the renderer that owns them.
    if (surface !== undefined) return
    if (data === undefined || mediaType === undefined) return
    if (mediaType === 'image/svg+xml') {
      const root = parseFigureSvg(new TextDecoder().decode(data))
      if (root === undefined) {
        setFigureError(t('loadFailed'))
        return
      }
      const intrinsic = svgIntrinsicSize(root)
      // The size and the panel class are baked into the markup, so the string
      // the panel inlines and the string the export embeds are the same one.
      root.setAttribute('width', String(intrinsic.width))
      root.setAttribute('height', String(intrinsic.height))
      root.classList.add('da-figure')
      setFileFigure({
        kind: 'svg',
        width: intrinsic.width,
        height: intrinsic.height,
        markup: figureSvgMarkup(root),
        viewBox: svgViewBox(root, intrinsic),
      })
      return
    }
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mediaType }))
    setFileRasterSize(null)
    setFileFigure({ kind: 'raster', objectUrl, dataUrl: bytesToDataUrl(data, mediaType) })
    return () => { URL.revokeObjectURL(objectUrl) }
  }, [data, mediaType, surface, t])

  // --- host annotation ------------------------------------------------------

  useEffect(() => {
    // A page body is one page of a document its owner persists, and the owner has
    // already read the whole sidecar: reading it here would put every page's marks
    // on the page on screen.
    if (isPage) return
    if (address === '' || mediaType === undefined) return
    const controller = new AbortController()
    void (async () => {
      try {
        const result = await loadAnnotation(address, controller.signal)
        if (controller.signal.aborted) return
        setLoaded(result)
        setHostError(null)
        if (result.annotation !== null) {
          setMarks([...result.annotation.marks])
          writeSummary(result.annotation.summary ?? '')
          setCreatedAt(result.annotation.createdAt)
          setStale(result.annotation.figure.sha256 !== result.sha256)
          if (result.annotation.marks.length > 0) chooseMode('annotate')
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setHostError(error instanceof AnnotatorHostError ? error.message : String(error))
      }
    })()
    return () => { controller.abort() }
  }, [address, chooseMode, isPage, mediaType, writeSummary])

  // --- fit width ------------------------------------------------------------

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const measure = (): void => { setFitWidth(stage.clientWidth - 24) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => { observer.disconnect() }
  }, [])

  const scale = useMemo(() => {
    if (size === null) return 1
    if (zoom !== 'fit') return zoom
    if (fitWidth <= 0) return 1
    return Math.min(1.5, Math.max(0.05, fitWidth / size.width))
  }, [zoom, fitWidth, size])

  // --- edits ----------------------------------------------------------------

  const commit = useCallback((next: AnnotationMark[]): void => {
    setPast(history => [...history, marks].slice(-50))
    setFuture([])
    setMarks(next)
  }, [marks])

  const addMark = useCallback((mark: AnnotationMark): void => { commit([...marks, mark]) }, [commit, marks])

  const removeMark = useCallback((id: string): void => {
    commit(marks.filter(mark => mark.id !== id))
    setSelectedId(current => (current === id ? null : current))
  }, [commit, marks])

  const setMarkText = useCallback((id: string, text: string): void => {
    setMarks(current => current.map(mark => (mark.id === id ? { ...mark, text } : mark)))
  }, [])

  const undo = useCallback((): void => {
    setPast(history => {
      const previous = history[history.length - 1]
      if (previous === undefined) return history
      setFuture(futureState => [marks, ...futureState].slice(0, 50))
      setMarks(previous)
      return history.slice(0, -1)
    })
  }, [marks])

  const redo = useCallback((): void => {
    setFuture(futureState => {
      const next = futureState[0]
      if (next === undefined) return futureState
      setPast(history => [...history, marks].slice(-50))
      setMarks(next)
      return futureState.slice(1)
    })
  }, [marks])

  /**
   * Report every edit upward, so an owner that unmounts this surface (a page
   * change) can hand the unsaved work back when the surface returns.
   */
  useEffect(() => { props.onDraftChange?.({ marks }) }, [marks, props.onDraftChange])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'z' && event.key !== 'Z') return
      if (!(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [undo, redo])

  // --- export and delivery --------------------------------------------------

  const exportPng = useCallback(async (target: FigureLayer): Promise<Blob> => {
    const svg = composeReviewSvg(target, marks)
    const exportScale = Math.min(2, Math.max(1, 2400 / Math.max(target.width, target.height)))
    return await rasterizePng(svg, target.width, target.height, exportScale)
  }, [marks])

  const buildDocument = useCallback((target: FigureLayer): AnnotationDocument | null => {
    if (loaded === null) return null
    const now = new Date().toISOString()
    return {
      version: ANNOTATION_VERSION,
      figure: {
        address,
        path: loaded.path,
        mediaType: loaded.mediaType,
        width: target.width,
        height: target.height,
        sha256: loaded.sha256,
      },
      createdAt: createdAt ?? now,
      updatedAt: now,
      marks,
      ...(summary.trim() === '' ? {} : { summary: summary.trim() }),
    }
  }, [address, createdAt, loaded, marks, summary])

  const run = useCallback(async (deliver: boolean): Promise<void> => {
    // The only enforcement point: the toolbar buttons stay clickable so this
    // guard is what decides, not a disabled attribute that hides the reason.
    if (marks.length === 0 || layer === null) return
    setBusy(deliver ? 'sending' : 'saving')
    setStatus({ tone: 'info', text: t(deliver ? 'sending' : 'saving') })
    try {
      const review = await exportPng(layer)
      const document_ = buildDocument(layer)
      if (document_ === null) throw new Error(t('loadFailed'))
      const saved = await saveAnnotation(address, document_, review)
      setCreatedAt(document_.createdAt)
      setStale(false)
      if (!deliver) {
        setStatus({ tone: 'ok', text: `${t('saved')}${saved.annotationPath}` })
        return
      }
      if (props.sessions === undefined) throw new Error('the sessions service is unavailable')
      if (sessionId === undefined) throw new Error('the figure address carries no session')
      await deliverAnnotation({
        sessions: props.sessions,
        // A single-surface figure is reviewed as the picture it is, which travels
        // as an image part and not as an attached file.
        fileUpload: undefined,
        sessionId,
        document: document_,
        paths: saved,
        pageImages: [{ page: 1, image: review }],
        annotatedPdf: undefined,
        locale: (props.localeId ?? 'zh').startsWith('en') ? 'en' : 'zh',
      })
      setStatus({ tone: 'ok', text: `${t('sent')}${saved.annotationPath}` })
    } catch (error) {
      setStatus({ tone: 'error', text: `${t('saveError')}${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(null)
    }
  }, [address, buildDocument, exportPng, layer, marks.length, props.localeId, props.sessions, sessionId, t])

  // --- render ---------------------------------------------------------------

  if (mediaType === undefined) return <p className="da-hint">{t('unsupported')}</p>
  if (data === undefined && surface === undefined) return <p className="da-hint">{t('loading')}</p>
  if (figureError !== null) return <p className="da-hint" role="alert">{figureError}</p>

  const selected = marks.find(mark => mark.id === selectedId) ?? null
  const surfaceStyle: CSSProperties = size === null
    ? {}
    : { width: size.width * scale, height: size.height * scale }
  const figureStyle: CSSProperties = size === null
    ? {}
    : { width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: 'top left' }

  return (
    <div className="da-root">
      <div className="da-toolbar">
        <button type="button" className="da-btn" aria-pressed={mode === 'view'}
          onClick={() => { chooseMode('view') }}>{t('view')}</button>
        <button type="button" className="da-btn" aria-pressed={mode === 'annotate'}
          onClick={() => { chooseMode('annotate') }}>{t('annotate')}</button>
        <span className="da-spacer" />
        {mode === 'annotate' ? (
          <>
            {TOOLS.map(entry => (
              <button key={entry.tool} type="button" className="da-btn" aria-pressed={tool === entry.tool}
                onClick={() => { setTool(entry.tool) }}>{t(entry.label)}</button>
            ))}
            {COLORS.map(value => (
              <button key={value} type="button" className="da-swatch" aria-pressed={color === value}
                style={{ background: value }} aria-label={value}
                onClick={() => { setColor(value) }} />
            ))}
            {/* The keyboard reaches undo and redo whatever the buttons show, so
                the disabled state is an affordance and the guards behind the
                handlers are what actually decide. */}
            <button type="button" className="da-btn" disabled={past.length === 0} onClick={undo}>{t('undo')}</button>
            <button type="button" className="da-btn" disabled={future.length === 0} onClick={redo}>{t('redo')}</button>
            <button type="button" className="da-btn" disabled={marks.length === 0}
              onClick={() => { commit([]) }}>{t('clear')}</button>
          </>
        ) : null}
        <button type="button" className="da-btn" aria-pressed={zoom === 'fit'}
          onClick={() => { setZoom('fit') }}>{t('fitWidth')}</button>
        <button type="button" className="da-btn" aria-pressed={zoom === 1}
          onClick={() => { setZoom(1) }}>{t('actual')}</button>
        <button type="button" className="da-btn" onClick={() => { setZoom(current => Math.max(0.1, (current === 'fit' ? scale : current) / 1.25)) }}>{t('zoomOut')}</button>
        <button type="button" className="da-btn" onClick={() => { setZoom(current => Math.min(6, (current === 'fit' ? scale : current) * 1.25)) }}>{t('zoomIn')}</button>
        <span className="da-spacer" />
        {/* One page of a document is not the document: the owner that keeps every
            page's marks is the one that saves and sends. */}
        {isPage ? null : (
          <>
            <button type="button" className="da-btn" disabled={busy !== null}
              onClick={() => { void run(false) }}>{t('save')}</button>
            <button type="button" className="da-btn" disabled={busy !== null}
              onClick={() => { void run(true) }}>{t('saveAndSend')}</button>
          </>
        )}
      </div>

      {hostError === null ? null : <div className="da-status" data-tone="error">{`${t('readError')}${hostError}`}</div>}
      {stale ? <div className="da-status" data-tone="error">{t('stale')}</div> : null}
      {status === null ? null : <div className="da-status" data-tone={status.tone === 'info' ? undefined : status.tone}>{status.text}</div>}

      <div className="da-stage" ref={(element) => { stageRef.current = element; props.scrollportRef?.(element) }}>
        <div className="da-surface" ref={surfaceRef} style={surfaceStyle}>
          <div style={{ ...figureStyle, position: 'relative' }}>
            {figure?.kind === 'svg' ? (
              <div ref={figureHostRef} dangerouslySetInnerHTML={{ __html: figure.markup }} />
            ) : figure?.kind === 'raster' ? (
              <img
                className="da-figure"
                src={figure.objectUrl}
                width={size?.width}
                height={size?.height}
                alt=""
                onLoad={(event) => {
                  const image = event.currentTarget
                  setFileRasterSize({ width: image.naturalWidth, height: image.naturalHeight })
                }}
              />
            ) : null}
            {size === null ? null : (
              <Canvas
                width={size.width}
                height={size.height}
                marks={marks}
                tool={mode === 'annotate' ? tool : 'select'}
                color={color}
                containerRef={figureHostRef}
                anchoring={isVector}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAdd={addMark}
                onRemove={removeMark}
              />
            )}
          </div>
        </div>
      </div>

      {mode !== 'annotate' ? null : (
        <>
          <div className="da-note">
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12 }}>
                {selected === null ? t('note') : `${t('note')} · ${selected.kind}`}
              </span>
              <textarea
                value={selected?.text ?? ''}
                placeholder={t('notePlaceholder')}
                disabled={selected === null}
                onChange={(event) => {
                  if (selected !== null) setMarkText(selected.id, event.target.value)
                }}
              />
            </label>
            <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12 }}>{t('summary')}</span>
              <textarea value={summary} placeholder={t('summaryPlaceholder')}
                onChange={(event) => { writeSummary(event.target.value) }} />
            </label>
          </div>
          <div className="da-marks">
            <div style={{ fontSize: 11, opacity: 0.75 }}>{`${t('marks')} (${marks.length})`}</div>
            {marks.length === 0 ? <div className="da-hint">{t('noMarks')}</div> : marks.map((mark, index) => (
              <div className="da-mark" key={mark.id}>
                <span className="da-mark-index">{index + 1}</span>
                {markGlyph(mark)}
                <button type="button" className="da-mark-text"
                  style={{ background: 'transparent', border: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => { setSelectedId(mark.id) }}>
                  {mark.text !== undefined && mark.text.trim() !== '' ? mark.text : t('emptyText')}
                  {mark.anchor?.title === undefined ? '' : ` · ${t('anchor')}: ${mark.anchor.title}`}
                </button>
                <button type="button" className="da-mark-del" onClick={() => { removeMark(mark.id) }}>{t('delete')}</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Language namespace this body's copy registers under. */
export { NAMESPACE }
