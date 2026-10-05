/**
 * Line-level difference between two versions of one text document.
 *
 * The Markdown body edits a document in place in the browser and never writes
 * it, so the difference against the version the document was opened with is the
 * whole deliverable: the agent receives this text and applies it to the source.
 *
 * The algorithm is deliberately bounded. The common prefix and suffix are
 * trimmed first — which is what makes the ordinary "a few lines changed in a
 * long file" case cheap — and the remaining middle is diffed exactly over a
 * longest-common-subsequence table while that table stays under a cell budget.
 * A middle larger than the budget is reported as one replacement block and
 * flagged {@link TextDiff.coarse}: an honest coarse answer instead of an
 * unbounded computation, and the caller can still hand the full text over.
 *
 * A trailing newline is not a line: `textLines` drops exactly one, so a file
 * that ends without one does not read as a changed last line.
 * @module dsh-annotator/shared/text-diff
 */
import { baseNameOf } from './address'

/** How one displayed line differs from the older text. */
export type DiffLineKind = 'context' | 'add' | 'remove'

/** One line of a hunk, numbered on whichever side it exists. */
export interface DiffLine {
  /** Whether the line is unchanged, added, or removed. */
  readonly kind: DiffLineKind
  /** The line's own text, without its newline. */
  readonly text: string
  /** 1-based line number in the older text; absent on an added line. */
  readonly oldLine?: number
  /** 1-based line number in the newer text; absent on a removed line. */
  readonly newLine?: number
}

/** One run of changed lines with the context around it. */
export interface DiffHunk {
  /**
   * First line this hunk occupies on the older side; `0` when the hunk holds no
   * older line at all (an addition before the old file's first line).
   */
  readonly oldStart: number
  /** Lines the hunk occupies on the older side. */
  readonly oldCount: number
  /** First line this hunk occupies on the newer side; `0` as above. */
  readonly newStart: number
  /** Lines the hunk occupies on the newer side. */
  readonly newCount: number
  /** The hunk's lines, in document order. */
  readonly lines: readonly DiffLine[]
}

/** One text's difference from another. */
export interface TextDiff {
  /** Changed regions with their surrounding context, in document order. */
  readonly hunks: readonly DiffHunk[]
  /** Lines the newer text added. */
  readonly added: number
  /** Lines the newer text removed. */
  readonly removed: number
  /** Whether the two texts differ at all, at any granularity. */
  readonly changed: boolean
  /** Whether the middle was too large for the exact algorithm and reads as one block. */
  readonly coarse: boolean
}

/** Inputs of {@link diffLines}. */
export interface DiffOptions {
  /** Unchanged lines kept on each side of a change; defaults to 3. */
  readonly context?: number
  /** Largest `before × after` middle the exact algorithm attempts; defaults to 1e6. */
  readonly maxCells?: number
}

/** Unchanged lines kept around each change unless a caller says otherwise. */
export const DEFAULT_CONTEXT = 3

/** Largest middle the exact algorithm attempts, in table cells. */
export const DEFAULT_MAX_CELLS = 1_000_000

/** A difference that never changes, for a body that has no edit yet. */
export const EMPTY_DIFF: TextDiff = { hunks: [], added: 0, removed: 0, changed: false, coarse: false }

/** The character a line carries in unified-diff text. */
const SIGNS: Readonly<Record<DiffLineKind, string>> = { context: ' ', add: '+', remove: '-' }

/**
 * Split text into lines, dropping exactly one trailing newline.
 * @param text - the text to split.
 * @returns its lines; empty for an empty text.
 */
export function textLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Read one line the caller has already bounded.
 *
 * Every call site walks an index the surrounding loop keeps inside the array, so
 * the access cannot miss; the cast states that invariant instead of adding a
 * fallback branch that no input can reach.
 * @param lines - the lines being walked.
 * @param index - a position the caller guarantees is in range.
 * @returns that line.
 */
function lineAt(lines: readonly string[], index: number): string {
  return lines[index] as string
}

/**
 * Read one table cell the caller has already bounded.
 *
 * The table is allocated at `(rows + 1) × (columns + 1)` and every read is one
 * step inside those bounds, so a fallback value would be a branch no input can
 * reach — the same invariant {@link lineAt} states for lines.
 * @param cells - the subsequence table.
 * @param index - a flat position the caller guarantees is in range.
 * @returns that cell.
 */
function cell(cells: Uint32Array, index: number): number {
  return cells[index] as number
}

/** One operation of an edit script. */
interface Op {
  /** What the operation does. */
  readonly kind: 'equal' | 'remove' | 'add'
  /** The line it carries. */
  readonly text: string
}

/**
 * The exact edit script for one middle block, or undefined when it is too large.
 * @param older - older lines of the middle.
 * @param newer - newer lines of the middle.
 * @param maxCells - largest table this call will build.
 * @returns the script, or undefined when the table would exceed the budget.
 */
