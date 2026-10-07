/**
 * Rendering an HTML document into an annotatable frame, and naming what a mark
 * landed on.
 *
 * The document is inlined into a same-origin frame that is not allowed to run
 * scripts and carries a policy that forbids every external reference, so what the
 * frame holds is inert markup the parent half can read — which is the whole point:
 * a mark on a document has to name the element it points at, and the source
 * reader can only act on a locator that resolves in the file.
 *
 * The frame is rendered at {@link RENDER_WIDTH} and sized to its own content, so
 * it never scrolls internally and its elements report their own layout pixels —
 * which are exactly the figure pixels marks are recorded in.
 * @module dsh-annotator/client/html-dom
 */
import type { MarkAnchor } from '../shared/annotation'

/**
 * Width every document is rendered at, in figure pixels.
 *
 * Fixed rather than the pane's width: a document reflows, so marks measured at
 * one width would mean something else at another. Rendering at one width and
 * scaling the result to the pane gives marks the same standing a PDF page has —
 * the surface has a size of its own, and the pane only changes how it is shown.
 */
export const RENDER_WIDTH = 1024

/**
 * Policy every rendered document carries.
 *
 * The frame already refuses to run scripts; this keeps the document from reaching
 * anywhere at all — no request leaves the machine, no nested frame, no form post —
 * while still letting the document's own inline styles paint it.
 */
const CONTENT_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'"
  + "; img-src data:; font-src data:; media-src data:; connect-src 'none'"
  + "; frame-src 'none'; form-action 'none'; base-uri 'none'"

/** Elements that only wrap other content, so a mark on one names its container instead. */
const WRAPPER_TAGS = [
  'span', 'b', 'i', 'em', 'strong', 'small', 'u', 's', 'sub', 'sup',
  'code', 'a', 'label', 'mark', 'abbr', 'time', 'cite', 'q',
]

/** Cap on the element text carried into an anchor, matching the inline-SVG anchor. */
const ANCHOR_TEXT_LIMIT = 80

/**
 * Prepare one document for the frame.
 *
 * Two elements are removed rather than merely forbidden: a `<base>` would move
 * every relative reference in the document, and a refreshing `<meta>` would
 * replace the frame's document with a page this plugin cannot read. Both would
 * cost the user the surface they are annotating, so they are dropped instead.
 *
 * @param source - the file's own HTML text.
 * @returns a complete document for the frame.
 */
export function buildRenderedDocument(source: string): string {
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  for (const element of parsed.querySelectorAll('base')) element.remove()
  for (const element of parsed.querySelectorAll('meta')) {
    if ((element.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh') element.remove()
  }
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', CONTENT_POLICY)
  // First in the head, so it governs every reference the document declares.
  parsed.head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}

/**
 * Write one prepared document into a frame.
 *
 * @param frame - the frame element, or nothing when it is not mounted.
 * @param source - a document from {@link buildRenderedDocument}.
 * @returns the frame's root element, or undefined when there is no frame to load
 * into — the caller then has nothing to measure and no surface to annotate.
 */
export function loadFrameDocument(frame: HTMLIFrameElement | null, source: string): HTMLElement | undefined {
  if (frame === null) return undefined
  const frameDocument = frame.contentDocument
  if (frameDocument === null) return undefined
  frameDocument.open()
  frameDocument.write(source)
  frameDocument.close()
  return frameDocument.documentElement
}

/** How deep an element sits below the document body. */
function depthBelow(element: Element, body: Element): number {
  let depth = 0
  for (let node = element.parentElement; node !== null && node !== body; node = node.parentElement) depth += 1
  return depth
}

/** Whether an element is an anonymous inline wrapper: it names no anchor of its own. */
function isAnonymousWrapper(element: Element): boolean {
  return element.id === '' && WRAPPER_TAGS.includes(element.tagName.toLowerCase())
}

/**
 * One element's path from the document body.
 *
 * Every step is exact for the document it was read from: a step is the element's
 * own `#id` where it has one, and its position among same-name siblings
 * otherwise. The walk stops at the body — and says so — unless an `#id` made the
 * tail self-rooted: a bare `p:nth-of-type(1)` is body-relative but reads as
 * document-wide, which in a document with nested paragraphs names the wrong
 * element. `body > p:nth-of-type(1)` can be pasted into a query as it stands.
 */
function selectorFor(element: Element, body: Element): string {
  const segments: string[] = []
  let rooted = false
  for (let current: Element | null = element; current !== null && current !== body; current = current.parentElement) {
    if (current.id !== '') {
      segments.unshift(`#${current.id}`)
      rooted = true
      break
    }
    const tag = current.tagName
    let position = 1
    for (let sibling = current.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
      if (sibling.tagName === tag) position += 1
    }
    segments.unshift(`${tag.toLowerCase()}:nth-of-type(${position})`)
  }
  if (!rooted) segments.unshift('body')
  return segments.join(' > ')
}

/**
 * Describe the element under one point of a rendered document.
 *
 * Every candidate's own box is tested rather than asking the browser what is
 * under the pointer: the frame's document is inert, and a walk over it answers
 * the same way whether an element is filled or not. Only elements with a box can
 * be named at all — that is what rules out the markup that is never painted.
 *
 * The smallest box containing the point wins, ties going to the deeper element.
 * An anonymous inline wrapper does not count as a name — a mark on the `<b>`
 * inside a heading points at that heading — so wrappers are held back as a
 * fallback for the one case they are all a point has: text a document leaves
 * directly in the body.
 *
 * @param document - the frame's document, or nothing when the frame is gone.
 * @param x - point x in figure pixels.
 * @param y - point y in figure pixels.
 * @returns the anchor, or undefined when the point names no element.
 */
export function anchorInDocument(document: Document | null | undefined, x: number, y: number): MarkAnchor | undefined {
  const body = document?.body
  if (body === null || body === undefined) return undefined
  let named: Element | undefined
  let namedArea = Number.POSITIVE_INFINITY
  let namedDepth = -1
  let wrapper: Element | undefined
  let wrapperArea = Number.POSITIVE_INFINITY
  let wrapperDepth = -1
  for (const element of body.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    const area = rect.width * rect.height
    const depth = depthBelow(element, body)
    if (isAnonymousWrapper(element)) {
      if (area < wrapperArea || (area === wrapperArea && depth > wrapperDepth)) {
        wrapper = element
        wrapperArea = area
        wrapperDepth = depth
      }
      continue
    }
    if (area < namedArea || (area === namedArea && depth > namedDepth)) {
      named = element
      namedArea = area
      namedDepth = depth
    }
  }
  const described = named ?? wrapper
  if (described === undefined) return undefined
  const rect = described.getBoundingClientRect()
  // `Element.textContent` is `string | null` in the DOM types, but only a
  // Document or a Doctype can report null; an element always reports its text.
  const rawText = described.textContent as string
  const text = rawText.trim().replace(/\s+/g, ' ').slice(0, ANCHOR_TEXT_LIMIT)
  return {
    tag: described.tagName.toLowerCase(),
    bbox: [rect.left, rect.top, rect.width, rect.height],
    ...(described.id === '' ? {} : { id: described.id }),
    ...(text === '' ? {} : { text }),
    selector: selectorFor(described, body),
  }
}
