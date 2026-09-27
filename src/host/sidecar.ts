/**
 * Annotation files beside one figure.
 *
 * An annotation never modifies the figure: it is written to a sibling file
 * (`<name>.annot.json` for the marks, `<name>.annotated.png` for the flattened
 * image). Both names are derived from the figure path, so the plugin can never
 * be asked to write an arbitrary location.
 * @module dsh-annotator/host/sidecar
 */
import { basename, dirname, extname, join } from 'node:path'

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
 * @returns the sidecar paths; both live in the figure's own directory.
 */
export function sidecarPaths(figurePath: string): SidecarPaths {
  const directory = dirname(figurePath)
  const name = basename(figurePath, extname(figurePath))
  return {
    annotation: join(directory, `${name}${ANNOTATION_SUFFIX}`),
    annotatedImage: join(directory, `${name}${ANNOTATED_IMAGE_SUFFIX}`),
  }
}
