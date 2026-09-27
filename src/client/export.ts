/**
 * Composing the flattened review image.
 *
 * The reviewed picture is the figure plus every mark, built as one standalone SVG
 * (no external references, system fonts only) and rasterized through a canvas, so
 * the agent receives exactly the picture the user approved.
 * @module dsh-annotator/client/export
 */

import type { AnnotationMark } from '../shared/annotation'
import { MARK_FONT_STACK, STROKE_WIDTH, TEXT_FONT_SIZE, markPathData, textMarkBox } from './render'

/** The figure layer placed under the marks. */
export type FigureLayer =
  | {
    /** Vector figure: sanitized SVG markup inlined into the review image. */
    readonly kind: 'svg'
    /** Sanitized SVG markup. */
    readonly markup: string
    /** The figure's own `viewBox`, when it declares one. */
    readonly viewBox?: string
    /** Intrinsic width in figure pixels. */
    readonly width: number
    /** Intrinsic height in figure pixels. */
    readonly height: number
  }
  | {
    /** Raster figure: a data URL embedded as an `<image>`. */
    readonly kind: 'raster'
    /** `data:` URL of the figure bytes. */
    readonly dataUrl: string
    /** Intrinsic width in figure pixels. */
    readonly width: number
    /** Intrinsic height in figure pixels. */
    readonly height: number
  }

/** Escape text for use inside XML character data. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Render one mark as SVG elements, with a white halo so it reads over black line work. */
function markSvg(mark: AnnotationMark): string {
  const path = markPathData(mark)
  const font = escapeXml(MARK_FONT_STACK)
  const parts: string[] = []
  if (path !== undefined) {
    parts.push(
      `<path d="${path}" fill="none" stroke="#ffffff" stroke-width="${STROKE_WIDTH + 2.5}"`
      + ' stroke-linecap="round" stroke-linejoin="round"/>',
      `<path d="${path}" fill="none" stroke="${mark.color}" stroke-width="${STROKE_WIDTH}"`
      + ' stroke-linecap="round" stroke-linejoin="round"/>',
    )
  }
  const box = textMarkBox(mark)
  if (box !== undefined) {
    parts.push(
      `<rect x="${box.x - 4}" y="${box.y - TEXT_FONT_SIZE}" width="${box.width}" height="${box.height}"`
      + ` rx="3" fill="#ffffff" stroke="${mark.color}" stroke-width="1"/>`,
      `<text x="${box.x}" y="${box.y}" font-family="${font}" font-size="${TEXT_FONT_SIZE}"`
      + ` fill="${mark.color}">${escapeXml(box.text)}</text>`,
    )
  }
  return parts.join('')
}

/** The figure layer as SVG elements. */
function figureSvg(layer: FigureLayer): string {
  if (layer.kind === 'raster') {
    return `<image x="0" y="0" width="${layer.width}" height="${layer.height}" href="${layer.dataUrl}"/>`
  }
  const viewBox = layer.viewBox === undefined ? '' : ` viewBox="${layer.viewBox}"`
  const inner = layer.markup.replace(/^<\?xml[^>]*\?>\s*/u, '').replace(/^<svg[^>]*>/iu, '').replace(/<\/svg>\s*$/iu, '')
  return `<svg x="0" y="0" width="${layer.width}" height="${layer.height}"${viewBox}`
    + ` preserveAspectRatio="xMidYMid meet">${inner}</svg>`
}

/**
 * Encode bytes as a `data:` URL.
 *
 * The export path needs this rather than an object URL: an SVG loaded into an
 * `<img>` cannot resolve a `blob:` reference, so a blob URL would make the whole
 * review image undecodable.
 * @param bytes - file bytes.
 * @param mediaType - the bytes' media type.
 * @returns the data URL.
 */
export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return `data:${mediaType};base64,${btoa(binary)}`
}

/**
 * Build the standalone review SVG.
 * @param layer - the figure to place underneath.
 * @param marks - marks in draw order.
 * @returns complete SVG markup.
 */
export function composeReviewSvg(layer: FigureLayer, marks: readonly AnnotationMark[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${layer.width}" height="${layer.height}" viewBox="0 0 ${layer.width} ${layer.height}">`
    + `<rect x="0" y="0" width="${layer.width}" height="${layer.height}" fill="#ffffff"/>`
    + figureSvg(layer)
    + marks.map(markSvg).join('')
    + '</svg>'
}

/**
 * Rasterize one review SVG to PNG bytes.
 * @param svg - standalone SVG markup.
 * @param width - output width in pixels.
 * @param height - output height in pixels.
 * @param scale - device scale applied to the output size.
 * @returns the PNG blob.
 * @throws {Error} when the SVG cannot be decoded into an image.
 */
export async function rasterizePng(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve() }
      image.onerror = () => { reject(new Error('the composed review image could not be decoded')) }
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('a 2D canvas is unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => { canvas.toBlob(resolve, 'image/png') })
    if (blob === null) throw new Error('the review image could not be encoded as PNG')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}
