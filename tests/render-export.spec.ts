/** Mark rendering, review-image composition, and figure sanitizing. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnnotationMark } from '../src/shared/annotation'
import { isStrokeKind, markPathData, textMarkBox } from '../src/client/render'
import { bytesToDataUrl, composeReviewSvg, rasterizePng } from '../src/client/export'
import { anchorAtPoint, figureSvgMarkup, parseFigureSvg, svgIntrinsicSize, svgViewBox } from '../src/client/figure-dom'
import { defined, installDom, stubRasterizer, stubRect } from './dom'

const arrow: AnnotationMark = { id: 'a', kind: 'arrow', color: '#e03131', points: [[0, 0], [10, 0]] }
const pen: AnnotationMark = { id: 'p', kind: 'pen', color: '#000', points: [[0, 0], [5, 5], [10, 0]] }

describe('mark geometry', () => {
  it('draws an arrow as a shaft plus two head strokes', () => {
    const path = markPathData(arrow)
    expect(path?.split('M').length).toBe(3)
  })

  it('normalizes opposite corners into a rectangle', () => {
    expect(markPathData({ id: 'r', kind: 'rect', color: '#000', points: [[10, 20], [30, 5]] }))
      .toBe('M 10 5 H 30 V 20 H 10 Z')
  })

  it('closes an ellipse from its bounding box', () => {
    expect(markPathData({ id: 'e', kind: 'ellipse', color: '#000', points: [[0, 0], [100, 50]] }))
      .toBe('M 0 25 a 50 25 0 1 0 100 0 a 50 25 0 1 0 -100 0')
  })

  it('degrades a zero-height ellipse to a line', () => {
    expect(markPathData({ id: 'e', kind: 'ellipse', color: '#000', points: [[0, 0], [100, 0]] }))
      .toBe('M 0 0 L 100 0')
  })

  it('draws a freehand path through every sample', () => {
    expect(markPathData(pen)).toBe('M 0 0 L 5 5 L 10 0')
  })

  it('has no path for text and boxes it from its note', () => {
    expect(markPathData({ id: 't', kind: 'text', color: '#000', points: [[1, 2]], text: '图号' })).toBeUndefined()
    const box = textMarkBox({ id: 't', kind: 'text', color: '#000', points: [[1, 2]], text: '图号' })
    expect(box?.width).toBeGreaterThan(0)
    expect(textMarkBox({ id: 't2', kind: 'text', color: '#000', points: [[1, 2]], text: '  ' })).toBeUndefined()
  })

  it('has no path when a mark carries no point', () => {
    expect(markPathData({ id: 'x', kind: 'arrow', color: '#000', points: [] })).toBeUndefined()
  })

  it('has no path for a half-drawn shape, but keeps a one-sample stroke', () => {
    // The wire format requires one point, not the two a box shape needs.
    const one = (kind: AnnotationMark['kind']): string | undefined =>
      markPathData({ id: 'x', kind, color: '#000', points: [[1, 2]] })
    expect(one('arrow')).toBeUndefined()
    expect(one('rect')).toBeUndefined()
    expect(one('ellipse')).toBeUndefined()
    expect(one('pen')).toBe('M 1 2')
    expect(markPathData({ id: 'x', kind: 'pen', color: '#000', points: [] })).toBeUndefined()
  })

  it('separates the shapes that draw as strokes from the one that draws as text', () => {
    for (const kind of ['arrow', 'rect', 'ellipse', 'pen'] as const) expect(isStrokeKind(kind), kind).toBe(true)
    expect(isStrokeKind('text')).toBe(false)
  })

  it('boxes a multi-line label by its longest line, and needs a point and a label', () => {
    const box = textMarkBox({ id: 't', kind: 'text', color: '#000', points: [[1, 2]], text: 'ab\nabcdef' })
    expect(box?.width).toBeGreaterThan(textMarkBox({ id: 't', kind: 'text', color: '#000', points: [[1, 2]], text: 'ab' })?.width ?? 0)
    expect(textMarkBox({ id: 't', kind: 'text', color: '#000', points: [] })).toBeUndefined()
    expect(textMarkBox({ id: 't', kind: 'text', color: '#000', points: [[1, 2]] })).toBeUndefined()
  })
})

describe('review image', () => {
  it('embeds the figure and every mark, and escapes note text', () => {
    const svg = composeReviewSvg(
      { kind: 'svg', markup: '<svg width="10" height="10"><rect width="10" height="10"/></svg>', viewBox: '0 0 10 10', width: 10, height: 10 },
      [{ id: 't', kind: 'text', color: '#000', points: [[1, 2]], text: 'a < b & "c"' }],
    )
    expect(svg.startsWith('<svg xmlns=')).toBe(true)
    expect(svg).toContain('<rect width="10" height="10"/>')
    expect(svg).toContain('a &lt; b &amp; &quot;c&quot;')
    // The font stack must not reintroduce a quote that would end the attribute.
    expect(svg).toContain('font-family="system-ui, -apple-system, PingFang SC')
    expect(svg).not.toContain('font-family="system-ui, -apple-system, "')
  })

  it('embeds raster bytes as a data URL', () => {
    const svg = composeReviewSvg(
      { kind: 'raster', dataUrl: bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png'), width: 4, height: 4 },
      [],
    )
    expect(svg).toContain('href="data:image/png;base64,AQID"')
  })

  it('encodes bytes larger than one chunk', () => {
    const bytes = new Uint8Array(0x8000 + 5).fill(7)
    expect(bytesToDataUrl(bytes, 'image/png').length).toBeGreaterThan(0x8000)
  })

  it('draws a stroke mark as a white halo under its own colour', () => {
    const svg = composeReviewSvg(
      { kind: 'raster', dataUrl: 'data:image/png;base64,AA', width: 4, height: 4 },
      [{ id: 'a', kind: 'arrow', color: '#e03131', points: [[0, 0], [10, 0]] }],
    )
    expect(svg).toContain('stroke="#ffffff"')
    expect(svg).toContain('stroke="#e03131"')
  })

  it('inlines a vector layer that declares no viewBox', () => {
    const svg = composeReviewSvg(
      { kind: 'svg', markup: '<svg width="3" height="3"><circle r="1"/></svg>', width: 3, height: 3 },
      [],
    )
    expect(svg).not.toContain('viewBox="0 0 3 3" preserveAspectRatio')
    expect(svg).toContain('<circle r="1"/>')
  })
})

describe('rasterizing the review image', () => {
  let dom: ReturnType<typeof installDom>
  beforeEach(() => { dom = installDom() })
  afterEach(() => { dom.window.close() })

  it('draws the composed image onto a canvas scaled to the requested size', async () => {
    const log = stubRasterizer()
    const blob = await rasterizePng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"/>', 10, 5, 2)
    expect(blob.type).toBe('image/png')
    expect(log.canvasSizes).toEqual([{ width: 20, height: 10 }])
    expect(log.revoked).toEqual(['blob:stub-review'])
  })

  it('never asks for a zero-pixel canvas', async () => {
    const log = stubRasterizer()
    await rasterizePng('<svg/>', 0, 0, 0.1)
    expect(log.canvasSizes).toEqual([{ width: 1, height: 1 }])
  })

  it('reports an undecodable composition instead of drawing nothing', async () => {
    stubRasterizer({ imageError: true })
    await expect(rasterizePng('<svg/>', 4, 4, 1)).rejects.toThrow(/could not be decoded/)
  })

  it('reports a missing 2D context, and still releases the object URL', async () => {
    const log = stubRasterizer({ noContext: true })
    await expect(rasterizePng('<svg/>', 4, 4, 1)).rejects.toThrow(/2D canvas is unavailable/)
    expect(log.revoked).toEqual(['blob:stub-review'])
  })

  it('reports a canvas that refuses to encode a PNG', async () => {
    stubRasterizer({ noBlob: true })
    await expect(rasterizePng('<svg/>', 4, 4, 1)).rejects.toThrow(/could not be encoded as PNG/)
  })
})

describe('figure DOM', () => {
  let dom: ReturnType<typeof installDom>
  beforeEach(() => { dom = installDom() })
  afterEach(() => { dom.window.close() })

  it('rejects text that is not SVG', () => {
    expect(parseFigureSvg('not svg at all')).toBeUndefined()
    expect(parseFigureSvg('<html><body/></html>')).toBeUndefined()
  })

  it('strips scripts, handlers, and external references before inlining', () => {
    const root = parseFigureSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <script>alert(1)</script>
      <foreignObject><div/></foreignObject>
      <a href="javascript:alert(1)" onclick="alert(2)"><rect width="5" height="5"/></a>
      <image href="https://evil.example/x.png" width="1" height="1"/>
      <image href="data:image/png;base64,AA" width="1" height="1"/>
    </svg>`)
    expect(root).toBeDefined()
    const markup = new XMLSerializer().serializeToString(defined(root))
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('foreignObject')
    expect(markup).not.toContain('onclick')
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('evil.example')
    expect(markup).toContain('data:image/png;base64,AA')
  })

  it('reads intrinsic size from attributes, then the viewBox, then defaults', () => {
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg width="12" height="7"/>')))).toEqual({ width: 12, height: 7 })
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg viewBox="0 0 30 40"/>')))).toEqual({ width: 30, height: 40 })
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg/>')))).toEqual({ width: 800, height: 600 })
    expect(svgViewBox(defined(parseFigureSvg('<svg viewBox="1 2 3 4"/>')), { width: 1, height: 1 })).toBe('1 2 3 4')
    expect(svgViewBox(defined(parseFigureSvg('<svg/>')), { width: 9, height: 8 })).toBe('0 0 9 8')
  })

  it('anchors a point to the smallest box, re-pointed at the element that names itself', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = defined(parseFigureSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <g class="node"><title>102</title><rect x="10" y="10" width="40" height="20" fill="none"/></g>
      <text x="70" y="80">导柱 33</text>
    </svg>`))
    container.append(root)
    stubRect(container, { left: 0, top: 0, width: 100, height: 100 })
    stubRect(root, { left: 0, top: 0, width: 100, height: 100 })
    stubRect(defined(root.querySelector('g')), { left: 10, top: 10, width: 40, height: 20 })
    stubRect(defined(root.querySelector('rect')), { left: 10, top: 10, width: 40, height: 20 })
    stubRect(defined(root.querySelector('text')), { left: 60, top: 70, width: 30, height: 12 })

    const node = anchorAtPoint(container, 30, 20, 1, 1)
    expect(node).toMatchObject({ tag: 'g', title: '102', bbox: [10, 10, 40, 20] })
    const numeral = anchorAtPoint(container, 70, 75, 1, 1)
    expect(numeral).toMatchObject({ tag: 'text', text: '导柱 33' })
    // A point that names nothing (outside every box) carries no anchor.
    expect(anchorAtPoint(container, 5, 95, 1, 1)).toBeUndefined()
  })

  it('scales the reported box into figure pixels', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = defined(parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="50" height="50"/></svg>'))
    container.append(root)
    stubRect(container, { left: 0, top: 0, width: 200, height: 200 })
    stubRect(defined(root.querySelector('rect')), { left: 0, top: 0, width: 100, height: 100 })
    expect(anchorAtPoint(container, 10, 10, 2, 2)?.bbox).toEqual([0, 0, 200, 200])
  })

  it('answers undefined when the container holds no figure', () => {
    const container = document.createElement('div')
    expect(anchorAtPoint(container, 1, 1, 1, 1)).toBeUndefined()
  })

  it('serializes a sanitized figure for the export canvas', () => {
    const markup = figureSvgMarkup(defined(parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>')))
    expect(markup).toContain('<svg')
    expect(markup).toContain('width="4"')
  })

  it('falls back to the figure size when the viewBox is blank', () => {
    expect(svgViewBox(defined(parseFigureSvg('<svg viewBox="   "/>')), { width: 9, height: 8 })).toBe('0 0 9 8')
  })

  it('ignores a viewBox that is not four usable numbers', () => {
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg viewBox="0 0 30"/>')))).toEqual({ width: 800, height: 600 })
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg viewBox="0 0 0 0"/>')))).toEqual({ width: 800, height: 600 })
    expect(svgIntrinsicSize(defined(parseFigureSvg('<svg width="0" height="7"/>')))).toEqual({ width: 800, height: 600 })
  })

  it('prefers the smaller box, the deeper element, and skips elements that draw nothing', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = defined(parseFigureSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <defs><rect id="in-defs" x="0" y="0" width="100" height="100"/></defs>
      <g id="outer"><rect id="inner" x="0" y="0" width="100" height="100"/></g>
      <line id="flat" x1="0" y1="50" x2="100" y2="50"/>
      <title id="a-title">   </title>
    </svg>`))
    container.append(root)
    const box = { left: 0, top: 0, width: 100, height: 100 }
    stubRect(container, box)
    stubRect(defined(root.querySelector('#outer')), box)
    stubRect(defined(root.querySelector('#inner')), box)
    stubRect(defined(root.querySelector('#in-defs')), box)
    stubRect(defined(root.querySelector('#a-title')), box)
    stubRect(defined(root.querySelector('g')), box)
    // A zero-height element covers the point on paper but draws nothing there.
    stubRect(defined(root.querySelector('#flat')), { left: 0, top: 50, width: 100, height: 0 })
    // Equal areas, so the deeper of the two rectangles wins before re-pointing.
    expect(anchorAtPoint(container, 50, 50, 1, 1)).toMatchObject({ tag: 'rect', id: 'inner' })
  })

  it('carries no title when the naming element has an empty one', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = defined(parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="n1" width="10" height="10"><title>  </title></rect></svg>'))
    container.append(root)
    stubRect(container, { left: 0, top: 0, width: 10, height: 10 })
    stubRect(defined(root.querySelector('rect')), { left: 0, top: 0, width: 10, height: 10 })
    const anchor = anchorAtPoint(container, 5, 5, 1, 1)
    expect(anchor?.id).toBe('n1')
    expect(anchor?.title).toBeUndefined()
    expect(anchor?.text).toBeUndefined()
  })
})
