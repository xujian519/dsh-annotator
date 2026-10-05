/**
 * The Markdown body: the document's source, an editor over it, the difference
 * against the version it was opened with, and one delivery of that difference.
 *
 * The document itself is never written. What the reader edits is a proposal:
 * the difference travels into the Session as a unified diff, and the agent
 * applies it to the source. That keeps this plugin's one write surface — the
 * annotation sidecars beside a figure — the only place it can change anything on
 * disk, and it is why the editor holds one value rather than a draft plus a
 * baseline that could go missing: an edit is the pair, or there is no edit.
 *
 * Line numbers appear in a gutter while the document toolbar's wrap preference
 * is off, because a soft-wrapped line occupies more than one visual row and its
 * number would drift away from it. With wrapping on, the toolbar shows the
 * caret's line and column instead, which no wrapping can move.
 * @module dsh-annotator/client/markdown/MarkdownBody
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseFileAddress } from '../../shared/address'
import { EMPTY_DIFF, diffLines, formatUnifiedDiff, textLines } from '../../shared/text-diff'
import { resolveTranslate, type Translate, type TranslateVars } from '../annotator-contract'
import { deliverEdit, type FileUploadLike, type SessionsLike } from '../session'
import { ensureStyles } from '../styles'
import { DiffView } from './DiffView'

/** Text content the document owner delivers. */
export interface MarkdownContent {
  /** Kind of content the owner produced; only `text` is editable here. */
  readonly kind: string
  /** The text accumulated so far. */
  readonly text?: string
  /** Whether the owner has read the document to its end. */
  readonly eof?: boolean
}

/** What this body's slot injects. */
export interface MarkdownInjected {
  /** Injected session delivery face. */
  readonly sessions: SessionsLike | undefined
  /** Injected upload service, used only when a diff does not fit the message. */
  readonly fileUpload: FileUploadLike | undefined
  /** Session this body belongs to. */
  readonly sessionId: string
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId: string
}

/** Everything the body reads; all of it arrives through the composed props. */
export interface MarkdownBodyProps {
  /** Document content: accumulated text for a `text-pages` renderer. */
  readonly content?: MarkdownContent | undefined
  /** The tab's `dsh-resource://file/…` address. */
  readonly resourceAddress?: string | undefined
  /** The document toolbar's wrap preference. */
  readonly wrap?: boolean | undefined
  /** Locale seat bound by the shell when the namespace is registered. */
  readonly t?: Translate | undefined
  /** Injected session delivery face. */
  readonly sessions?: SessionsLike | undefined
  /** Injected upload service. */
  readonly fileUpload?: FileUploadLike | undefined
  /** Session this body belongs to, passed by the inject factory. */
  readonly sessionId?: string | undefined
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId?: string | undefined
}

/**
 * The reader's edit: the text editing began from, and its current value.
 *
 * One value, so "a draft without its baseline" cannot be represented; the
 * difference is only ever computed between two texts that both exist.
 */
interface Edit {
  /** The loaded text as it was when the first keystroke arrived. */
  readonly baseline: string
  /** The text as it stands now. */
  readonly text: string
}

/** What the body last saw, so a document that moves under an edit is noticed. */
interface Seen {
  /** Address the text belonged to. */
  readonly address: string
  /** The loaded text at that point. */
  readonly text: string | undefined
}

/** Where the caret sits, in the units the reader counts in. */
interface Caret {
  /** 1-based line the caret is on. */
  readonly line: number
  /** 1-based column the caret is at. */
  readonly column: number
}

/** No notes, as the one value the reader's empty state reuses. */
const NO_NOTES: Readonly<Record<number, string>> = {}

/**
 * Render one Markdown document with its editor and its difference.
 * @param props - owner content, the addressed resource, copy, and the session seats.
 * @returns the Markdown body.
 */
