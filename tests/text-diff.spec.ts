/** The line differ: exact hunks, the context around them, and the coarse budget. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT,
  DEFAULT_MAX_CELLS,
  EMPTY_DIFF,
  diffLines,
  formatHunkHeader,
  formatUnifiedDiff,
  textLines,
} from '../src/shared/text-diff'
import { baseNameOf } from '../src/shared/address'
import { defined } from './dom'

describe('splitting text into lines', () => {
  it('reads no line out of an empty text', () => {
    expect(textLines('')).toEqual([])
  })

  it('drops one trailing newline, so a final newline is not a line of its own', () => {
    expect(textLines('a\n')).toEqual(['a'])
    expect(textLines('a')).toEqual(['a'])
    expect(textLines('a\nb\n')).toEqual(['a', 'b'])
    expect(textLines('a\nb')).toEqual(['a', 'b'])
  })

  it('keeps the empty lines inside the text', () => {
    expect(textLines('\n')).toEqual([''])
    expect(textLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})

describe('an unchanged text', () => {
  it('has no hunk and no counts', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual(EMPTY_DIFF)
  })

  it('reports a difference a line diff cannot show, and leaves the hunks empty', () => {
    // The texts differ, but only in the newline no line carries: the caller has
    // to say so rather than showing an empty diff as "no change".
    const diff = diffLines('a\nb\n', 'a\nb')
    expect(diff.changed).toBe(true)
    expect(diff.hunks).toEqual([])
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })
})

describe('an exact difference', () => {
  it('carries the changed line with three lines of context on each side', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n')
    const after = ['1', '2', '3', '4', 'changed', '6', '7', '8', '9'].join('\n')
    const diff = diffLines(before, after)
    expect(diff.changed).toBe(true)
    expect(diff.coarse).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.hunks).toHaveLength(1)
    const hunk = defined(diff.hunks[0])
    expect(formatHunkHeader(defined(hunk))).toBe('@@ -2,7 +2,7 @@')
    expect(hunk?.lines.map(line => line.kind)).toEqual([
      'context', 'context', 'context', 'remove', 'add', 'context', 'context', 'context',
    ])
    // Numbers are real line numbers on whichever side a line exists.
    expect(hunk?.lines[3]).toEqual({ kind: 'remove', text: '5', oldLine: 5 })
    expect(hunk?.lines[4]).toEqual({ kind: 'add', text: 'changed', newLine: 5 })
    expect(hunk?.lines[5]).toEqual({ kind: 'context', text: '6', oldLine: 6, newLine: 6 })
  })

  it('merges two changes whose context overlaps into one hunk', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n')
    const after = ['a', 'B', 'c', 'D', 'e'].join('\n')
    const diff = diffLines(before, after)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(2)
    // Two replacements, each carrying its removal: a, -b, +B, c, -d, +D, e.
    expect(diff.hunks[0]?.lines).toHaveLength(7)
  })

  it('keeps two distant changes apart', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const after = [...lines]
    after[0] = 'first'
    after[19] = 'last'
    const diff = diffLines(lines.join('\n'), after.join('\n'))
    expect(diff.hunks).toHaveLength(2)
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -1,4 +1,4 @@')
    expect(formatHunkHeader(defined(diff.hunks[1]))).toBe('@@ -17,4 +17,4 @@')
  })

  it('trims a long shared prefix and suffix instead of diffing them', () => {
    const shared = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`)
    const before = [...shared, 'old', ...shared].join('\n')
    const after = [...shared, 'new', ...shared].join('\n')
    const diff = diffLines(before, after)
    expect(diff.coarse).toBe(false)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
    expect(DEFAULT_MAX_CELLS).toBe(1_000_000)
    expect(DEFAULT_CONTEXT).toBe(3)
  })
})

describe('changes at a text’s edge', () => {
  it('numbers an insertion at the top of an empty text as an addition before line 1', () => {
    const diff = diffLines('', 'a\nb')
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -0,0 +1,2 @@')
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: 'b', newLine: 2 },
    ])
  })

  it('numbers a removal of every line as a deletion of the whole text', () => {
    const diff = diffLines('a\nb', '')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(2)
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -1,2 +0,0 @@')
  })

  it('numbers a hunk that starts on an added line without context', () => {
    const diff = diffLines('a\nb', 'new\na\nb', { context: 0 })
    expect(diff.hunks).toHaveLength(1)
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -0,0 +1,1 @@')
  })

  it('numbers a hunk that starts on a removed line without context', () => {
    const diff = diffLines('gone\na\nb', 'a\nb', { context: 0 })
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -1,1 +0,0 @@')
  })

  it('numbers a hunk that starts on a kept line without context', () => {
    const diff = diffLines('a\nb\nc', 'a\nchanged\nc', { context: 0 })
    expect(formatHunkHeader(defined(diff.hunks[0]))).toBe('@@ -2,1 +2,1 @@')
  })
})

describe('a middle too large for the exact algorithm', () => {
  it('reads as one replacement block and says so', () => {
    const before = ['x', 'y', 'z'].join('\n')
    const after = ['1', '2', '3'].join('\n')
    const diff = diffLines(before, after, { maxCells: 0 })
    expect(diff.coarse).toBe(true)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.removed).toBe(3)
    expect(diff.added).toBe(3)
    const kinds = diff.hunks[0]?.lines.map(line => line.kind) ?? []
    expect(kinds.slice(0, 3)).toEqual(['remove', 'remove', 'remove'])
    expect(kinds.slice(3)).toEqual(['add', 'add', 'add'])
  })

  it('still takes the exact path when trimming leaves nothing to compare', () => {
    const diff = diffLines('a\nb\nc', 'a\nb\nc', { maxCells: 0 })
    expect(diff).toEqual(EMPTY_DIFF)
  })
})

describe('writing a difference out', () => {
  it('spells a unified diff named after the document', () => {
    const diff = diffLines('a\nb', 'a\nB')
    expect(formatUnifiedDiff('/w/docs/report.md', diff)).toBe([
      '--- a/report.md',
      '+++ b/report.md',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n'))
  })

  it('takes the file name out of a Windows path too, and out of a bare name', () => {
    expect(baseNameOf('C:\\w\\report.md')).toBe('report.md')
    expect(baseNameOf('report.md')).toBe('report.md')
  })
})
