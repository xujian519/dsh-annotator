/**
 * The drawing surface.
 *
 * It renders the marks over the figure and turns pointer input into marks. Every
 * shape is committed as a mark the parent owns; the component keeps only the mark
 * currently being drawn. Coordinates are always figure pixels, so the same mark
 * means the same thing at any zoom or pane width.
 * @module dsh-annotator/client/Canvas
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { AnnotationMark, FigurePoint, MarkAnchor } from '../shared/annotation'
import { anchorAtPoint } from './figure-dom'
import { MARK_FONT_STACK, STROKE_WIDTH, TEXT_FONT_SIZE, markPathData, textMarkBox } from './render'

/** Tools the toolbar can activate. */
export type Tool = 'select' | 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text'

/** Hit width of an invisible selection stroke, in figure pixels. */
const HIT_WIDTH = 14

/** Minimum distance between recorded freehand samples, in figure pixels. */
const PEN_SAMPLE_STEP = 3

/** Props of the drawing surface. */
export interface CanvasProps {
  /** Figure width in pixels. */
  readonly width: number
  /** Figure height in pixels. */
  readonly height: number
  /** Committed marks, in draw order. */
  readonly marks: readonly AnnotationMark[]
  /** Active tool. */
  readonly tool: Tool
  /** Stroke color for new marks. */
  readonly color: string
  /** Container that holds the figure, used as the anchor hit-test origin. */
  readonly containerRef: RefObject<HTMLElement | null>
  /** Whether the figure is inlined SVG (only then can marks anchor to elements). */
  readonly anchoring: boolean
  /**
   * Name the element one figure point landed on, for a surface whose elements
   * live in a document of their own. Present exactly when {@link anchoring} is
   * absent in spirit: the two describe the same question for two kinds of
   * surface, and only one of them can be answered for any given figure.
   */
  readonly anchorAtFigurePoint?: ((x: number, y: number) => MarkAnchor | undefined) | undefined
  /** Currently selected mark. */
  readonly selectedId: string | null
  /** Select one mark, or clear the selection. */
  readonly onSelect: (id: string | null) => void
  /** Commit a finished mark. */
  readonly onAdd: (mark: AnnotationMark) => void
  /** Remove one mark. */
  readonly onRemove: (id: string) => void
}

/** Monotonic id source for marks created in this session. */
let markSeq = 0

/**
 * Mint a mark id.
 * @returns an id unique within the loaded document.
 */
export function nextMarkId(): string {
  markSeq += 1
  return `m${Date.now().toString(36)}-${markSeq}`
}

/**
 * Draw the marks and collect pointer input.
 * @param props - figure geometry, marks, tool state, and callbacks.
 * @returns the overlay element.
 */