export function MarkdownBody(props: MarkdownBodyProps): ReactNode {
  const address = props.resourceAddress ?? ''
  const content = props.content
  const loaded = content?.kind === 'text' ? content.text ?? '' : undefined
  const eof = content?.kind === 'text' && content.eof === true
  const sessionId = props.sessionId ?? parseFileAddress(address)?.sessionId
  const documentPath = parseFileAddress(address)?.path ?? address
  const t = useCallback(
    (key: string, vars?: TranslateVars): string => resolveTranslate(props, key, vars),
    [props.t, props.localeId],
  )
  const [edit, setEdit] = useState<Edit | null>(null)
  const [notes, setNotes] = useState<Readonly<Record<number, string>>>(NO_NOTES)
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 })
  const [stale, setStale] = useState(false)
  const [view, setView] = useState<'edit' | 'diff'>('edit')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const seen = useRef<Seen>({ address, text: loaded })
  const gutter = useRef<HTMLDivElement | null>(null)

  const diff = useMemo(
    () => (edit === null ? EMPTY_DIFF : diffLines(edit.baseline, edit.text)),
    [edit],
  )
  const text = edit?.text ?? loaded ?? ''
  const lines = textLines(text).length

  useEffect(() => { ensureStyles(document) }, [])

  /**
   * Notice a document that moved under the reader.
   *
   * A different address is a different document: the edit belongs to the one it
   * was made in, so it is dropped. The same address handing different text means
   * the file changed on disk, or the owner loaded more of it — the reader's work
   * stays, and the delivery says the difference is against an older version.
   */
  useEffect(() => {
    const before = seen.current
    seen.current = { address, text: loaded }
    if (before.address !== address) {
      setEdit(null)
      setNotes(NO_NOTES)
      setStale(false)
      setStatus(null)
      setView('edit')
      return
    }
    if (before.text !== loaded && edit !== null) setStale(true)
  }, [address, edit, loaded])

  /** Read the caret out of the element that moved it. */
  const readCaret = useCallback((element: HTMLTextAreaElement): void => {
    const head = element.value.slice(0, element.selectionStart)
    setCaret({
      line: head.split('\n').length,
      column: element.selectionStart - head.lastIndexOf('\n'),
    })
  }, [])

  /** Keep the gutter on the row the textarea is showing. */
  const syncGutter = useCallback((element: HTMLTextAreaElement): void => {
    const column = gutter.current
    if (column !== null) column.scrollTop = element.scrollTop
  }, [])

  const discard = useCallback((): void => {
    setEdit(null)
    setNotes(NO_NOTES)
    setStale(false)
    setStatus(null)
    setView('edit')
  }, [])

  /** Copy the whole difference: that is what a reader takes somewhere else. */
  const copyDiff = useCallback(async (): Promise<void> => {
    // The only enforcement point: the button stays clickable so this guard is
    // what decides, not a disabled attribute that hides the reason.
    if (diff.hunks.length === 0) return
    try {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) throw new Error(t('copyUnavailable'))
      await clipboard.writeText(formatUnifiedDiff(documentPath, diff))
      setStatus({ tone: 'ok', text: t('diffCopied') })
    } catch (error) {
      setStatus({ tone: 'error', text: `${t('copyFailed')}${error instanceof Error ? error.message : String(error)}` })
    }
  }, [diff, documentPath, t])

  const send = useCallback(async (): Promise<void> => {
    // The only enforcement point: the button stays clickable so the guards below
    // are what decides, not a disabled attribute that hides the reason.
    if (edit === null || diff.hunks.length === 0) return
    setBusy(true)
    setStatus({ tone: 'info', text: t('editSending') })
    try {
      const sessions = props.sessions
      if (sessions === undefined) throw new Error(t('editUnavailable'))
      if (sessionId === undefined) throw new Error(t('editNoSession'))
      const warnings = await deliverEdit({
        sessions,
        fileUpload: props.fileUpload,
        sessionId,
        documentPath,
        diff,
        editedText: edit.text,
        notes,
        stale,
        locale: (props.localeId ?? 'zh').startsWith('en') ? 'en' : 'zh',
      })
      setStatus({
        tone: 'ok',
        text: `${t('editSent')}${warnings.length === 0 ? '' : `（${warnings.join(' ')}）`}`,
      })
    } catch (error) {
      setStatus({ tone: 'error', text: `${t('editSendError')}${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }, [diff, documentPath, edit, notes, props.fileUpload, props.localeId, props.sessions, sessionId, stale, t])

  if (loaded === undefined) return <p className="da-hint">{t('editLoading')}</p>
  const dirty = edit !== null
  const wrapping = props.wrap !== false
  return (
    <div className="da-root da-md">
      <div className="da-toolbar">
        <button type="button" className="da-btn" aria-pressed={view === 'edit'}
          onClick={() => { setView('edit') }}>{t('editMode')}</button>
        <button type="button" className="da-btn" aria-pressed={view === 'diff'}
          onClick={() => { setView('diff') }}>{t('diffMode')}</button>
        <span className="da-spacer" />
        <span className="da-md-stats">{dirty
          ? t('editStats', { hunks: diff.hunks.length, added: diff.added, removed: diff.removed })
          : t('editLines', { lines })}</span>
        <span className="da-md-stats">{t('caretAt', { line: caret.line, column: caret.column })}</span>
        <button type="button" className="da-btn" disabled={!dirty || busy}
          onClick={() => { void copyDiff() }}>{t('copyDiff')}</button>
        <button type="button" className="da-btn" disabled={!dirty}
          onClick={discard}>{t('discardEdit')}</button>
        <button type="button" className="da-btn" disabled={!dirty || busy}
          onClick={() => { void send() }}>{t('sendEdit')}</button>
      </div>
      {!eof ? <div className="da-status" data-tone="info">{t('editEofPending')}</div> : null}
      {stale ? <div className="da-status" data-tone="error">{t('editStale')}</div> : null}
      {status === null ? null : <div className="da-status" data-tone={status.tone === 'info' ? undefined : status.tone}>{status.text}</div>}
      {view === 'edit' ? (
        <div className="da-md-pane">
          {wrapping ? null : (
            <div className="da-md-gutter" ref={gutter} aria-hidden="true">
              {Array.from({ length: lines }, (_, index) => <div key={index}>{index + 1}</div>)}
            </div>
          )}
          <textarea
            className="da-md-editor"
            wrap={wrapping ? 'soft' : 'off'}
            spellCheck={false}
            value={text}
            onScroll={(event) => { syncGutter(event.currentTarget) }}
            // Keys, clicks, and edits are the three ways a caret moves here;
            // `select` is not among them (a browser only fires it for a
            // selection, and its synthetic form is untestable in jsdom).
            onKeyUp={(event) => { readCaret(event.currentTarget) }}
            onClick={(event) => { readCaret(event.currentTarget) }}
            onChange={(event) => {
              const value = event.currentTarget.value
              readCaret(event.currentTarget)
              setEdit(previous => (previous === null
                ? { baseline: loaded, text: value }
                : { baseline: previous.baseline, text: value }))
            }}
          />
        </div>
      ) : (
        <DiffView
          diff={diff}
          notes={notes}
          onNote={(line, value) => { setNotes(current => ({ ...current, [line]: value })) }}
          t={t}
        />
      )}
    </div>
  )
}
