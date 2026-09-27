/**
 * Annotation files beside one figure.
 *
 * An annotation never modifies the figure: it is written to a sibling file
 * (`<name>.annot.json` for the marks, `<name>.annotated.png` for the flattened
 * image). A page of a paged document adds its own page to the name
 * (`<name>.p3.annot.json`), so the pages of one PDF stay separate documents.
 *
 * The name keeps the figure's own extension (`fig1.svg` → `fig1.svg.annot.json`):
 * `fig1.svg` and `fig1.png` in one directory are two different documents, and marks
 * drawn on one of them mean nothing on the other, so they must never share a
 * sidecar. Every name is derived from the figure path, so the plugin can never be
 * asked to write an arbitrary location.
 * @module dsh-annotator/host/sidecar
 */
import { basename, dirname, extname, join } from 'node:path'
import { pageFileSuffix, type AnnotationDocument } from '../shared/annotation'

export { FIGURE_EXTENSIONS, figureMediaType, isFigurePath } from '../shared/figure-kind'

/** Suffix appended to a figure's base name for the marks file. */
export const ANNOTATION_SUFFIX = '.annot.json'

/** Suffix appended to a figure's base name for the flattened review image. */
export const ANNOTATED_IMAGE_SUFFIX = '.annotated.png'

/** Absolute paths of the two sidecar files belonging to one figure. */
export interface SidecarPaths {
  /** Marks file: the structured annotation JSON. */
  readonly annotation: string
  /** Flattened review image: the figure with the marks drawn on it. */
  readonly annotatedImage: string
}

/**
 * Resolve one figure's sidecar paths.
 * @param figurePath - absolute path of the annotated figure.
 * @param page - 1-based page for a paged figure, or undefined for a whole figure.
 * @returns the sidecar paths; both live in the figure's own directory.
 */
export function sidecarPaths(figurePath: string, page?: number): SidecarPaths {
  const name = `${basename(figurePath)}${pageFileSuffix(page)}`
  const directory = dirname(figurePath)
  return {
    annotation: join(directory, `${name}${ANNOTATION_SUFFIX}`),
    annotatedImage: join(directory, `${name}${ANNOTATED_IMAGE_SUFFIX}`),
  }
}

/**
 * The marks file this plugin derived before the figure's extension became part of
 * the name (`fig1.svg` → `fig1.annot.json`). Read-only: a file an earlier version
 * wrote stays readable, so an existing annotation never disappears on upgrade.
 * @param figurePath - absolute path of the annotated figure.
 * @param page - 1-based page for a paged figure, or undefined for a whole figure.
 * @returns the legacy marks file path beside the figure.
 */
export function legacyAnnotationPath(figurePath: string, page?: number): string {
  const name = `${basename(figurePath, extname(figurePath))}${pageFileSuffix(page)}`
  return join(dirname(figurePath), `${name}${ANNOTATION_SUFFIX}`)
}

/**
 * Marks files to read for one figure, most authoritative first: the current name,
 * then the legacy one. A figure whose name carries no extension derives both from
 * the same name, so the list is deduplicated.
 * @param figurePath - absolute path of the annotated figure.
 * @param page - 1-based page for a paged figure, or undefined for a whole figure.
 * @returns the candidate marks file paths.
 */
export function annotationCandidates(figurePath: string, page?: number): readonly string[] {
  const current = sidecarPaths(figurePath, page).annotation
  const legacy = legacyAnnotationPath(figurePath, page)
  return current === legacy ? [current] : [current, legacy]
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
