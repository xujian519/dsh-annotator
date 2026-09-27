/**
 * Styles for the annotator body.
 *
 * The DSH client bundle route serves JavaScript only, so the stylesheet travels
 * inside the bundle and is injected once on first mount. Colors come from the
 * shell's `--dsw-*` tokens, with literal fallbacks so the panel stays legible if
 * a token is absent.
 * @module dsh-annotator/client/styles
 */

/** Marker attribute identifying our own style element. */
const STYLE_MARKER = 'data-dsh-annotator'

/** The stylesheet text. */
export const STYLES = `
.da-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-text-l1,#e6e6e6)}
.da-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;flex:0 0 auto;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:var(--dsw-alias-bg-l2,rgba(127,127,127,.06))}
.da-toolbar .da-spacer{flex:1}
.da-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}
.da-btn:hover{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.12))}
.da-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}
.da-btn:disabled{opacity:.45;cursor:default}
.da-swatch{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.35);cursor:pointer;padding:0}
.da-swatch[aria-pressed="true"]{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}
.da-stage{position:relative;flex:1 1 auto;overflow:auto;min-height:0;background:var(--dsw-alias-bg-l1,transparent)}
.da-surface{position:relative;margin:12px auto;transform-origin:top left}
.da-figure{display:block;user-select:none;-webkit-user-drag:none}
.da-overlay{position:absolute;inset:0;touch-action:none}
.da-overlay[data-mode="view"]{pointer-events:none}
.da-overlay[data-tool="select"]{cursor:default}
.da-overlay[data-tool="text"]{cursor:text}
.da-overlay:not([data-tool="select"]){cursor:crosshair}
.da-page{font-size:12px;min-width:44px;text-align:center;color:var(--dsw-alias-text-l2,rgba(200,200,200,.9))}
.da-pdf{height:100%;min-height:0}
.da-note{position:relative;flex:0 0 auto;display:flex;gap:6px;align-items:flex-end;padding:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08))}
.da-note textarea{flex:1;min-height:44px;max-height:120px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:6px;background:var(--dsw-alias-bg-l1,transparent);color:inherit;font:inherit;font-size:12px;padding:4px 6px}
.da-marks{flex:0 0 auto;max-height:132px;overflow:auto;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));font-size:12px}
.da-mark{display:flex;gap:6px;align-items:baseline;padding:2px 0}
.da-mark-index{color:var(--dsw-alias-text-l3,rgba(180,180,180,.9));min-width:16px}
.da-mark-text{flex:1;word-break:break-word}
.da-mark-del{border:none;background:transparent;color:var(--dsw-alias-text-l3,rgba(180,180,180,.9));cursor:pointer;font-size:12px}
.da-status{padding:6px 8px;font-size:12px;color:var(--dsw-alias-text-l2,rgba(200,200,200,.9))}
.da-status[data-tone="error"]{color:var(--dsw-alias-danger,#ff6b6b)}
.da-status[data-tone="ok"]{color:var(--dsw-alias-success,#4ec9a0)}
.da-hint{padding:8px;font-size:12px;color:var(--dsw-alias-text-l3,rgba(180,180,180,.9))}
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
