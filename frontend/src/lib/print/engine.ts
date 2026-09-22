/**
 * Print engine — renders a document into an isolated, print-only iframe with its own stylesheet so that
 * output never depends on the app shell, dark mode, open dialogs or the current viewport, and comes out
 * right on both A4/Letter sheets and 80 mm / 58 mm thermal rolls.
 *
 * Paper handling
 *  - Sheets: an explicit `@page { size }` (A4, A4 landscape, A5, Letter) with normal margins, repeating table
 *    headers and page-break control.
 *  - Rolls: `@page { margin: 0 }` and a fluid body (width 100 %, capped at the roll width) so the content
 *    always fits whatever printable width the printer driver reports (72 mm on most 80 mm printers,
 *    48 mm on 58 mm printers). `size: <w> auto` is declared for engines that accept it; where it is not
 *    accepted the declaration is simply dropped and the driver's configured roll size applies.
 *  - Copies are produced by repeating the document with a forced page break (= a cut on roll printers), so
 *    they also work with silent kiosk printing where the dialog is never shown.
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactElement } from 'react';

export type Paper = 'a4' | 'a4-landscape' | 'a5' | 'letter' | 'thermal80' | 'thermal58';
export type DocType = 'receipt' | 'kitchen' | 'ticket' | 'shift' | 'folio' | 'confirmation' | 'purchase_order' | 'beo' | 'report' | 'document';

export const PAPERS: Record<Paper, { label: string; short: string; kind: 'sheet' | 'roll'; page: string; width?: number }> = {
  a4: { label: 'A4 portrait', short: 'A4', kind: 'sheet', page: 'A4 portrait' },
  'a4-landscape': { label: 'A4 landscape', short: 'A4 L', kind: 'sheet', page: 'A4 landscape' },
  a5: { label: 'A5', short: 'A5', kind: 'sheet', page: 'A5 portrait' },
  letter: { label: 'US Letter', short: 'Letter', kind: 'sheet', page: 'letter portrait' },
  thermal80: { label: '80 mm thermal roll', short: '80 mm', kind: 'roll', page: '80mm auto', width: 80 },
  thermal58: { label: '58 mm thermal roll', short: '58 mm', kind: 'roll', page: '58mm auto', width: 58 },
};
export const PAPER_ORDER: Paper[] = ['thermal80', 'thermal58', 'a4', 'a4-landscape', 'a5', 'letter'];
export const isRoll = (p: Paper) => PAPERS[p].kind === 'roll';

/** Which `print.*` setting governs each document type, and the built-in fallback. */
const DOC_SETTING: Record<DocType, { key: string; fallback: Paper }> = {
  receipt: { key: 'print.receipt_paper', fallback: 'thermal80' },
  ticket: { key: 'print.receipt_paper', fallback: 'thermal80' },
  shift: { key: 'print.receipt_paper', fallback: 'thermal80' },
  kitchen: { key: 'print.kitchen_paper', fallback: 'thermal80' },
  folio: { key: 'print.document_paper', fallback: 'a4' },
  confirmation: { key: 'print.document_paper', fallback: 'a4' },
  purchase_order: { key: 'print.document_paper', fallback: 'a4' },
  beo: { key: 'print.document_paper', fallback: 'a4' },
  report: { key: 'print.document_paper', fallback: 'a4-landscape' },
  document: { key: 'print.document_paper', fallback: 'a4' },
};
const isPaper = (v: any): v is Paper => typeof v === 'string' && v in PAPERS;

/** Per-device override (a bar tablet prints on a roll, the back office on A4) — kept in localStorage. */
export const devicePaper = {
  get(doc: DocType): Paper | null { try { const v = localStorage.getItem(`hms.print.${doc}`); return isPaper(v) ? v : null; } catch { return null; } },
  set(doc: DocType, paper: Paper | null) { try { paper ? localStorage.setItem(`hms.print.${doc}`, paper) : localStorage.removeItem(`hms.print.${doc}`); } catch { /* private mode */ } },
};

