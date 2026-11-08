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

/**
 * The `<style>` element for one theme. Constant text per theme, and no attribute and no quote or angle
 * bracket in it: dropped into the wrong place (it never should be) it could not close a quote or a tag.
 */
export function themeStyleElement(theme: ArtifactTheme): string {
  const vars = Object.entries(ARTIFACT_PALETTE[theme])
    .map(([name, triplet]) => `--ax-${name}:hsl(${triplet})`)
    .join(';');
  // `color-scheme` makes form controls and scrollbars inside the page follow the theme too.
  return `<style>:root{${vars};color-scheme:${theme}}</style>`;
}

/**
 * How far into the page we look for the end of the guard's script. The guard is about 25 KiB; the rest is the
 * room an author's `<html>` attributes and comments get ahead of it. A page that spends more than that is
 * served without the palette, which is the safe way for this to fail.
 */
const SEARCH_BYTES = 256 * 1024;

/** What the frame guard's rewrite always puts first in `<head>` (prepare-html.ts, GUARD_MARKER). */
const GUARD_OPEN = '<head><script>';

/**
 * Where the palette goes in a page that has been through the frame guard's rewrite: straight after the
 * guard's own `<script>` element, so the guard stays first and the page's own styles still come later.
 *
 * It does not search for "<head>". That text can be anywhere in the author's markup that the rewrite keeps:
 * inside an attribute of `<html>`, in an attribute name, in the doctype name, in a comment. A block put
 * there would close the tag early and turn the rest of the author's text into live markup AHEAD of the guard,
 * where its script runs before the WebRTC locks exist. Instead this reads the one shape the rewrite writes
 * (any comments, a `<!DOCTYPE name>`, `<html` with each attribute as ` name="value"`, then the guard) as a
 * browser would, step by step, and answers null for anything else.
 */
function insertionPoint(s: string): number | null {
  let i = 0;
  let sawHtml = false;
  while (!sawHtml) {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return null;
      i = end + 3;
    } else if (s.startsWith('<!DOCTYPE ', i)) {
      const end = s.indexOf('>', i);
      if (end < 0) return null;
      i = end + 1;
    } else if (s.startsWith('<html', i)) {
      sawHtml = true;
      i += 5;
    } else {
      return null;
    }
  }
  for (;;) {
    const c = s[i];
    if (c === '>') {
      i += 1;
      break;
    }
    if (c !== ' ') return null;
    i += 1;
    let j = i;
    while (j < s.length && ' =>/'.indexOf(s[j] as string) < 0) j += 1;
    if (j === i || s[j] !== '=' || s[j + 1] !== '"') return null;
    const close = s.indexOf('"', j + 2);
    if (close < 0) return null;
    i = close + 1;
  }
  if (!s.startsWith(GUARD_OPEN, i)) return null;
  const end = s.indexOf('</script>', i + GUARD_OPEN.length);
  return end < 0 ? null : end + '</script>'.length;
}

/**
 * The page with the palette added, right after the frame guard's script in `<head>`. Only for a page the
 * guard's rewrite produced: any other shape comes back unchanged (no palette) rather than getting the block
 * somewhere a parser might read differently. The bytes are read as latin1 (one byte, one character) so
 * offsets are byte offsets whatever the page's encoding.
 */
export function injectTheme(bytes: Uint8Array, theme: ArtifactTheme): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = insertionPoint(buf.subarray(0, SEARCH_BYTES).toString('latin1'));
  if (at === null) return bytes;
  return Buffer.concat([buf.subarray(0, at), Buffer.from(themeStyleElement(theme), 'utf8'), buf.subarray(at)]);
}
