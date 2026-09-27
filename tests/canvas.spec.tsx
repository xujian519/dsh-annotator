// @vitest-environment jsdom
/** The drawing surface: pointer input becomes marks in figure coordinates. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationMark } from '../src/shared/annotation'
import { Canvas, nextMarkId, type Tool } from '../src/client/Canvas'
import { defined, stubRect } from './dom'

/** Options one mounted surface is built from. */
interface MountOptions {
  readonly tool: Tool
  readonly marks?: readonly AnnotationMark[]
  readonly anchoring?: boolean
  readonly selectedId?: string | null
  readonly container?: HTMLElement | null
  readonly svgSize?: { readonly width: number; readonly height: number }
  readonly onAdd?: (mark: AnnotationMark) => void
  readonly onSelect?: (id: string | null) => void
  readonly onRemove?: (id: string) => void
}

/** Render the surface over a stubbed viewport. */
function mount(options: MountOptions): {
  readonly host: HTMLElement
  readonly root: Root
  readonly svg: SVGSVGElement
  readonly figure: HTMLElement
} {
  const host = document.createElement('div')
  const figure = document.createElement('div')
  document.body.append(host)
  host.append(figure)
  const root = createRoot(host)
  const size = options.svgSize ?? { width: 400, height: 300 }
  const containerRef = { current: options.container === undefined ? figure : options.container }
  act(() => {
    root.render(
      <Canvas
        width={400}
        height={300}
        marks={options.marks ?? []}
        tool={options.tool}
        color="#e03131"
        containerRef={containerRef}
        anchoring={options.anchoring ?? false}
        selectedId={options.selectedId ?? null}
        onSelect={options.onSelect ?? (() => {})}
        onAdd={options.onAdd ?? (() => {})}
        onRemove={options.onRemove ?? (() => {})}
      />,
    )
  })
  const svg = host.querySelector('svg') as SVGSVGElement
  stubRect(svg, { left: 0, top: 0, ...size })
  return { host, root, svg, figure }
}

/** Dispatch one pointer event React's synthetic listeners observe. */
function pointer(target: Element, type: string, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY }))
  })
}

/** Dispatch one pointer event that carries a pointer id. */
function pointerWithId(target: Element, type: string, clientX: number, clientY: number, pointerId: number): void {
  act(() => {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    target.dispatchEvent(event)
  })
}

/** Dispatch one double click. */
function doubleClick(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
}

/** Give the surface the pointer-capture methods jsdom does not implement. */
function stubPointerCapture(svg: SVGSVGElement, captured: boolean): { readonly released: number[] } {
  const released: number[] = []
  Object.defineProperty(svg, 'setPointerCapture', { configurable: true, value: () => {} })
  Object.defineProperty(svg, 'hasPointerCapture', { configurable: true, value: () => captured })
  Object.defineProperty(svg, 'releasePointerCapture', { configurable: true, value: (id: number) => { released.push(id) } })
  return { released }
}

