/**
 * Drawing one mark as SVG primitives.
 *
 * The live overlay (React) and the exported review image (a string built for
 * rasterization) both render through these helpers, so what the user sees and
 * what the agent receives cannot drift.
 * @module dsh-annotator/client/render
 */

import type { AnnotationMark, FigurePoint, MarkKind } from '../shared/annotation'

/** Stroke width of every mark, in figure pixels. */
export const STROKE_WIDTH = 2.5

/** Font size of a text mark, in figure pixels. */
export const TEXT_FONT_SIZE = 16

/** Arrow head length, in figure pixels. */
const ARROW_HEAD = 14

/** Half-angle of the arrow head, in radians. */
const ARROW_SPREAD = Math.PI / 7

/**
 * Font stack used on the canvas and in the exported image. It carries no quotes:
 * the stack is interpolated into an SVG attribute, where a quote would end the
 * value and make the whole review image undecodable.
 */
export const MARK_FONT_STACK = 'system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif'

/** Normalize two opposite corners into a top-left origin and positive extents. */
function bounds(first: FigurePoint, second: FigurePoint): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} {
  return {
    x: Math.min(first[0], second[0]),
    y: Math.min(first[1], second[1]),
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  }
}

/** Round a coordinate for compact path data. */
function n(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

/**
 * SVG path data for one mark's stroke.
 * @param mark - the mark to render.
 * @returns path data, or undefined for a text mark (which draws as text).
 */
export function markPathData(mark: AnnotationMark): string | undefined {
  const [first, second] = mark.points
  if (first === undefined) return undefined
  switch (mark.kind) {
    case 'arrow': {
      if (second === undefined) return undefined
      const angle = Math.atan2(second[1] - first[1], second[0] - first[0])
      const left: FigurePoint = [
        second[0] - ARROW_HEAD * Math.cos(angle - ARROW_SPREAD),
        second[1] - ARROW_HEAD * Math.sin(angle - ARROW_SPREAD),
      ]
      const right: FigurePoint = [
        second[0] - ARROW_HEAD * Math.cos(angle + ARROW_SPREAD),
        second[1] - ARROW_HEAD * Math.sin(angle + ARROW_SPREAD),
      ]
      return `M ${n(first[0])} ${n(first[1])} L ${n(second[0])} ${n(second[1])}`
        + ` M ${n(left[0])} ${n(left[1])} L ${n(second[0])} ${n(second[1])}`
        + ` L ${n(right[0])} ${n(right[1])}`
    }
    case 'rect': {
      if (second === undefined) return undefined
      const box = bounds(first, second)
      return `M ${n(box.x)} ${n(box.y)} H ${n(box.x + box.width)} V ${n(box.y + box.height)} H ${n(box.x)} Z`
    }
    case 'ellipse': {
      if (second === undefined) return undefined
      const box = bounds(first, second)
      const rx = box.width / 2
      const ry = box.height / 2
      const cx = box.x + rx
      const cy = box.y + ry
      if (rx === 0 || ry === 0) return `M ${n(box.x)} ${n(box.y)} L ${n(box.x + box.width)} ${n(box.y + box.height)}`
      return `M ${n(cx - rx)} ${n(cy)} a ${n(rx)} ${n(ry)} 0 1 0 ${n(rx * 2)} 0 a ${n(rx)} ${n(ry)} 0 1 0 ${n(-rx * 2)} 0`
    }
    case 'pen': {
      // `first` is the same point the guard above already proved present.
      const segments = mark.points.slice(1).map(point => `L ${n(point[0])} ${n(point[1])}`)
      return [`M ${n(first[0])} ${n(first[1])}`, ...segments].join(' ')
    }
    case 'text':
      return undefined
  }
}

/** Where a text mark draws and what it says. */
export interface TextMarkBox {
  /** Anchor point in figure pixels. */
  readonly x: number
  readonly y: number
  /** Text as drawn (empty when the user wrote only a note). */
  readonly text: string
  /** Approximate box width, used for the legibility plate. */
  readonly width: number
  /** Box height, used for the legibility plate. */
  readonly height: number
}

/**
 * Resolve a text mark's drawn box.
 * @param mark - the text mark (falls back to the note when it holds no label).
 * @returns the box, or undefined when the mark carries neither label nor note.
 */
export function textMarkBox(mark: AnnotationMark): TextMarkBox | undefined {
  const anchor = mark.points[0]
  if (anchor === undefined) return undefined
  const text = (mark.text ?? '').trim()
  if (text === '') return undefined
  const longest = text.split('\n').reduce((widest, line) => Math.max(widest, line.length), 0)
  return {
    x: anchor[0],
    y: anchor[1],
    text,
    width: longest * TEXT_FONT_SIZE * 0.62 + 8,
    height: TEXT_FONT_SIZE * 1.35,
  }
}

/** Whether a mark draws as a stroke (so the overlay can size its hit area). */
export function isStrokeKind(kind: MarkKind): boolean {
  return kind !== 'text'
}
