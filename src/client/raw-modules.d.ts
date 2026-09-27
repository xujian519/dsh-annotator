/**
 * Build-time text imports.
 *
 * The bundle's own plugins answer these specifiers, so the type has to exist
 * without a module behind it: a `?raw` import hands back the file's text.
 * @module dsh-annotator/client/raw-modules
 */

declare module '*?raw' {
  /** The imported file's contents, as text. */
  const source: string
  export default source
}
