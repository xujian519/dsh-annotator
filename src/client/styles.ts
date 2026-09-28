/**
 * Styles for the annotator body.
 *
 * The DSH client bundle route serves JavaScript only, so the stylesheet travels
 * inside the bundle and is injected once on first mount. Colors come from the
 * shell's `--dsw-*` aliases, which the theme owner resolves per palette, so the
 * panel follows the shell into the light one; the fallbacks are the inherited
 * values, so a shell that defines no token still renders something legible
 * rather than a palette of its own.
 * @module dsh-annotator/client/styles
 */

/** Marker attribute identifying our own style element. */
const STYLE_MARKER = 'data-dsh-annotator'

/** The stylesheet text. */
export const STYLES = `
.da-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,inherit)}
/* No scrollbar-width here: declaring it makes Chromium drop the theme's own
   scrollbar skin for this element, and the row's bar is the only part of the
   toolbar the shell would otherwise style. */
.da-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;flex:0 0 auto;padding:6px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l3,currentColor);background:var(--dsw-alias-bg-layer-2,transparent)}
/* The row scrolls sideways; it never squeezes a control into a second line. */
.da-toolbar>*{flex:0 0 auto}
.da-toolbar .da-spacer{flex:1 1 auto}
.da-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;white-space:nowrap;border:0.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}
.da-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.da-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-brand-primary,currentColor)}
.da-btn:disabled{opacity:.45;cursor:default}
.da-swatch{width:16px;height:16px;border-radius:50%;corner-shape:round;border:0.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.5));cursor:pointer;padding:0}
.da-swatch[aria-pressed="true"]{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}
.da-stage{position:relative;flex:1 1 auto;overflow:auto;min-height:0;background:var(--dsw-alias-bg-document-preview,transparent)}
/* The page keeps the shell's own document surface: the canvas behind it is the
   document-preview grey, so a page has to read as one on top of it. */
.da-surface{position:relative;margin:12px auto;transform-origin:top left;box-shadow:var(--dsw-elevation-prominent,none)}
.da-figure{display:block;user-select:none;-webkit-user-drag:none}
.da-overlay{position:absolute;inset:0;touch-action:none}
.da-overlay[data-mode="view"]{pointer-events:none}
.da-overlay[data-tool="select"]{cursor:default}
.da-overlay[data-tool="text"]{cursor:text}
.da-overlay:not([data-tool="select"]){cursor:crosshair}
.da-page{font-size:12px;min-width:44px;text-align:center;color:var(--dsw-alias-label-secondary,inherit)}
/* The document's toolbar sits above the page body, so the pane is one column of
   definite height and the body takes what is left of it. */
.da-pdf{display:flex;flex-direction:column;height:100%;min-height:0}
.da-pdf>.da-root{flex:1 1 auto;height:auto;min-height:0}
/* The page slot before the first raster. It takes the column the body's stage
   takes, so the frame around it — the toolbar above all — is in place from the
   first paint and does not move when the page arrives. */
.da-placeholder{flex:1 1 auto;min-height:0;background:var(--dsw-alias-bg-document-preview,transparent)}
.da-note{position:relative;flex:0 0 auto;display:flex;gap:6px;align-items:flex-end;padding:8px;border-top:0.5px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-layer-2,transparent)}
.da-note textarea{flex:1;min-height:44px;max-height:120px;resize:vertical;border:0.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px;padding:4px 6px}
.da-marks{flex:0 0 auto;max-height:132px;overflow:auto;padding:4px 8px;border-top:0.5px solid var(--dsw-alias-border-l1,currentColor);font-size:12px}
.da-mark{display:flex;gap:6px;align-items:baseline;padding:2px 0}
.da-mark-index{color:var(--dsw-alias-label-tertiary,inherit);min-width:16px}
.da-mark-text{flex:1;word-break:break-word}
.da-mark-del{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;font-size:12px}
.da-mark-del:hover{color:var(--dsw-alias-label-error,currentColor)}
.da-status{flex:0 0 auto;padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.da-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,currentColor)}
.da-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,currentColor)}
.da-hint{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
`

/**
 * Inject the stylesheet once per document.
 * @param doc - document to inject into.
 */
export function ensureStyles(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_MARKER}]`) !== null) return
  const element = doc.createElement('style')
  element.setAttribute(STYLE_MARKER, '')
  element.textContent = STYLES
  doc.head.appendChild(element)
}