function exactOps(older: readonly string[], newer: readonly string[], maxCells: number): Op[] | undefined {
  const rows = older.length
  const columns = newer.length
  if (rows * columns > maxCells) return undefined
  const width = columns + 1
  // lengths[i][j] = longest common subsequence of older[i..] and newer[j..],
  // filled from the bottom right so the script can be walked forwards.
  const lengths = new Uint32Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = lineAt(older, i) === lineAt(newer, j)
        ? cell(lengths, (i + 1) * width + (j + 1)) + 1
        : Math.max(cell(lengths, (i + 1) * width + j), cell(lengths, i * width + (j + 1)))
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (older[i] === newer[j]) {
      ops.push({ kind: 'equal', text: lineAt(older, i) })
      i += 1
      j += 1
    } else if (cell(lengths, (i + 1) * width + j) >= cell(lengths, i * width + (j + 1))) {
      ops.push({ kind: 'remove', text: lineAt(older, i) })
      i += 1
    } else {
      ops.push({ kind: 'add', text: lineAt(newer, j) })
      j += 1
    }
  }
  while (i < rows) {
    ops.push({ kind: 'remove', text: lineAt(older, i) })
    i += 1
  }
  while (j < columns) {
    ops.push({ kind: 'add', text: lineAt(newer, j) })
    j += 1
  }
  return ops
}

/** One hunk's line range while it is still being widened. */
interface HunkRange {
  /** First line of the hunk in the full script. */
  start: number
  /** One past its last line. */
  end: number
}

/**
 * Group a full script into hunks with context, merging runs whose gap is covered.
 * @param lines - every line of the script, with its source numbers.
 * @param context - unchanged lines to keep on each side.
 * @returns the hunks, in document order.
 */
function groupHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const ranges: HunkRange[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    const start = Math.max(0, index - context)
    const end = Math.min(lines.length, index + 1 + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  })
  return ranges.map(range => buildHunk(lines, range))
}

/**
 * Build one hunk from its line range.
 * @param lines - every line of the script.
 * @param range - the hunk's line range.
 * @returns the hunk, with the counts and start lines unified diff spells.
 */
function buildHunk(lines: readonly DiffLine[], range: HunkRange): DiffHunk {
  const slice = lines.slice(range.start, range.end)
  const older = slice.filter(line => line.oldLine !== undefined)
  const newer = slice.filter(line => line.newLine !== undefined)
  const before = lines.slice(0, range.start)
  const olderBefore = before.filter(line => line.oldLine !== undefined).length
  const newerBefore = before.filter(line => line.newLine !== undefined).length
  // A hunk that holds no line on one side is an insertion or a deletion at that
  // point: unified diff then names the line *before* it and counts zero.
  const firstOlder = older[0]
  const firstNewer = newer[0]
  return {
    oldStart: firstOlder?.oldLine ?? olderBefore,
    oldCount: older.length,
    newStart: firstNewer?.newLine ?? newerBefore,
    newCount: newer.length,
    lines: slice,
  }
}

/**
 * Diff two texts by line.
 * @param before - the older text (the version the document was opened with).
 * @param after - the newer text (what the reader has edited).
 * @param options - context width and exact-algorithm budget.
 * @returns the difference, with hunks only when some line is not shared.
 */
export function diffLines(before: string, after: string, options: DiffOptions = {}): TextDiff {
  const context = options.context ?? DEFAULT_CONTEXT
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS
  const older = textLines(before)
  const newer = textLines(after)
  if (before === after) return EMPTY_DIFF
  const shared = Math.min(older.length, newer.length)
  let prefix = 0
  while (prefix < shared && older[prefix] === newer[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shared - prefix && older[older.length - 1 - suffix] === newer[newer.length - 1 - suffix]) suffix += 1
  const olderMiddle = older.slice(prefix, older.length - suffix)
  const newerMiddle = newer.slice(prefix, newer.length - suffix)
  const exact = exactOps(olderMiddle, newerMiddle, maxCells)
  const ops: readonly Op[] = exact ?? [
    ...olderMiddle.map((text): Op => ({ kind: 'remove', text })),
    ...newerMiddle.map((text): Op => ({ kind: 'add', text })),
  ]
  const lines: DiffLine[] = []
  let oldLine = 1
  let newLine = 1
  const equal = (text: string): void => {
    lines.push({ kind: 'context', text, oldLine, newLine })
    oldLine += 1
    newLine += 1
  }
  for (let index = 0; index < prefix; index += 1) equal(lineAt(older, index))
  for (const op of ops) {
    if (op.kind === 'equal') equal(op.text)
    else if (op.kind === 'remove') {
      lines.push({ kind: 'remove', text: op.text, oldLine })
      oldLine += 1
    } else {
      lines.push({ kind: 'add', text: op.text, newLine })
      newLine += 1
    }
  }
  for (let index = older.length - suffix; index < older.length; index += 1) equal(lineAt(older, index))
  const hunks = groupHunks(lines, context)
  return {
    hunks,
    added: lines.filter(line => line.kind === 'add').length,
    removed: lines.filter(line => line.kind === 'remove').length,
    changed: true,
    coarse: exact === undefined,
  }
}

/**
 * Spell one hunk's `@@` header.
 * @param hunk - the hunk to name.
 * @returns the header line, without its newline.
 */
export function formatHunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
}

/**
 * Spell a difference as unified-diff text.
 * @param displayPath - the path the message names; only its last segment is used.
 * @param diff - the difference to spell.
 * @returns the unified diff, without a trailing newline.
 */
export function formatUnifiedDiff(displayPath: string, diff: TextDiff): string {
  const name = baseNameOf(displayPath)
  const lines = [`--- a/${name}`, `+++ b/${name}`]
  for (const hunk of diff.hunks) {
    lines.push(formatHunkHeader(hunk))
    for (const line of hunk.lines) lines.push(`${SIGNS[line.kind]}${line.text}`)
  }
  return lines.join('\n')
}