describe('drawing surface', () => {
  let mounted: ReturnType<typeof mount> | undefined
  afterEach(() => {
    mounted?.root.unmount()
    mounted = undefined
    document.body.innerHTML = ''
  })

  it('commits an arrow between the press and release points', () => {
    const onAdd = vi.fn()
    const onSelect = vi.fn()
    mounted = mount({ tool: 'arrow', onAdd, onSelect })
    pointer(mounted.svg, 'pointerdown', 300, 225)
    pointer(mounted.svg, 'pointermove', 100, 66)
    pointer(mounted.svg, 'pointerup', 100, 66)
    expect(onAdd).toHaveBeenCalledTimes(1)
    const mark = onAdd.mock.calls[0]?.[0] as AnnotationMark
    expect(mark.kind).toBe('arrow')
    expect(mark.points).toEqual([[300, 225], [100, 66]])
    expect(mark.color).toBe('#e03131')
    expect(onSelect).toHaveBeenCalledWith(mark.id)
  })

  it('drops a press-and-release with no travel', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', onAdd })
    pointer(mounted.svg, 'pointerdown', 100, 100)
    pointer(mounted.svg, 'pointerup', 101, 101)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('collects freehand samples and ignores jitter below the sampling step', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'pen', onAdd })
    pointer(mounted.svg, 'pointerdown', 0, 0)
    pointer(mounted.svg, 'pointermove', 1, 1)
    pointer(mounted.svg, 'pointermove', 40, 40)
    pointer(mounted.svg, 'pointerup', 40, 40)
    const mark = onAdd.mock.calls[0]?.[0] as AnnotationMark
    expect(mark.points).toEqual([[0, 0], [40, 40]])
  })

  it('drops a freehand press that never moved', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'pen', onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointerup', 10, 10)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('creates and selects a text mark on click', () => {
    const onAdd = vi.fn()
    const onSelect = vi.fn()
    mounted = mount({ tool: 'text', onAdd, onSelect })
    pointer(mounted.svg, 'pointerdown', 200, 150)
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(defined(onAdd.mock.calls[0]?.[0] as AnnotationMark | undefined).kind).toBe('text')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('draws nothing in select mode', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'select', onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointerup', 200, 200)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('renders stored marks and selects one when it is clicked', () => {
    const onSelect = vi.fn()
    mounted = mount({
      tool: 'select',
      onSelect,
      marks: [{ id: 'm1', kind: 'rect', color: '#1971c2', points: [[10, 10], [100, 80]], text: '缺图形' }],
    })
    const paths = mounted.svg.querySelectorAll('path')
    expect(paths.length).toBeGreaterThanOrEqual(3)
    pointer(paths[2] as Element, 'pointerdown', 20, 20)
    expect(onSelect).toHaveBeenCalledWith('m1')
  })

  it('clears the selection when the surface itself is clicked in select mode', () => {
    const onSelect = vi.fn()
    mounted = mount({ tool: 'select', onSelect, marks: [{ id: 'm1', kind: 'pen', color: '#000', points: [[0, 0], [5, 5]] }] })
    act(() => { mounted?.svg.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('removes a mark when its hit area is double-clicked', () => {
    const onRemove = vi.fn()
    mounted = mount({ tool: 'select', onRemove, marks: [{ id: 'm1', kind: 'pen', color: '#000', points: [[0, 0], [5, 5]] }] })
    const hit = mounted.svg.querySelector('path[stroke="transparent"]')
    expect(hit).not.toBeNull()
    doubleClick(defined(hit))
    expect(onRemove).toHaveBeenCalledWith('m1')
  })

  it('selects and removes a labelled mark through its label plate', () => {
    const onSelect = vi.fn()
    const onRemove = vi.fn()
    mounted = mount({
      tool: 'select',
      onSelect,
      onRemove,
      marks: [{ id: 'm1', kind: 'rect', color: '#1971c2', points: [[10, 10], [100, 80]], text: '缺图形' }],
    })
    const plate = mounted.svg.querySelector('rect[fill="transparent"]')
    expect(plate).not.toBeNull()
    pointer(defined(plate), 'pointerdown', 12, 12)
    doubleClick(defined(plate))
    expect(onSelect).toHaveBeenCalledWith('m1')
    expect(onRemove).toHaveBeenCalledWith('m1')
  })

  it('draws a text-only mark with its label and selection ring', () => {
    mounted = mount({
      tool: 'select',
      selectedId: 'm1',
      marks: [
        { id: 'm1', kind: 'text', color: '#e03131', points: [[40, 60]], text: '图号应在正下方' },
      ],
    })
    expect(mounted.svg.querySelector('text')?.textContent).toBe('图号应在正下方')
    // A text mark has no stroke, so its selection ring is the dashed plate.
    expect(mounted.svg.querySelector('rect[stroke="#4c8dff"]')).not.toBeNull()
  })

  it('rings a selected stroke mark with a dashed outline', () => {
    mounted = mount({
      tool: 'select',
      selectedId: 'm1',
      marks: [{ id: 'm1', kind: 'rect', color: '#1971c2', points: [[10, 10], [100, 80]] }],
    })
    expect(mounted.svg.querySelector('path[stroke="#4c8dff"]')).not.toBeNull()
  })

  it('shows the mark being drawn without its hit area', () => {
    mounted = mount({ tool: 'rect' })
    pointer(mounted.svg, 'pointerdown', 20, 20)
    pointer(mounted.svg, 'pointermove', 120, 90)
    const group = mounted.svg.querySelector('g[opacity="0.75"]')
    expect(group).not.toBeNull()
    expect(group?.querySelector('path[stroke="transparent"]')).toBeNull()
  })

  it('ignores a move that started no drag', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', onAdd })
    pointer(mounted.svg, 'pointermove', 50, 50)
    pointer(mounted.svg, 'pointerup', 50, 50)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('captures and releases the pointer around a drag', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', onAdd })
    const capture = stubPointerCapture(mounted.svg, true)
    pointerWithId(mounted.svg, 'pointerdown', 10, 10, 7)
    pointerWithId(mounted.svg, 'pointermove', 90, 90, 7)
    pointerWithId(mounted.svg, 'pointerup', 90, 90, 7)
    expect(capture.released).toEqual([7])
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('leaves an uncaptured pointer alone', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', onAdd })
    const capture = stubPointerCapture(mounted.svg, false)
    pointerWithId(mounted.svg, 'pointerdown', 10, 10, 3)
    pointerWithId(mounted.svg, 'pointermove', 90, 90, 3)
    pointerWithId(mounted.svg, 'pointerup', 90, 90, 3)
    expect(capture.released).toEqual([])
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('finishes on a cancelled pointer too', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointermove', 90, 90)
    pointer(mounted.svg, 'pointercancel', 90, 90)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('reports no anchor when the figure is not inlined SVG', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', anchoring: false, onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointermove', 90, 90)
    pointer(mounted.svg, 'pointerup', 90, 90)
    expect(defined(onAdd.mock.calls[0]?.[0] as AnnotationMark | undefined).anchor).toBeUndefined()
  })

  it('reports no anchor when there is no figure container to hit-test', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', anchoring: true, container: null, onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointermove', 90, 90)
    pointer(mounted.svg, 'pointerup', 90, 90)
    expect(defined(onAdd.mock.calls[0]?.[0] as AnnotationMark | undefined).anchor).toBeUndefined()
  })

  it('keeps coordinates finite when the surface reports no area', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', anchoring: true, svgSize: { width: 0, height: 0 }, onAdd })
    pointer(mounted.svg, 'pointerdown', 10, 10)
    pointer(mounted.svg, 'pointermove', 90, 90)
    pointer(mounted.svg, 'pointerup', 90, 90)
    const mark = defined(onAdd.mock.calls[0]?.[0] as AnnotationMark | undefined)
    expect(mark.anchor).toBeUndefined()
    for (const point of mark.points) expect(point.every(Number.isFinite), String(point)).toBe(true)
  })

  it('anchors a finished drag to the figure element under the release point', () => {
    const onAdd = vi.fn()
    mounted = mount({ tool: 'rect', anchoring: true, onAdd })
    const inline = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    anchor.setAttribute('id', 'node102')
    inline.append(anchor)
    mounted.figure.append(inline)
    stubRect(mounted.figure, { left: 0, top: 0, width: 400, height: 300 })
    stubRect(anchor, { left: 10, top: 10, width: 40, height: 20 })
    pointer(mounted.svg, 'pointerdown', 20, 15)
    pointer(mounted.svg, 'pointermove', 25, 18)
    pointer(mounted.svg, 'pointerup', 30, 20)
    expect(defined(onAdd.mock.calls[0]?.[0] as AnnotationMark | undefined).anchor).toMatchObject({ tag: 'g', id: 'node102' })
  })

  it('mints ids that do not repeat inside one session', () => {
    const first = nextMarkId()
    expect(nextMarkId()).not.toBe(first)
  })
})
