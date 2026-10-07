// @vitest-environment jsdom
/** The rendered document: its frame, the policy it carries, and what a mark names. */
import { afterEach, describe, expect, it } from 'vitest'
import type { MarkAnchor } from '../src/shared/annotation'
import { RENDER_WIDTH, anchorInDocument, buildRenderedDocument, loadFrameDocument } from '../src/client/html-dom'
import { defined, stubRect } from './dom'

/** Parse one document the way a file's own bytes reach the renderer. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** The document one built source produces, as the frame would hold it. */
function rendered(html: string): Document {
  return parse(buildRenderedDocument(html))
}

/** The frames this spec appended, removed after each test. */
afterEach(() => { document.body.innerHTML = '' })

describe('rendering a document for the frame', () => {
  it('renders at one fixed width, so marks mean the same thing wherever they are read', () => {
    expect(RENDER_WIDTH).toBe(1024)
  })

  it('puts the drawing policy first in the head, where it governs every reference', () => {
    const doc = rendered('<html><head><title>t</title></head><body><p>hi</p></body></html>')
    const first = doc.head.firstElementChild
    expect(first?.tagName).toBe('META')
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    const policy = first?.getAttribute('content') ?? ''
    expect(policy).toContain("script-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    // The document's own inline styles still paint it.
    expect(policy).toContain("style-src 'unsafe-inline'")
    expect(doc.querySelector('title')?.textContent).toBe('t')
  })

  it('drops the two elements that would take the surface away: base and a refreshing meta', () => {
    const doc = rendered(
      '<html><head><base href="https://elsewhere.example/"><meta http-equiv="refresh" content="0;url=https://elsewhere.example/">'
      + '<meta http-equiv="REFRESH" content="5"><meta charset="utf-8"></head><body><p>hi</p></body></html>',
    )
    expect(doc.querySelector('base')).toBeNull()
    expect(doc.querySelector('meta[http-equiv="refresh" i]')).toBeNull()
    expect(doc.querySelector('meta[charset]')).not.toBeNull()
  })

  it('builds a complete document even from a fragment with no head of its own', () => {
    const source = buildRenderedDocument('<p>hi</p>')
    expect(source.startsWith('<!doctype html>')).toBe(true)
    const doc = parse(source)
    expect(doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull()
    expect(doc.body.textContent).toBe('hi')
  })
})

describe('loading a frame', () => {
  /** Append one frame to the document and return it. */
  function frame(): HTMLIFrameElement {
    const element = document.createElement('iframe')
    document.body.append(element)
    return element
  }

  it('writes the document into the frame and reports the root to measure', () => {
    const root = loadFrameDocument(frame(), '<!doctype html><html><body><p id="p1">hi</p></body></html>')
    expect(root?.tagName).toBe('HTML')
    expect(root?.querySelector('#p1')?.textContent).toBe('hi')
  })

  it('reports nothing to measure when there is no frame', () => {
    expect(loadFrameDocument(null, '<p>hi</p>')).toBeUndefined()
  })

  it('reports nothing to measure when the frame has no document', () => {
    const element = frame()
    Object.defineProperty(element, 'contentDocument', { configurable: true, value: null })
    expect(loadFrameDocument(element, '<p>hi</p>')).toBeUndefined()
  })
})

describe('naming what a mark landed on', () => {
  it('names the smallest element containing the point, with its text and its path', () => {
    const doc = parse('<html><body><section id="s"><p>first</p> <p>second paragraph</p></section></body></html>')
    const section = defined(doc.querySelector('#s'))
    const [first, second] = [...doc.querySelectorAll('p')]
    stubRect(section, { left: 0, top: 0, width: 600, height: 400 })
    stubRect(defined(first), { left: 0, top: 0, width: 600, height: 50 })
    stubRect(defined(second), { left: 0, top: 50, width: 600, height: 50 })
    expect(anchorInDocument(doc, 300, 60)).toEqual({
      tag: 'p',
      bbox: [0, 50, 600, 50],
      text: 'second paragraph',
      selector: '#s > p:nth-of-type(2)',
    } satisfies MarkAnchor)
    expect(anchorInDocument(doc, 300, 300)).toEqual({
      tag: 'section',
      bbox: [0, 0, 600, 400],
      id: 's',
      text: 'first second paragraph',
      selector: '#s',
    } satisfies MarkAnchor)
    // A point nothing paints over names no element: a mark on empty page area
    // carries its note and its coordinates, and no locator.
    expect(anchorInDocument(doc, 300, 700)).toBeUndefined()
  })

  it('prefers the deeper element when two boxes are the same size', () => {
    const doc = parse('<html><body><div id="outer"><em id="inner">x</em></div></body></html>')
    stubRect(defined(doc.querySelector('#outer')), { left: 0, top: 0, width: 100, height: 100 })
    stubRect(defined(doc.querySelector('#inner')), { left: 0, top: 0, width: 100, height: 100 })
    expect(anchorInDocument(doc, 10, 10)?.id).toBe('inner')
  })

  it('climbs out of an anonymous inline wrapper to the block that carries it', () => {
    const doc = parse('<html><body><article><p>the <b>bold</b> word</p></article></body></html>')
    stubRect(defined(doc.querySelector('article')), { left: 0, top: 0, width: 400, height: 300 })
    stubRect(defined(doc.querySelector('p')), { left: 0, top: 0, width: 400, height: 40 })
    stubRect(defined(doc.querySelector('b')), { left: 20, top: 0, width: 40, height: 20 })
    expect(anchorInDocument(doc, 30, 10)).toEqual({
      tag: 'p',
      bbox: [0, 0, 400, 40],
      text: 'the bold word',
      selector: 'body > article:nth-of-type(1) > p:nth-of-type(1)',
    } satisfies MarkAnchor)
  })

  it('names an anonymous wrapper only when it is all the point has', () => {
    const doc = parse('<html><body><span>bare text</span></body></html>')
    stubRect(defined(doc.querySelector('span')), { left: 0, top: 0, width: 90, height: 20 })
    expect(anchorInDocument(doc, 10, 10)).toEqual({
      tag: 'span',
      bbox: [0, 0, 90, 20],
      text: 'bare text',
      selector: 'body > span:nth-of-type(1)',
    } satisfies MarkAnchor)
  })

  it('prefers the deeper wrapper when two wrappers are the same size', () => {
    const doc = parse('<html><body><span><span>nested text</span></span></body></html>')
    const [outer, inner] = [...doc.querySelectorAll('span')]
    stubRect(defined(outer), { left: 0, top: 0, width: 90, height: 20 })
    stubRect(defined(inner), { left: 0, top: 0, width: 90, height: 20 })
    expect(anchorInDocument(doc, 10, 10)?.selector).toBe('body > span:nth-of-type(1) > span:nth-of-type(1)')
  })

  it('keeps a wrapper that names itself instead of climbing out of it', () => {
    const doc = parse('<html><body><p>the <b id="lead">bold</b> word</p></body></html>')
    stubRect(defined(doc.querySelector('p')), { left: 0, top: 0, width: 400, height: 40 })
    stubRect(defined(doc.querySelector('#lead')), { left: 20, top: 0, width: 40, height: 20 })
    expect(anchorInDocument(doc, 30, 10)).toEqual({
      tag: 'b',
      bbox: [20, 0, 40, 20],
      id: 'lead',
      text: 'bold',
      selector: '#lead',
    } satisfies MarkAnchor)
  })

  it('carries no text for an element that has none', () => {
    const doc = parse('<html><body><img src="x.png"></body></html>')
    stubRect(defined(doc.querySelector('img')), { left: 0, top: 0, width: 120, height: 60 })
    expect(anchorInDocument(doc, 10, 10)).toEqual({
      tag: 'img',
      bbox: [0, 0, 120, 60],
      selector: 'body > img:nth-of-type(1)',
    } satisfies MarkAnchor)
  })

  it('collapses whitespace and caps the text it carries', () => {
    const doc = parse(`<html><body><p>  word\n\n  ${'word '.repeat(40)}</p></body></html>`)
    stubRect(defined(doc.querySelector('p')), { left: 0, top: 0, width: 900, height: 40 })
    const anchor = defined(anchorInDocument(doc, 10, 10))
    // The same cap and the same collapsing the inline-SVG anchor applies, so one
    // quote reads the same whichever surface produced it.
    expect(anchor.text).toHaveLength(80)
    expect(anchor.text?.startsWith('word word')).toBe(true)
    expect(anchor.text).not.toContain('  ')
    expect(anchor.text).not.toContain('\n')
  })

  it('names nothing for a point over no element, or over an element with no box', () => {
    const doc = parse('<html><body><p>hi</p><span>invisible</span></body></html>')
    stubRect(defined(doc.querySelector('p')), { left: 0, top: 0, width: 100, height: 20 })
    expect(anchorInDocument(doc, 500, 900)).toBeUndefined()
    // The span keeps jsdom's own zero-size box, which is what a never-painted
    // element reports in a browser too.
    expect(anchorInDocument(doc, 0, 0)?.tag).toBe('p')
  })

  it('names nothing when there is no document to read, or no body in it', () => {
    expect(anchorInDocument(null, 1, 1)).toBeUndefined()
    expect(anchorInDocument(undefined, 1, 1)).toBeUndefined()
    // A document that is not HTML has no body at all.
    const xml = new DOMParser().parseFromString('<root><child/></root>', 'application/xml')
    expect(anchorInDocument(xml, 1, 1)).toBeUndefined()
  })

  it('names a deep element through every step of its path', () => {
    const doc = parse('<html><body><div><div><div><p>deep</p></div></div></div></body></html>')
    stubRect(defined(doc.querySelector('p')), { left: 0, top: 0, width: 40, height: 20 })
    expect(anchorInDocument(doc, 10, 10)?.selector)
      .toBe('body > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1)')
  })
})
