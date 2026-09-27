/** The `dsh-resource://file/…` grammar this plugin decodes. */
import { describe, expect, it } from 'vitest'
import { parseFileAddress } from '../src/shared/address'
import { figureMediaType, isFigurePath, suffixOf } from '../src/shared/figure-kind'
import { annotationCandidates, legacyAnnotationPath, sidecarPaths } from '../src/host/sidecar'
import { resolveSessionCwd } from '../src/host/session-cwd'

describe('file addresses', () => {
  it('reads a Session-relative address', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1/figures/fig1.svg'))
      .toEqual({ sessionId: 's1', path: 'figures/fig1.svg' })
  })

  it('reads an absolute path inside a Session address', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1//tmp/a.svg'))
      .toEqual({ sessionId: 's1', path: '/tmp/a.svg' })
  })

  it('reads an absolute-scope address with no Session', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/tmp/a.png'))
      .toEqual({ path: 'tmp/a.png' })
  })

  it('decodes percent escapes in the id and the path', () => {
    expect(parseFileAddress('dsh-resource://file/session/s%201/%E5%9B%BE1.svg'))
      .toEqual({ sessionId: 's 1', path: '图1.svg' })
  })

  it('keeps a malformed escape literal instead of throwing', () => {
    expect(parseFileAddress('dsh-resource://file/session/s1/a%ZZ.svg'))
      .toEqual({ sessionId: 's1', path: 'a%ZZ.svg' })
  })

  it('rejects everything else', () => {
    for (const value of [
      'https://example.com/a.svg',
      'dsh-resource://file/',
      'dsh-resource://file/session',
      'dsh-resource://file/session/',
      'dsh-resource://file/session//a.svg',
      'dsh-resource://file/shared/s/a.svg',
    ]) {
      expect(parseFileAddress(value)).toBeUndefined()
    }
  })
})

describe('figure suffixes', () => {
  it('recognizes the renderable suffixes', () => {
    expect(isFigurePath('/a/b/FIG1.SVG')).toBe(true)
    expect(isFigurePath('图1.png')).toBe(true)
    expect(isFigurePath('/a/b/notes.md')).toBe(false)
    expect(isFigurePath('/a/b/noextension')).toBe(false)
    expect(suffixOf('/a/b/.hidden')).toBe('')
  })

  it('maps suffixes to media types', () => {
    expect(figureMediaType('a.svg')).toBe('image/svg+xml')
    expect(figureMediaType('a.png')).toBe('image/png')
    expect(figureMediaType('a.jpg')).toBe('image/jpeg')
    expect(figureMediaType('a.JPEG')).toBe('image/jpeg')
    expect(figureMediaType('a.webp')).toBe('image/webp')
    expect(figureMediaType('a.bmp')).toBe('image/bmp')
    expect(figureMediaType('a.gif')).toBe('image/gif')
    expect(figureMediaType('a.ico')).toBe('image/x-icon')
    expect(figureMediaType('a.pdf')).toBeUndefined()
  })

  it('reads the suffix of a Windows-separated path too', () => {
    expect(suffixOf('C:\\w\\figures\\fig1.PNG')).toBe('png')
    expect(isFigurePath('C:\\w\\figures\\fig1.PNG')).toBe(true)
  })
})

describe('sidecar paths', () => {
  it('derives both sibling files from the figure name, extension included', () => {
    expect(sidecarPaths('/w/figures/fig1.svg')).toEqual({
      annotation: '/w/figures/fig1.svg.annot.json',
      annotatedImage: '/w/figures/fig1.svg.annotated.png',
    })
  })

  it('keeps dotted names intact', () => {
    expect(sidecarPaths('/w/图 1.a.svg').annotation).toBe('/w/图 1.a.svg.annot.json')
  })

  it('still names the marks file earlier versions derived from the base name', () => {
    expect(legacyAnnotationPath('/w/figures/fig1.svg')).toBe('/w/figures/fig1.annot.json')
  })

  it('offers the legacy name only as a fallback, and deduplicates a name without extension', () => {
    expect(annotationCandidates('/w/figures/fig1.svg')).toEqual([
      '/w/figures/fig1.svg.annot.json',
      '/w/figures/fig1.annot.json',
    ])
    expect(annotationCandidates('/w/Makefile')).toEqual(['/w/Makefile.annot.json'])
  })
})

describe('session directory resolution', () => {
  it('prefers the live agent header', async () => {
    const cwd = await resolveSessionCwd('s1', {
      agents: { get: () => ({ session: { cwd: '/live' } }) },
      sessionPersistence: { stat: async () => ({ header: { cwd: '/stored' } }) },
      workspaceRegistry: { list: () => [{ path: '/ws', sessionIds: ['s1'] }] },
    })
    expect(cwd).toBe('/live')
  })

  it('falls back to the stored header when no agent is live', async () => {
    const cwd = await resolveSessionCwd('s1', {
      agents: { get: () => undefined },
      sessionPersistence: { stat: async () => ({ header: { cwd: '/stored' } }) },
      workspaceRegistry: { list: () => [{ path: '/ws', sessionIds: ['s1'] }] },
    })
    expect(cwd).toBe('/stored')
  })

  it('falls back to the workspace that lists the session', async () => {
    const cwd = await resolveSessionCwd('s1', {
      agents: { get: () => undefined },
      sessionPersistence: { stat: async () => undefined },
      workspaceRegistry: { list: () => [{ path: '/other', sessionIds: ['s2'] }, { path: '/ws', sessionIds: ['s1'] }] },
    })
    expect(cwd).toBe('/ws')
  })

  it('answers undefined when the persistence read fails and nothing else knows it', async () => {
    const cwd = await resolveSessionCwd('s1', {
      agents: { get: () => undefined },
      sessionPersistence: { stat: async () => { throw new Error('backend down') } },
    })
    expect(cwd).toBeUndefined()
  })
})
