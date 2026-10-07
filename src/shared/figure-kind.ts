/**
 * Document suffixes, shared by the browser and Node halves.
 * @module dsh-annotator/shared/figure-kind
 */

/**
 * File suffixes this plugin treats as annotatable documents.
 *
 * A PDF is one document however many pages it has: the browser half renders one
 * page at a time, each mark records the page it was drawn on, and saving writes
 * the marks back into a copy of the document as native annotations.
 *
 * An HTML document is one surface: the browser half renders it at a fixed width
 * and records marks in those layout pixels, and its marks file is the only
 * artifact a save writes — a rendered document cannot be flattened into a
 * picture the way a figure can.
 */
export const FIGURE_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'pdf', 'html', 'htm'] as const

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
 * Whether a path names a document this plugin renders.
 * @param path - file path.
 * @returns true when the suffix is one this plugin annotates.
 */
export function isFigurePath(path: string): boolean {
  return (FIGURE_EXTENSIONS as readonly string[]).includes(suffixOf(path))
}

/**
 * Media type of one document path.
 * @param path - file path.
 * @returns the media type, or undefined for an unsupported suffix.
 */
export function figureMediaType(path: string): string | undefined {
  switch (suffixOf(path)) {
    case 'pdf': return 'application/pdf'
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'gif': return 'image/gif'
    case 'ico': return 'image/x-icon'
    case 'html':
    case 'htm': return 'text/html'
    default: return undefined
  }
}
