/**
 * Annotation files beside one figure.
 *
 * An annotation never modifies the figure: it is written to sibling files
 * (`<name>.annot.json` for the marks and `<name>.annotated.png` — or
 * `<name>.annotated.pdf` for a document that has pages — for the flattened
 * review artifact). One figure is one document, however many pages it has, so a
 * paged document's marks share a single sidecar and name their page inside it.
 *
 * The name keeps the figure's own extension (`fig1.svg` → `fig1.svg.annot.json`):
 * `fig1.svg` and `fig1.png` in one directory are two different documents, and marks
 * drawn on one of them mean nothing on the other, so they must never share a
 * sidecar. Every name is derived from the figure path, so the plugin can never be
 * asked to write an arbitrary location.
 * @module dsh-annotator/host/sidecar
 */
import { basename, dirname, extname, join } from 'node:path'
import type { AnnotationDocument } from '../shared/annotation'

export { FIGURE_EXTENSIONS, figureMediaType, isFigurePath } from '../shared/figure-kind'

/** Suffix appended to a figure's name for the marks file. */
export const ANNOTATION_SUFFIX = '.annot.json'

/** Suffix appended to a figure's name for the flattened review artifact. */
export const ANNOTATED_SUFFIX = '.annotated'

/** Absolute paths of the two sidecar files belonging to one figure. */
export interface SidecarPaths {
  /** Marks file: the structured annotation JSON. */
  readonly annotation: string
  /** Flattened review artifact: a PNG, or a PDF for a document that has pages. */
  readonly review: string
}

/**
 * Resolve one figure's sidecar paths.
 * @param figurePath - absolute path of the annotated figure.
 * @returns the sidecar paths; both live in the figure's own directory.
 */
export function sidecarPaths(figurePath: string): SidecarPaths {
  const name = basename(figurePath)
  const directory = dirname(figurePath)
  const reviewExtension = reviewFileExtension(figurePath)
  return {
    annotation: join(directory, `${name}${ANNOTATION_SUFFIX}`),
    review: join(directory, `${name}${ANNOTATED_SUFFIX}${reviewExtension}`),
  }
}

/**
 * Suffix of the flattened review artifact for one figure.
 *
 * A paged document is reviewed as a document — the page marks travel as native
 * PDF annotations in a copy of the original — while a single-surface figure is
 * reviewed as the picture it is.
 * @param figurePath - absolute path of the annotated figure.
 * @returns the file extension, dot included.
 */
export function reviewFileExtension(figurePath: string): '.pdf' | '.png' {
  return extname(figurePath).toLowerCase() === '.pdf' ? '.pdf' : '.png'
}

/**
 * The marks file this plugin derived before the figure's extension became part of
 * the name (`fig1.svg` → `fig1.annot.json`). Read-only: a file an earlier version
 * wrote stays readable, so an existing annotation never disappears on upgrade.
 * @param figurePath - absolute path of the annotated figure.
 * @returns the legacy marks file path beside the figure.
 */
export function legacyAnnotationPath(figurePath: string): string {
  return join(dirname(figurePath), `${basename(figurePath, extname(figurePath))}${ANNOTATION_SUFFIX}`)
}

/**
 * Marks files to read for one figure, most authoritative first: the current name,
 * then the legacy one. A figure whose name carries no extension derives both from
 * the same name, so the list is deduplicated.
 * @param figurePath - absolute path of the annotated figure.
 * @returns the candidate marks file paths.
 */
export function annotationCandidates(figurePath: string): readonly string[] {
  const current = sidecarPaths(figurePath).annotation
  const legacy = legacyAnnotationPath(figurePath)
  return current === legacy ? [current] : [current, legacy]
}

/**
 * Name pattern of the one-page-per-file sidecars this plugin wrote before a paged
 * document became a single annotation.
 *
 * Both spellings are matched — the extension-bearing name
 * (`fig1.pdf.p2.annot.json`) and the base-name one an even earlier version wrote
 * (`fig1.p2.annot.json`) — and the page number is the pattern's first group.
 *
 * @param figurePath - absolute path of the annotated figure.
 * @returns an anchored, case-insensitive pattern over one directory entry's name.
 */
export function legacyPagePattern(figurePath: string): RegExp {
  const extension = extname(figurePath)
  const names = new Set([basename(figurePath), basename(figurePath, extension)])
  const alternatives = [...names].map(escapeForRegExp).join('|')
  return new RegExp(`^(?:${alternatives})\\.p(\\d+)${escapeForRegExp(ANNOTATION_SUFFIX)}$`, 'iu')
}

/** Escape one literal so it matches itself inside a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Whether a stored document is the annotation of this very figure.
 *
 * A sidecar sits beside its figure and both names derive from the figure path, so
 * the file name — extension included, and case-insensitive because one file may be
 * spelled `FIG1.SVG` — is the whole identity. The check matters most for the legacy
 * name, which two figures sharing a base name also share.
 *
 * @param document - stored document to test.
 * @param figurePath - absolute path of the figure being opened.
 * @returns true when the document names this figure.
 */
export function annotationTargetsFigure(document: AnnotationDocument, figurePath: string): boolean {
  return basename(document.figure.path).toLowerCase() === basename(figurePath).toLowerCase()
}