export function Canvas(props: CanvasProps): ReactNode {
  const { width, height, marks, tool, color, containerRef, anchoring } = props
  const [draft, setDraft] = useState<AnnotationMark | null>(null)
  const drawing = useRef(false)

  /** Convert one pointer event to figure pixels. */
  const toFigure = (event: ReactPointerEvent<SVGSVGElement>): FigurePoint => {
    // The handler is bound to the surface itself, so `currentTarget` is always
    // the element whose box the coordinates are measured in.
    const rect = event.currentTarget.getBoundingClientRect()
    // A collapsed pane reports a zero-size box; treating it as 1:1 keeps a drag
    // from committing infinite coordinates.
    const scaleX = rect.width === 0 ? 1 : width / rect.width
    const scaleY = rect.height === 0 ? 1 : height / rect.height
    return [
      (event.clientX - rect.left) * scaleX,
      (event.clientY - rect.top) * scaleY,
    ]
  }

  /**
   * Describe what the mark landed on.
   *
   * A rendered document reports its elements in its own layout pixels, which are
   * the figure units already, so it names them from the point. An inline SVG is
   * hit-tested against client coordinates instead, because its elements live in
   * the same document as this overlay and their boxes are the browser's own.
   */
  const anchorFor = (event: ReactPointerEvent<SVGSVGElement>, point: FigurePoint): MarkAnchor | undefined => {
    if (props.anchorAtFigurePoint !== undefined) return props.anchorAtFigurePoint(point[0], point[1])
    const container = containerRef.current
    if (!anchoring || container === null) return undefined
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    return anchorAtPoint(container, event.clientX, event.clientY, width / rect.width, height / rect.height)
  }

  const start = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (tool === 'select') return
    event.preventDefault()
    const point = toFigure(event)
    if (tool === 'text') {
      const mark: AnnotationMark = {
        id: nextMarkId(),
        kind: 'text',
        color,
        points: [point],
        text: '',
      }
      props.onAdd(mark)
      props.onSelect(mark.id)
      return
    }
    drawing.current = true
    if (typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId !== undefined) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    // A drag-shaped mark needs its two corners from the start; a freehand stroke
    // starts as the single sample it is, so no duplicate point enters the path.
    const seed: FigurePoint[] = tool === 'pen' ? [point] : [point, point]
    setDraft({ id: nextMarkId(), kind: tool, color, points: seed })
  }

  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drawing.current || draft === null) return
    const point = toFigure(event)
    if (draft.kind === 'pen') {
      const last = draft.points[draft.points.length - 1]
      if (last !== undefined && Math.hypot(point[0] - last[0], point[1] - last[1]) < PEN_SAMPLE_STEP) return
      setDraft({ ...draft, points: [...draft.points, point] })
      return
    }
    setDraft({ ...draft, points: [draft.points[0] as FigurePoint, point] })
  }

  const finish = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drawing.current || draft === null) return
    drawing.current = false
    if (typeof event.currentTarget.hasPointerCapture === 'function'
      && event.pointerId !== undefined
      && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDraft(null)
    if (draft.points.length < 2) return
    // The length check above already guarantees both endpoints; indexing is the
    // only way to read them without a second, unreachable guard.
    const first = draft.points[0] as FigurePoint
    const last = draft.points[draft.points.length - 1] as FigurePoint
    if (draft.kind !== 'pen' && Math.hypot(last[0] - first[0], last[1] - first[1]) < 4) return
    const anchor = anchorFor(event, last)
    const mark: AnnotationMark = { ...draft, ...(anchor === undefined ? {} : { anchor }) }
    props.onAdd(mark)
    // Selecting the new mark puts the note box on it, so the sentence that makes
    // the mark actionable can be typed without a second gesture.
    props.onSelect(mark.id)
  }

  const renderMark = (mark: AnnotationMark, isDraft: boolean): ReactNode => {
    const path = markPathData(mark)
    const box = textMarkBox(mark)
    const selected = props.selectedId === mark.id
    return (
      <g key={mark.id} opacity={isDraft ? 0.75 : 1}>
        {path === undefined ? null : (
          <>
            <path d={path} fill="none" stroke="#ffffff" strokeWidth={STROKE_WIDTH + 2.5}
              strokeLinecap="round" strokeLinejoin="round" />
            <path d={path} fill="none" stroke={mark.color} strokeWidth={STROKE_WIDTH}
              strokeLinecap="round" strokeLinejoin="round" />
            {isDraft ? null : (
              <path d={path} fill="none" stroke="transparent" strokeWidth={HIT_WIDTH}
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onPointerDown={(event) => { event.stopPropagation(); props.onSelect(mark.id) }}
                onDoubleClick={(event) => { event.stopPropagation(); props.onRemove(mark.id) }} />
            )}
            {selected ? (
              <path d={path} fill="none" stroke="#4c8dff" strokeWidth={1} strokeDasharray="4 3" />
            ) : null}
          </>
        )}
        {box === undefined ? null : (
          <>
            <rect x={box.x - 4} y={box.y - TEXT_FONT_SIZE} width={box.width} height={box.height} rx={3}
              fill="#ffffff" stroke={mark.color} strokeWidth={1} />
            <text x={box.x} y={box.y} fontFamily={MARK_FONT_STACK} fontSize={TEXT_FONT_SIZE} fill={mark.color}>
              {box.text}
            </text>
            {/* No draft guard here: a box needs a label, and a draft has none. */}
            <rect x={box.x - 6} y={box.y - TEXT_FONT_SIZE - 2} width={box.width + 4} height={box.height + 4}
              fill="transparent" style={{ pointerEvents: 'all', cursor: 'pointer' }}
              onPointerDown={(event) => { event.stopPropagation(); props.onSelect(mark.id) }}
              onDoubleClick={(event) => { event.stopPropagation(); props.onRemove(mark.id) }} />
            {selected ? (
              <rect x={box.x - 6} y={box.y - TEXT_FONT_SIZE - 2} width={box.width + 4} height={box.height + 4}
                fill="none" stroke="#4c8dff" strokeWidth={1} strokeDasharray="4 3" />
            ) : null}
          </>
        )}
      </g>
    )
  }

  return (
    <svg
      className="da-overlay"
      data-da-overlay=""
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-tool={tool}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={() => { if (tool === 'select') props.onSelect(null) }}
    >
      {marks.map(mark => renderMark(mark, false))}
      {draft === null ? null : renderMark(draft, true)}
    </svg>
  )
}
