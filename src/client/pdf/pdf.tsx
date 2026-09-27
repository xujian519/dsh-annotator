/**
 * Entry of the lazy PDF chunk.
 *
 * The chunk is named after this module (`client.pdf.js`), and the client's
 * dynamic import of it is the only reference to PDF.js in the whole plugin, so
 * the parser and its data stay out of the startup bundle.
 * @module dsh-annotator/client/pdf
 */

export { PdfBody } from './PdfBody'
export type { PdfBodyInjected, PdfBodyProps } from './PdfBody'
