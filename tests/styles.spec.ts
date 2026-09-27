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

  it('reads its colours from shell tokens with a literal fallback', () => {
    // A missing token must not make the panel illegible.
    expect(STYLES).toContain('var(--dsw-alias-text-l1')
    expect(STYLES).toMatch(/var\(--dsw-alias-[a-z-]+,[^)]+\)/)
  })
})