/** Effective paper for a document type: device override → property setting → built-in default. */
export function resolvePaper(doc: DocType, settings?: Record<string, any> | null): Paper {
  const dev = devicePaper.get(doc); if (dev) return dev;
  const def = DOC_SETTING[doc]; const s = settings?.[def.key];
  if (isPaper(s)) return doc === 'report' && s === 'a4' ? 'a4-landscape' : s;
  return def.fallback;
}

/** Escape text for direct interpolation into the HTML shell (templates themselves are React-rendered and safe). */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Render a pure React element tree to static HTML (no providers/hooks inside templates). */
export function renderToHtml(el: ReactElement): string {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(el));
  const html = host.innerHTML;
  root.unmount();
  return html;
}

const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Stylesheet shared by every document; `.sheet` / `.roll` on <body> switch between the two families. */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{color:#000;font-family:${FONT};-webkit-print-color-adjust:exact;print-color-adjust:exact;font-variant-numeric:tabular-nums;line-height:1.35}
img{max-width:100%}
table{border-collapse:collapse;width:100%}
th,td{vertical-align:top;text-align:left}
td.r,th.r{text-align:right}td.c,th.c{text-align:center}
.r{text-align:right}.c{text-align:center}.b{font-weight:700}.i{font-style:italic}.u{text-decoration:underline}
.muted{color:#444}.nowrap{white-space:nowrap}.pre{white-space:pre-wrap}.mono{font-family:${MONO}}
.brk{page-break-before:always;break-before:page}
.keep{page-break-inside:avoid;break-inside:avoid}
.row{display:flex;justify-content:space-between;gap:6px;align-items:baseline}
.row>span:last-child{white-space:nowrap}
.rule{border-top:1px solid #000;margin:6px 0}
.rule.dash{border-top:1px dashed #000}
.copy-tag{font-size:.8em;text-transform:uppercase;letter-spacing:.08em;color:#444}

/* ---------------- sheets (A4 / A5 / Letter) ---------------- */
body.sheet{font-size:10.5pt}
.sheet .doc{max-width:100%}
.sheet .lh{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px}
.sheet .lh .name{font-size:16pt;font-weight:700;letter-spacing:.01em}
.sheet .lh .addr{font-size:9pt;color:#333}
.sheet .lh .logo{max-height:60px;max-width:180px;object-fit:contain}
.sheet .lh .docbox{text-align:right;min-width:200px}
.sheet .lh .docbox .kind{font-size:15pt;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.sheet .lh .docbox .no{font-size:11pt;font-weight:600}
.sheet .lh .docbox .sub{font-size:9pt;color:#333}
.sheet .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 24px;margin:10px 0}
.sheet .box{border:1px solid #bbb;border-radius:3px;padding:6px 8px}
.sheet .box h4{margin:0 0 3px;font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#555}
.sheet .kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;font-size:9.5pt}
.sheet .kv dt{color:#555;margin:0}.sheet .kv dd{margin:0}
.sheet h1{font-size:14pt;margin:0 0 6px}
.sheet h2{font-size:11pt;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #999;padding-bottom:2px}
.sheet h3{font-size:10.5pt;margin:10px 0 4px}
.sheet table.items{margin:8px 0;font-size:9.5pt}
.sheet table.items thead{display:table-header-group}
.sheet table.items th{background:#eee;border:1px solid #999;padding:4px 6px;font-size:8.5pt;text-transform:uppercase;letter-spacing:.03em}
.sheet table.items td{border:1px solid #bbb;padding:4px 6px}
.sheet table.items tr{page-break-inside:avoid;break-inside:avoid}
.sheet table.items tfoot td{font-weight:700;background:#f4f4f4}
.sheet table.items .sub{font-size:8.5pt;color:#555}
.sheet table.items .strike{text-decoration:line-through;color:#777}
.sheet .totals{margin:6px 0 6px auto;width:min(100%,320px);font-size:10pt}
.sheet .totals .row{padding:2px 0}
.sheet .totals .grand{border-top:2px solid #000;margin-top:4px;padding-top:4px;font-size:12pt;font-weight:700}
.sheet .note{font-size:9pt;color:#333;margin:6px 0}
.sheet .foot{margin-top:18px;border-top:1px solid #999;padding-top:6px;font-size:8.5pt;color:#444;display:flex;justify-content:space-between;gap:12px}
.sheet .sig{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:24px;margin-top:36px}
.sheet .sig div{border-top:1px solid #000;padding-top:4px;font-size:9pt;color:#333}
.sheet .stamp{display:inline-block;border:2px solid #000;border-radius:4px;padding:2px 8px;font-weight:700;text-transform:uppercase;font-size:9pt}
.sheet .ticket-card{border:2px dashed #000;border-radius:6px;padding:14px;max-width:360px;margin:12px auto;text-align:center}
.sheet .big{font-size:22pt;font-weight:700;letter-spacing:.06em}
.sheet .report-meta{font-size:9pt;color:#444;margin-bottom:6px}
.sheet table.items.dense td,.sheet table.items.dense th{padding:2px 4px;font-size:8.5pt}

/* ---------------- rolls (80 mm / 58 mm) ---------------- */
body.roll{width:100%;padding:2mm 2mm 10mm;font-size:12px;line-height:1.3}
body.roll.w80{max-width:76mm;font-size:12px}
body.roll.w58{max-width:54mm;font-size:10px}
.roll .doc{width:100%}
.roll .lh{text-align:center;margin-bottom:4px}
.roll .lh .name{font-size:1.25em;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.roll .lh .addr{font-size:.9em}
.roll .lh .logo{max-height:44px;max-width:60%;object-fit:contain;margin:0 auto 3px;display:block;filter:grayscale(1)}
.roll .lh .docbox{margin-top:4px}
.roll .lh .docbox .kind{font-weight:700;text-transform:uppercase;font-size:1.1em}
.roll .lh .docbox .no{font-weight:700}
.roll .lh .docbox .sub{font-size:.9em}
.roll h1{font-size:1.2em;text-align:center;margin:4px 0;text-transform:uppercase}
.roll h2{font-size:1em;margin:6px 0 2px;text-transform:uppercase;border-bottom:1px dashed #000;padding-bottom:1px}
.roll h3{font-size:1em;margin:4px 0 2px}
.roll .grid{display:block}
.roll .box{margin:3px 0}
.roll .box h4{margin:0;font-size:.85em;text-transform:uppercase}
.roll .kv{display:grid;grid-template-columns:max-content 1fr;gap:0 6px;font-size:.95em}
.roll .kv dt{margin:0}.roll .kv dd{margin:0;text-align:right}
.roll table.items{font-size:1em;margin:2px 0}
.roll table.items th{border-bottom:1px solid #000;padding:1px 2px;font-size:.85em;text-transform:uppercase}
.roll table.items td{padding:1px 2px;border:0}
.roll table.items td.qty{white-space:nowrap;padding-right:4px}
.roll table.items td.amt{white-space:nowrap;text-align:right}
.roll table.items .sub{font-size:.9em;padding-left:10px;display:block}
.roll table.items .strike{text-decoration:line-through}
.roll table.items tfoot td{border-top:1px dashed #000;font-weight:700}
.roll .totals{margin:4px 0}
.roll .totals .row{padding:0}
.roll .totals .grand{font-size:1.25em;font-weight:700;border-top:1px solid #000;margin-top:2px;padding-top:2px}
.roll .note{font-size:.9em;margin:3px 0}
.roll .foot{text-align:center;margin-top:6px;font-size:.9em;border-top:1px dashed #000;padding-top:4px}
.roll .foot>span{display:block}
.roll .sig{margin-top:14px}
.roll .sig div{border-top:1px solid #000;padding-top:2px;font-size:.9em;margin-top:14px}
.roll .stamp{display:inline-block;border:1px solid #000;padding:0 4px;font-weight:700;text-transform:uppercase}
.roll .ticket-card{text-align:center;padding:4px 0}
.roll .big{font-size:1.8em;font-weight:700;letter-spacing:.06em}
.roll .kot .item{display:flex;gap:6px;font-size:1.25em;font-weight:700;padding:3px 0;border-bottom:1px dotted #000}
.roll .kot .item .q{min-width:2.2em;text-align:right}
.roll .kot .mods{font-size:.95em;font-weight:400;padding-left:2.6em}
.roll .kot .hdr{font-size:1.5em;font-weight:700;text-align:center;margin:2px 0}
.roll .report-meta{font-size:.9em;text-align:center}
.roll table.items.dense{font-size:.9em}
.roll .qr{display:block;margin:4px auto;width:60%}
.sheet .qr{display:block;margin:8px auto;width:150px}
.sheet .kot .item{display:flex;gap:10px;font-size:13pt;font-weight:700;padding:4px 0;border-bottom:1px dotted #000}
.sheet .kot .item .q{min-width:2.5em;text-align:right}
.sheet .kot .mods{font-size:10pt;font-weight:400;padding-left:3.2em}
.sheet .kot .hdr{font-size:16pt;font-weight:700;margin:4px 0}
`;

export function paperCss(paper: Paper): string {
  const p = PAPERS[paper];
  if (p.kind === 'sheet') return `@page{size:${p.page};margin:12mm 12mm 14mm}\n@media print{body{width:auto}}`;
  // Roll: zero margins; `size: <w> auto` is used where supported, otherwise the driver's roll size applies.
  return `@page{margin:0;size:${p.page}}`;
}

export interface BuildOptions { title: string; bodyHtml: string; paper: Paper; copies?: number; extraCss?: string }

/** Full HTML document for the print frame. */
export function buildDocument({ title, bodyHtml, paper, copies = 1, extraCss = '' }: BuildOptions): string {
  const p = PAPERS[paper];
  const bodyClass = p.kind === 'roll' ? `roll w${p.width}` : `sheet ${paper}`;
  const n = Math.min(Math.max(1, Math.floor(copies || 1)), 5);
  const copiesHtml = n === 1 ? bodyHtml : Array.from({ length: n }, (_, i) => `${i > 0 ? '<div class="brk"></div>' : ''}${bodyHtml}`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}\n${paperCss(paper)}\n${extraCss}</style></head><body class="${bodyClass}">${copiesHtml}</body></html>`;
}

const waitImages = (doc: Document) => Promise.all(Array.from(doc.images).filter((img) => !img.complete).map((img) => new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); })));

let active: HTMLIFrameElement | null = null;

/** Print an HTML fragment on the given paper. Resolves when the print dialog has been dismissed (or after a fallback delay on engines that do not report it). */
export function printHtml(opts: BuildOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    if (active) { active.remove(); active = null; }
    const html = buildDocument(opts);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('title', 'print');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    let done = false;
    // Removes the hidden frame once the print dialog is closed (afterprint) — or after a generous timeout on
    // browsers that never fire afterprint for frames (older iOS Safari). The promise itself resolves as soon as
    // the job has been handed to the browser so callers are not blocked while the dialog is open.
    const finish = () => { if (done) return; done = true; setTimeout(() => { frame.remove(); if (active === frame) active = null; }, 300); resolve(); };
    frame.onload = async () => {
      const win = frame.contentWindow; const doc = frame.contentDocument;
      if (!win || !doc) { finish(); return; }
      try { await Promise.race([Promise.all([waitImages(doc), (doc as any).fonts?.ready ?? Promise.resolve()]), new Promise((r) => setTimeout(r, 2500))]); } catch { /* print anyway */ }
      win.onafterprint = finish;
      try { win.focus(); win.print(); } catch { openFallback(html); finish(); return; }
      resolve();
      setTimeout(finish, 90_000);
    };
    active = frame;
    document.body.appendChild(frame);
    frame.srcdoc = html;
  });
}

/** Last resort when frame printing is blocked: open the document in a tab and let the user print from there. */
function openFallback(html: string) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open(); w.document.write(html + '<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>'); w.document.close();
}

/** Open the document in a new tab (preview / save as PDF) instead of printing straight away. */
export function previewHtml(opts: BuildOptions) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open(); w.document.write(buildDocument(opts)); w.document.close();
}
