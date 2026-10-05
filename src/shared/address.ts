/**
 * `dsh-resource://file/…` address grammar, as this plugin consumes it.
 *
 * Two scopes exist: `session/<sessionId>/<path>` (a path that may be relative to
 * the addressed Session's workspace or absolute) and `absolute/<path>` (a path
 * with no Session). Segments carry percent escapes; the path keeps its
 * separators literally.
 * @module dsh-annotator/shared/address
 */

/** One parsed file address. */
export interface FileAddress {
  /** Session scope of the address, absent for an `absolute` address. */
  readonly sessionId?: string
  /** Path exactly as the address carried it: relative, or absolute with a leading slash. */
  readonly path: string
}

/** Documented prefix of every file address. */
const PREFIX = 'dsh-resource://file/'

/**
 * Decode one address segment, leaving malformed escapes as their literal text.
 * @param segment - raw percent-encoded segment.
 * @returns the decoded segment.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is not a path the Host can resolve; keeping the literal
    // text makes the downstream stat fail with a clear "no such file" instead.
    return segment
  }
}

/**
 * Parse a `dsh-resource://file/…` address.
 * @param address - the address string taken from a preview tab.
 * @returns the parsed address, or undefined when the string is not a file address.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  if (!address.startsWith(PREFIX)) return undefined
  const rest = address.slice(PREFIX.length)
  if (rest.startsWith('session/')) {
    const afterScope = rest.slice('session/'.length)
    const slash = afterScope.indexOf('/')
    if (slash <= 0) return undefined
    return { sessionId: decodeSegment(afterScope.slice(0, slash)), path: decodeSegment(afterScope.slice(slash + 1)) }
  }
  if (rest.startsWith('absolute/')) return { path: decodeSegment(rest.slice('absolute/'.length)) }
  return undefined
}

/**
 * The last segment of a path, whatever separators it uses.
 * @param path - a POSIX- or Windows-separated path.
 * @returns the path's file name.
 */
export function baseNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}
