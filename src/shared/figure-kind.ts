/**
 * Figure file suffixes, shared by the browser and Node halves.
 * @module dsh-annotator/shared/figure-kind
 */

/** File suffixes this plugin treats as annotatable figures. */
export const FIGURE_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico'] as const

/**
 * Read a path's lower-case suffix without the dot.
 * @param path - file path or name.
 * @returns the suffix, or an empty string when there is none.
 */
export function suffixOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Whether a path names a figure this plugin renders.
 * @param path - file path.
 * @returns true when the suffix is a supported image suffix.
 */
export function isFigurePath(path: string): boolean {
  return (FIGURE_EXTENSIONS as readonly string[]).includes(suffixOf(path))
}

/**
 * Media type of one figure path.
 * @param path - file path.
 * @returns the media type, or undefined for an unsupported suffix.
 */
export function figureMediaType(path: string): string | undefined {
  switch (suffixOf(path)) {
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'gif': return 'image/gif'
    case 'ico': return 'image/x-icon'
    default: return undefined
  }
}
