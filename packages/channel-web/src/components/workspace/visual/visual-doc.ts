// Builds the srcdoc for a chat visual's sandboxed frame. This file is the box.
//
// The agent's HTML is untrusted. It renders inside `sandbox="allow-scripts"`
// (an opaque origin: no cookies, no app DOM, no same-origin anything), and the
// document we wrap it in opens with a CSP meta that denies every load CSP
// governs. CSP does not govern WebRTC (RTCPeerConnection's ICE/STUN traffic),
// so the frame runtime removes the WebRTC constructors before any agent markup
// runs. That meta has to be the very first thing in <head>: a policy only governs
// what is parsed after it, so nothing — not our own styles, and certainly not
// the agent's markup — may come before it. The agent's HTML goes last, into
// <body>. If it brings its own <html>/<head>/<meta CSP>, the parser drops or
// demotes those (a CSP meta outside <head> is ignored, and a second policy
// could only ever narrow ours anyway).
//
// The standalone HTML download gets the same box: an outer page with no
// scripts at all, holding the visual in a sandboxed srcdoc frame. Opened from
// disk there's no app around it to set frame-src, so the outer page sets it.
//
// Assets (fonts, library sources, runtime) are passed in rather than imported,
// so the ~230 KB of library text stays in a lazily-loaded chunk.

/** Denies every load CSP covers. Not WebRTC: the frame runtime removes that. */
export const VISUAL_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The app shell's own policy (index.html). Srcdoc frames still load, but a
 * visual can't navigate its frame to a URL: that navigation is checked against
 * the embedder's frame-src, which the frame's own CSP has no say over.
 */
export const APP_FRAME_CSP = "frame-src 'none'";

/** Scripts only. Never add allow-same-origin: with it, the frame could reach the app. */
export const VISUAL_IFRAME_SANDBOX = 'allow-scripts';

/**
 * The outer page of a standalone download. No scripts may run there; frame-src
 * 'none' stops the inner visual navigating its frame to a URL.
 */
export const VISUAL_STANDALONE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export const VISUAL_MIN_HEIGHT = 48;
export const VISUAL_DEFAULT_HEIGHT = 280;
export const VISUAL_MAX_HEIGHT = 1200;

export const VISUAL_TOKEN_NAMES: readonly string[] = Object.freeze([
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--warning',
  '--ring',
  '--radius',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
]);

export type VisualMode = 'light' | 'dark';

export interface VisualAssets {
  fontFaceCss: string;
  librarySources: readonly string[];
  runtimeSource: string;
}

export interface VisualDocInput {
  html: string;
  mode: VisualMode;
  tokens: Readonly<Record<string, string>>;
  /** A downloaded HTML file opened on its own: the visual is boxed in a sandboxed frame. */
  standalone?: boolean;
  /** Page and frame title for the standalone download. */
  title?: string;
}

// A bare HSL triplet ("226.67 15.25% 11.57%") or a single length ("0.5625rem").
// Anything else — semicolons, braces, angle brackets, url() — can't match, so a
// value can never close the style block or add a declaration.
const TOKEN_VALUE = /^(?:\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:rem|px))$/;

export function sanitizeTokens(tokens: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of VISUAL_TOKEN_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
    const raw = tokens[name];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (TOKEN_VALUE.test(value)) out[name] = value;
  }
  return out;
}

export function readThemeTokens(root: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  const raw: Record<string, string> = {};
  for (const name of VISUAL_TOKEN_NAMES) raw[name] = style.getPropertyValue(name);
  return sanitizeTokens(raw);
}

/**
 * Makes source text safe to sit inside a <script> element: `</script` would end
 * the element early, and `<!--` can flip the parser into a state where the
 * real `</script>` no longer closes it.
 */
export function inlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

// The vendored UMD builds end with a sourceMappingURL comment. The frame can't
// fetch the map, so devtools would just log a failed load for every visual.
function stripSourceMap(source: string): string {
  return source.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, '');
}

const BASE_CSS =
  'html{overflow:hidden}' +
  "body{margin:0;padding:12px 16px 16px;background:transparent;color:hsl(var(--card-foreground));font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-feature-settings:'cv11';letter-spacing:-0.005em;-webkit-font-smoothing:antialiased}" +
  'h1,h2,h3{margin:0 0 8px;font-weight:600;line-height:1.3}h1{font-size:20px}h2{font-size:16px}h3{font-size:14px}' +
  'p{margin:0 0 8px}small,.muted{color:hsl(var(--muted-foreground))}' +
  'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid hsl(var(--border))}th{font-weight:500;color:hsl(var(--muted-foreground))}' +
  'code,pre,kbd{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12.5px}' +
  'canvas,svg,img{max-width:100%}';

// Inside the standalone frame: it fills the window, so let it scroll.
const STANDALONE_FRAME_CSS =
  'html{overflow:auto;background:hsl(var(--card))}body{max-width:720px;margin:24px auto}';

const STANDALONE_PAGE_CSS =
  'html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}';

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildVisualDocument(input: VisualDocInput, assets: VisualAssets): string {
  if (!input.standalone) return buildFrameDocument(input, assets, '');
  const title = escapeAttr(input.title?.trim() || 'Visual');
  const frame = buildFrameDocument(input, assets, STANDALONE_FRAME_CSS);
  return (
    '<!doctype html><html lang="en"><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_STANDALONE_CSP}">` +
    '<meta charset="utf-8">' +
    `<title>${title}</title>` +
    `<style>${STANDALONE_PAGE_CSS}</style>` +
    '</head><body>' +
    `<iframe sandbox="${VISUAL_IFRAME_SANDBOX}" title="${title}" srcdoc="${escapeAttr(frame)}"></iframe>` +
    '</body></html>'
  );
}

function buildFrameDocument(input: VisualDocInput, assets: VisualAssets, extraCss: string): string {
  // Trusted asset text, but it sits raw in a <style>: refuse anything that could close it.
  if (/<\/style/i.test(assets.fontFaceCss)) throw new Error('visual font CSS must not contain </style');
  // Typed as VisualMode, but this lands in an attribute and a CSS value, so pin it.
  const mode: VisualMode = input.mode === 'dark' ? 'dark' : 'light';
  const tokens = sanitizeTokens(input.tokens);
  const themeCss =
    ':root{' +
    Object.entries(tokens)
      .map(([name, value]) => `${name}:${value};`)
      .join('') +
    `color-scheme:${mode}}`;
  const baseCss = BASE_CSS + extraCss;
  const libraries = assets.librarySources
    .map((source) => `<script>${inlineScript(stripSourceMap(source))}</script>`)
    .join('');
  const runtime = `<script>${inlineScript(`${assets.runtimeSource}\naxVisualRuntime(window, parent);`)}</script>`;

  return (
    `<!doctype html><html lang="en" data-theme="${mode}" data-max-height="${VISUAL_MAX_HEIGHT}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_FRAME_CSP}">` +
    '<meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8">' +
    `<style id="ax-fonts">${assets.fontFaceCss}</style>` +
    `<style id="ax-theme">${themeCss}</style>` +
    `<style id="ax-base">${baseCss}</style>` +
    libraries +
    runtime +
    `</head><body>${input.html}</body></html>`
  );
}

/** A download name built from the title: plain characters only, never a path. */
export function visualFileName(title: string, ext: 'png' | 'html'): string {
  const base = title
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots and spaces together, so ". .bashrc" can't come out hidden.
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim();
  return `${base || 'visual'}.${ext}`;
}
