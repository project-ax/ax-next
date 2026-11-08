/**
 * The app's palette, offered to an artifact page as `--ax-*` CSS variables.
 *
 * An artifact runs in a sandboxed frame on a different site from the app, so
 * it can't see the app's colors. When the viewer asks for the light or dark
 * look (a signed claim in the view token, see view-token.ts), the content
 * origin adds one `<style>` block with the matching palette. A page that wants
 * to match the app writes `fill: var(--ax-chart-1)`; one that doesn't is
 * untouched.
 *
 * Why a prefix: pages define their own `--accent`, `--muted` and so on, often
 * as hex. An unprefixed block would either lose to those or overwrite them and
 * break the page's own text. `--ax-*` can't collide with anything it wrote.
 *
 * Why whole colors, not bare HSL triplets: `var(--ax-chart-1)` is a valid color
 * on its own. The `hsl(var(--x))` shape only works when `--x` is a triplet, and
 * a page that mixes the two draws nothing (black bars) with no error.
 *
 * Nothing here comes from the request, the artifact or the agent: two fixed
 * tables of values, copied from channel-web's `index.css` (a test keeps them
 * in step), so there is nothing to sanitize and nothing to inject through.
 */

export type ArtifactTheme = 'light' | 'dark';

export const ARTIFACT_THEMES: readonly ArtifactTheme[] = ['light', 'dark'];

/** Token name (without `--`) to a bare HSL triplet, as the app's stylesheet writes them. */
export const ARTIFACT_PALETTE: Readonly<Record<ArtifactTheme, Readonly<Record<string, string>>>> = {
  light: {
    background: '220.00 42.86% 98.63%',
    foreground: '201.82 8.27% 26.08%',
    card: '0.00 0.00% 100.00%',
    muted: '216.00 17.24% 94.31%',
    'muted-foreground': '201.18 8% 41%',
    border: '220.00 18.37% 90.39%',
    primary: '242.71 63.03% 58.63%',
    'primary-foreground': '0.00 0.00% 100.00%',
    accent: '243.75 100.00% 96.86%',
    destructive: '0 60% 49%',
    warning: '15 85% 36%',
    'chart-1': '242.71 63.03% 58.63%',
    'chart-2': '173 80% 29%',
    'chart-3': '28 90% 42%',
    'chart-4': '340 70% 47%',
    'chart-5': '201 90% 37%',
  },
  dark: {
    background: '226.67 15.25% 11.57%',
    foreground: '220.00 13.04% 90.98%',
    card: '226.15 14.94% 17.06%',
    muted: '226.15 14.94% 17.06%',
    'muted-foreground': '219.00 11.90% 67.06%',
    border: '225.00 13.11% 23.92%',
    primary: '245.33 100.00% 82.35%',
    'primary-foreground': '200.00 11.54% 10.20%',
    accent: '246.92 25.49% 20.00%',
    destructive: '4 86% 66%',
    warning: '15 100% 70%',
    'chart-1': '245.33 100% 82.35%',
    'chart-2': '168 60% 50%',
    'chart-3': '38 92% 60%',
    'chart-4': '340 85% 72%',
    'chart-5': '199 88% 62%',
  },
};

export function isArtifactTheme(v: unknown): v is ArtifactTheme {
  return v === 'light' || v === 'dark';
}

/** The `<style>` element for one theme. Constant text per theme. */
export function themeStyleElement(theme: ArtifactTheme): string {
  const vars = Object.entries(ARTIFACT_PALETTE[theme])
    .map(([name, triplet]) => `--ax-${name}:hsl(${triplet})`)
    .join(';');
  // `color-scheme` makes form controls and scrollbars inside the page follow the theme too.
  return `<style id="ax-theme">:root{${vars};color-scheme:${theme}}</style>`;
}

/** How far into the file we look for the place to insert. A tag deeper than this isn't the document's head. */
const SEARCH_BYTES = 8192;

/**
 * The page with the palette added, as the first thing in `<head>` (so the
 * page's own `<style>` still comes later and wins for anything it names).
 * Never before the doctype: text ahead of it puts the page in quirks mode.
 * With no `<head>`, after `<html>`, then after the doctype, then at the start.
 * The bytes are searched as latin1 (one byte, one character) so offsets are
 * byte offsets whatever the page's encoding.
 */
export function injectTheme(bytes: Uint8Array, theme: ArtifactTheme): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = buf.subarray(0, SEARCH_BYTES).toString('latin1');
  const at =
    endOfTag(head, /<head(?:\s[^>]*)?>/i) ??
    endOfTag(head, /<html(?:\s[^>]*)?>/i) ??
    endOfTag(head, /<!doctype[^>]*>/i) ??
    0;
  return Buffer.concat([buf.subarray(0, at), Buffer.from(themeStyleElement(theme), 'utf8'), buf.subarray(at)]);
}

function endOfTag(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m === null ? null : m.index + m[0].length;
}
