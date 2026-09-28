// @vitest-environment jsdom
/** The injected stylesheet: it lands once, it is marked, and it styles the panel. */
import { describe, expect, it } from 'vitest'
import { STYLES, ensureStyles } from '../src/client/styles'

describe('the annotator stylesheet', () => {
  it('lands in the document exactly once, however often the body mounts', () => {
    document.head.innerHTML = ''
    ensureStyles(document)
    ensureStyles(document)
    expect(document.querySelectorAll('style[data-dsh-annotator]')).toHaveLength(1)
  })

  it('scopes every rule to the plugin prefix', () => {
    const selectors = [...STYLES.matchAll(/\.(da-[a-z-]+)/g)].map(match => match[1])
    expect(selectors.length).toBeGreaterThan(10)
    for (const selector of selectors) expect(selector?.startsWith('da-')).toBe(true)
  })

  it('takes its palette from the shell aliases, falling back to what it inherits', () => {
    // The theme owner resolves these per palette, so the panel follows the shell
    // into the light one; a shell without them must leave the panel legible
    // rather than hand it a palette of its own.
    for (const token of [
      'label-primary', 'label-secondary', 'label-tertiary',
      'bg-layer-2', 'bg-base', 'bg-document-preview', 'interactive-bg-hover',
      'border-l2', 'border-l3', 'border-l4', 'brand-primary',
      'state-error-primary', 'state-success-primary', 'label-error',
    ]) {
      expect(STYLES).toContain(`var(--dsw-alias-${token},`)
    }
    // Every token this sheet reads carries a fallback.
    const tokens = [...STYLES.matchAll(/var\(--dsw-[a-z0-9-]+([^)]*)\)/gu)]
    expect(tokens.length).toBeGreaterThan(10)
    for (const token of tokens) expect(token[1]?.startsWith(',')).toBe(true)
  })

  it('names no token the shell does not define, and bakes no dark palette', () => {
    // `--dsw-alias-text-l1` and friends never existed: the panel silently fell
    // back to near-white text in every palette, which is what made the light one
    // unreadable.
    expect(STYLES).not.toMatch(/var\(--dsw-alias-text-l/u)
    expect(STYLES).not.toMatch(/var\(--dsw-alias-bg-l[0-9]/u)
    expect(STYLES).not.toMatch(/#e6e6e6|#c8c8c8/iu)
  })

  it('gives the wait for the first page a box that holds the pane’s frame', () => {
    // The page slot is sized like the body's own column: without it the pane
    // collapses to a line of text until the page arrives.
    expect(STYLES).toContain('.da-placeholder{flex:1 1 auto')
  })
})
