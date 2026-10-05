/**
 * The props and seats contract between any annotator body and its slot owner.
 *
 * Every renderer (image, paged PDF, future kinds) receives the same composed
 * props; extracting them here keeps the contract out of the component that
 * implements one of them, so a fat props interface has one home.
 * @module dsh-annotator/client/annotator-contract
 */
import type { AnnotationMark } from '../shared/annotation'
import { fallbackTranslate } from './locales'
import type { SessionsLike } from './session'

/** Bytes-or-nothing content the document owner delivers. */
export interface BodyContent {
  /** Kind of content the owner produced. */
  readonly kind: string
  /** Complete file bytes, for a `bytes-complete` renderer. */
  readonly data?: Uint8Array<ArrayBuffer>
}

/** Values interpolated into one copy string. */
export type TranslateVars = Record<string, number | string>

/** The translator seat: a copy key and its interpolation values. */
export type Translate = (key: string, vars?: TranslateVars) => string

/** The props any annotator body receives from its slot's inject factory. */
export interface AnnotatorInjected {
  /** Injected session delivery face. */
  readonly sessions: SessionsLike | undefined
  /** Session this body belongs to, passed by the inject factory. */
  readonly sessionId: string
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId: string
}

/**
 * The page a paged renderer put on screen, as this body annotates it.
 *
 * The body annotates this raster instead of the file's own bytes: the renderer
 * that owns the document decides which page is on screen and at what resolution,
 * and keeps the other pages' edits while this one is mounted. Marks are recorded
 * in page units, so they mean the same thing at any zoom or pane width — and a
 * body with a page is one page of a document, not the document itself, so it
 * neither reads nor writes the sidecar: its owner does, once, for the whole file.
 */
export interface PageSurface {
  /** PNG data URL of the page. */
  readonly dataUrl: string
  /** Page width in page units. */
  readonly width: number
  /** Page height in page units. */
  readonly height: number
}

/** Unsaved edits of one surface, as an owner that unmounts surfaces keeps them. */
export interface SurfaceDraft {
  /** Marks drawn so far. */
  readonly marks: readonly AnnotationMark[]
}

/** Everything the body reads; all of it arrives through the composed props. */
export interface AnnotatorBodyProps {
  /** Document content: complete bytes for a `bytes-complete` renderer. */
  readonly content?: BodyContent | undefined
  /** The page a paged renderer put on screen, when this body annotates one page. */
  readonly page?: PageSurface | undefined
  /** Marks this surface had before it mounted; a saved document still wins over them. */
  readonly draft?: SurfaceDraft | undefined
  /** Reports every edit, so an owner that unmounts surfaces loses no unsaved work. */
  readonly onDraftChange?: ((draft: SurfaceDraft) => void) | undefined
  /** Overall note, when an owner keeps it for the whole document. */
  readonly summary?: string | undefined
  /** Reports every change of the overall note. */
  readonly onSummaryChange?: ((summary: string) => void) | undefined
  /** Viewing or annotating, when an owner keeps the choice across its surfaces. */
  readonly mode?: 'view' | 'annotate' | undefined
  /** Reports every change of that choice. */
  readonly onModeChange?: ((mode: 'view' | 'annotate') => void) | undefined
  /** The tab's `dsh-resource://file/…` address. */
  readonly resourceAddress?: string | undefined
  /** Owner callback that registers the body's scrollport. */
  readonly scrollportRef?: ((element: HTMLElement | null) => void) | undefined
  /** Locale seat bound by the shell when the namespace is registered. */
  readonly t?: Translate | undefined
  /** Injected session delivery face. */
  readonly sessions?: SessionsLike | undefined
  /** Session this body belongs to, passed by the inject factory. */
  readonly sessionId?: string | undefined
  /** Injected locale id used by the local fallback dictionary. */
  readonly localeId?: string | undefined
}

/**
 * Resolve one copy key against the injected seat, falling back to the local
 * dictionary. The two-step fallback (`t` then `localeId`) is identical for
 * every body, so it lives here rather than at each call site.
 * @param props - the composed props a body receives.
 * @param key - copy key.
 * @param vars - values interpolated into `{name}` placeholders.
 * @returns the localized string.
 */
export function resolveTranslate(props: { readonly t?: Translate | undefined; readonly localeId?: string | undefined }, key: string, vars?: TranslateVars): string {
  return props.t?.(key, vars) ?? fallbackTranslate(props.localeId ?? 'zh', key, vars)
}
