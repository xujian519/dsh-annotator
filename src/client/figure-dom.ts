/**
 * Turning a workspace figure into a DOM subtree the annotator can hit-test.
 *
 * An SVG figure is inlined rather than shown through an `<img>`, because only the
 * live DOM exposes which element a mark landed on (Graphviz tags each node group
 * with a `<title>`). Inlining untrusted markup requires sanitizing it first: the
 * figure comes from the workspace, so scripts, foreign content, and external
 * references are removed before it reaches the document.
 * @module dsh-annotator/client/figure-dom
 */

import type { MarkAnchor } from '../shared/annotation'

/** Element names removed outright before inlining. */
const FORBIDDEN_ELEMENTS = ['script', 'foreignObject', 'iframe', 'audio', 'video', 'use', 'animate', 'set']

/** Cap on the element text carried into an anchor. */
const ANCHOR_TEXT_LIMIT = 80

/**
 * Sanitize SVG source for inlining.
 * @param source - the figure's SVG text.
 * @returns the parsed root element, or undefined when the text is not usable SVG.
 */
export function parseFigureSvg(source: string): SVGSVGElement | undefined {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null) return undefined
  const root = parsed.documentElement
  if (root.tagName.toLowerCase() !== 'svg') return undefined
  for (const element of [...root.querySelectorAll(FORBIDDEN_ELEMENTS.join(','))]) element.remove()
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'href' || name === 'xlink:href') {
        const value = attribute.value.trim().toLowerCase()
        if (!value.startsWith('#') && !value.startsWith('data:')) element.removeAttribute(attribute.name)
      }
    }
  }
  return root as unknown as SVGSVGElement
}

/**
 * Serialize a sanitized figure for the export canvas.
 * @param root - sanitized root from {@link parseFigureSvg}.
 * @returns the SVG markup.
 */
export function figureSvgMarkup(root: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(root)
}

/** Intrinsic size of a figure element. */
export interface FigureIntrinsicSize {
  /** Width in figure pixels. */
  readonly width: number
  /** Height in figure pixels. */
  readonly height: number
}

/**
 * Read one inline SVG's own size.
 * @param root - sanitized root element.
 * @returns the width/height from its attributes or viewBox, defaulting to 800x600.
 */
export function svgIntrinsicSize(root: SVGSVGElement): FigureIntrinsicSize {
  const attributeWidth = Number.parseFloat(root.getAttribute('width') ?? '')
  const attributeHeight = Number.parseFloat(root.getAttribute('height') ?? '')
  if (Number.isFinite(attributeWidth) && Number.isFinite(attributeHeight) && attributeWidth > 0 && attributeHeight > 0) {
    return { width: attributeWidth, height: attributeHeight }
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const [, , boxWidth, boxHeight] = viewBox
  if (viewBox.length === 4 && boxWidth !== undefined && boxHeight !== undefined
    && Number.isFinite(boxWidth) && Number.isFinite(boxHeight) && boxWidth > 0 && boxHeight > 0) {
    return { width: boxWidth, height: boxHeight }
  }
  return { width: 800, height: 600 }
}

/** The `viewBox` an inline figure renders under. */
export function svgViewBox(root: SVGSVGElement, fallback: FigureIntrinsicSize): string {
  const declared = root.getAttribute('viewBox')
  if (declared !== null && declared.trim() !== '') return declared
  return `0 0 ${fallback.width} ${fallback.height}`
}

/** Shape elements that carry no area of their own. */
const NON_SHAPE_ELEMENTS = ['title', 'desc', 'defs', 'metadata', 'style', 'script']

/** How deep an element sits below the figure container. */
function depthBelow(element: Element, container: Element): number {
  let depth = 0
  for (let node = element.parentElement; node !== null && node !== container; node = node.parentElement) depth += 1
  return depth
}

/**
 * Whether an element sits inside a subtree that never renders.
 *
 * `defs`, `metadata`, and friends carry geometry that is never painted, so a
 * bounding box found there is not something the user can be pointing at.
 * @param element - candidate element.
 * @param root - the figure root the walk stops at.
 * @returns true when the element draws nothing.
 */
function isNonRendered(element: Element, root: Element): boolean {
  for (let node: Element | null = element; node !== null && node !== root; node = node.parentElement) {
    if (NON_SHAPE_ELEMENTS.includes(node.tagName.toLowerCase())) return true
  }
  return false
}

/**
 * Describe the figure element under one client-space point.
 *
 * Hit testing walks every descendant's bounding box rather than asking the
 * browser what is under the pointer: a patent figure is mostly unfilled strokes,
 * and an element with `fill="none"` is not hit in its interior, so a browser hit
 * test answers the figure root for most of the drawing. The smallest containing
 * box wins, and the answer is then re-pointed at the nearest ancestor that names
 * itself (`id` or `<title>`, which is how a Graphviz node identifies itself).
 * @param container - element holding the inline figure, used as the coordinate origin.
 * @param clientX - pointer x in client space.
 * @param clientY - pointer y in client space.
 * @param scaleX - figure pixels per client pixel horizontally.
 * @param scaleY - figure pixels per client pixel vertically.
 * @returns the anchor, or undefined when the point names no figure element.
 */
export function anchorAtPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scaleX: number,
  scaleY: number,
): MarkAnchor | undefined {
  const root = container.querySelector('svg')
  if (root === null) return undefined
  let hit: Element | undefined
  let hitArea = Number.POSITIVE_INFINITY
  let hitDepth = -1
  for (const element of root.querySelectorAll('*')) {
    if (isNonRendered(element, root)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const area = rect.width * rect.height
    const depth = depthBelow(element, container)
    if (area < hitArea || (area === hitArea && depth > hitDepth)) {
      hit = element
      hitArea = area
      hitDepth = depth
    }
  }
  if (hit === undefined) return undefined
  let described = hit
  for (let node: Element | null = hit; node !== null && node !== container; node = node.parentElement) {
    if (node.id !== '' || node.querySelector(':scope > title') !== null) {
      described = node
      break
    }
  }
  const rect = described.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const title = described.querySelector(':scope > title')?.textContent?.trim()
  // `Element.textContent` is `string | null` in the DOM types, but only a
  // Document or a Doctype can report null; an element always reports its text.
  const rawText = described.textContent as string
  // `described` is `hit` or an ancestor of it, so its text already contains the
  // hit's own text; there is nothing to fall back to.
  const text = rawText.trim().replace(/\s+/g, ' ').slice(0, ANCHOR_TEXT_LIMIT)
  return {
    tag: described.tagName.toLowerCase(),
    bbox: [
      (rect.left - containerRect.left) * scaleX,
      (rect.top - containerRect.top) * scaleY,
      rect.width * scaleX,
      rect.height * scaleY,
    ],
    ...(described.id === '' ? {} : { id: described.id }),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(text === '' ? {} : { text }),
  }
}
