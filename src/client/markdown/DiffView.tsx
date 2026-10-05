/**
 * The difference between the version a document was opened with and the reader's
 * edits, drawn as a unified diff with one note field per hunk.
 *
 * A note belongs to the hunk whose baseline line it was written on, so the
 * reader's explanation stays attached to the same change while they keep
 * editing around it.
 * @module dsh-annotator/client/markdown/DiffView
 */
import type { ReactNode } from 'react'
import { formatHunkHeader, type TextDiff } from '../../shared/text-diff'
import type { Translate } from '../AnnotatorBody'

/** The character a line carries in the margin. */
const SIGNS = { context: ' ', add: '+', remove: '-' } as const

/** What the difference view renders. */
export interface DiffViewProps {
  /** The difference to draw. */
  readonly diff: TextDiff
  /** The reader's notes, keyed by the baseline line each hunk starts at. */
  readonly notes: Readonly<Record<number, string>>
  /** Reports a note the reader wrote for one hunk. @param line - the hunk's baseline line. @param text - what the reader wrote. */
  readonly onNote: (line: number, text: string) => void
  /** Product copy seat. */
  readonly t: Translate
}

/**
 * Draw one difference: every hunk with its header, its lines, and its note field.
 * @param props - the difference, the notes, and the copy seat.
 * @returns the difference view.
 */
export function DiffView({ diff, notes, onNote, t }: DiffViewProps): ReactNode {
  if (diff.hunks.length === 0) return <p className="da-hint">{t('diffEmpty')}</p>
  return (
    <div className="da-diff">
      {diff.hunks.map((hunk, index) => (
        <div className="da-diff-hunk" key={`${hunk.oldStart}-${hunk.newStart}-${index}`}>
          <div className="da-diff-head">{formatHunkHeader(hunk)}</div>
          {hunk.lines.map((line, offset) => (
            <div className="da-diff-line" data-kind={line.kind} key={`${index}-${offset}`}>
              <span className="da-diff-no">{line.oldLine ?? ''}</span>
              <span className="da-diff-no">{line.newLine ?? ''}</span>
              <span className="da-diff-sign">{SIGNS[line.kind]}</span>
              <span className="da-diff-text">{line.text}</span>
            </div>
          ))}
          <label className="da-diff-note">
            <span className="da-diff-note-label">{t('hunkNote', { line: hunk.oldStart })}</span>
            <input
              type="text"
              value={notes[hunk.oldStart] ?? ''}
              placeholder={t('hunkNotePlaceholder')}
              onChange={(event) => { onNote(hunk.oldStart, event.target.value) }}
            />
          </label>
        </div>
      ))}
    </div>
  )
}
