// Everything the chat-visuals frame needs that isn't the model's own HTML.
//
// The frame is a `sandbox="allow-scripts"` srcdoc with `default-src 'none'`,
// so it can't fetch a thing: the libraries ride in as source text and the font
// as data URLs. The library strings are only ever inlined into that frame —
// nothing here is executed in the app realm. This module is heavy (~230 KB of
// library text) and is meant to be lazy-loaded, never imported from the main
// entry.
//
// Pins (exact, in package.json devDependencies): chart.js 4.5.1,
// html-to-image 1.11.13. `ax-vendor/*` is resolved by `vendor-aliases.ts`.
//
// The Inter subsets are cut from the app's own TTFs in public/fonts with
// fonttools 4.61.1 (Latin + punctuation, arrows, math, geometric shapes):
//
//   for w in regular:400 medium:500 semibold:600; do
//     pyftsubset "packages/channel-web/public/fonts/inter-${w%%:*}.ttf" \
//       --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2070-209F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+25A0-25FF' \
//       --layout-features='*' --flavor=woff \
//       --output-file="packages/channel-web/src/components/workspace/visual/fonts/inter-${w##*:}-latin.woff"
//   done
import chartSource from 'ax-vendor/chart.umd.min.js?raw';
import htmlToImageSource from 'ax-vendor/html-to-image.js?raw';
import inter400 from './fonts/inter-400-latin.woff?inline';
import inter500 from './fonts/inter-500-latin.woff?inline';
import inter600 from './fonts/inter-600-latin.woff?inline';

type FontWeight = 400 | 500 | 600;

/** Library sources in load order: chart.js UMD, then html-to-image UMD. */
export const VISUAL_LIBRARY_SOURCES: readonly string[] = Object.freeze([
  chartSource,
  htmlToImageSource,
]);

export const INTER_FONT_URLS: Readonly<Record<FontWeight, string>> = Object.freeze({
  400: inter400,
  500: inter500,
  600: inter600,
});

export function fontFaceCss(urls: Readonly<Record<FontWeight, string>>): string {
  return ([400, 500, 600] as const)
    .map(
      (w) =>
        `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:block;src:url(${urls[w]}) format('woff')}`,
    )
    .join('');
}

export const VISUAL_FONT_FACE_CSS: string = fontFaceCss(INTER_FONT_URLS);
