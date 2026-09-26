/**
 * The characters that let text rewrite the surface it is drawn on — the ONE
 * copy of that class in this repo (TASK-562, CLAUDE.md invariant 4).
 *
 * Import it from `@ax/core/surface-text`. That subpath is deliberate: this file
 * imports nothing, so the channel-web SPA can bundle it without pulling the
 * kernel's hook bus into the browser, and every plugin already depends on
 * `@ax/core`, so no consumer needs a cross-plugin import (invariant 2).
 * `scripts/__tests__/surface-text-single-owner.test.js` fails the PR that adds a
 * second, hand-written copy anywhere in production source.
 *
 * What is in the class, and why:
 *
 *   - C0 and C1 controls (U+0000–U+001F, U+007F–U+009F). A newline forges a
 *     second line in a label, a log or a hold note. TAB, LF and CR are
 *     included here; `stripSurfaceRewritersFromDocument` is the variant that
 *     keeps them.
 *   - Bidi controls: the embeddings and overrides U+202A–U+202E, the isolates
 *     U+2066–U+2069, and the marks U+200E, U+200F and U+061C. A lone U+202E
 *     reverses the visual order of everything after it (Trojan Source,
 *     CVE-2021-42574), and an unterminated isolate leaks that reordering into
 *     whatever the renderer draws next.
 *   - The zero-width family: U+200B–U+200D, the word joiner and invisible
 *     maths operators U+2060–U+2064, and U+FEFF (BOM / zero-width no-break
 *     space). Invisible, so two different strings look identical and a word
 *     can hide inside another.
 *   - LINE SEPARATOR and PARAGRAPH SEPARATOR (U+2028, U+2029). A renderer
 *     treats them as line breaks even though they are not CR/LF, so they forge
 *     a second line past a check that only looked for `\n`.
 *
 * Not every text fence uses this yet. Three strip C0/C1 controls ONLY, for
 * one-line log / prompt output, and let the bidi and zero-width half through:
 * `oneLine` in @ax/decisions `templates.ts`, `OTHER_CONTROLS` in @ax/memory
 * `render.ts`, and `sanitizeOneLine` in @ax/sandbox-protocol
 * `service-diagnosis.ts`. The single-owner guard cannot see them because they
 * name no bidi control. Whether they should adopt this class is a separate
 * follow-up, not something a reader should assume is already done.
 *
 * Before TASK-562 six of the seven copies of this class stopped short of
 * U+2060–U+2064 and U+2028/U+2029; they passed straight through.
 *
 * Written as `\uXXXX` escapes, never literal characters: an invisible character
 * in source is exactly the problem this file exists to fence, and a raw control
 * byte makes git treat the file as binary.
 */

/** The class body for C0/C1 controls. Composed below, not exported. */
const CONTROLS = '\\u0000-\\u001F\\u007F-\\u009F';

/** The class body for the invisible / direction-changing format characters. */
const FORMAT =
  '\\u061C\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF';

/** Controls minus TAB (U+0009), LF (U+000A) and CR (U+000D). */
const CONTROLS_EXCEPT_LAYOUT = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F';

/**
 * Matches ONE character that rewrites the surface: a control or an invisible /
 * bidi format character. Not global, so `.test()` carries no `lastIndex`
 * between calls and is safe to share.
 */
export const REWRITES_THE_SURFACE: RegExp = new RegExp(`[${CONTROLS}${FORMAT}]`);

/**
 * Matches ONE invisible or bidi format character, WITHOUT the C0/C1 controls.
 *
 * For scanners that read whole documents (a SKILL.md, an IDENTITY.md), where
 * newlines and tabs are the text's own structure rather than an attack. Not
 * global, for the same reason as `REWRITES_THE_SURFACE`.
 */
export const HIDDEN_FORMAT_CHARS: RegExp = new RegExp(`[${FORMAT}]`);

// Global run-matchers are private: a shared `/g` regex is only safe with
// `.replace`, and one caller reaching for `.test` would inherit another's
// `lastIndex`. The functions below are the only way out.
const SURFACE_RUNS = new RegExp(`[${CONTROLS}${FORMAT}]+`, 'g');
const DOCUMENT_REWRITERS = new RegExp(`[${CONTROLS_EXCEPT_LAYOUT}${FORMAT}]`, 'g');

/**
 * Replace each RUN of surface-rewriting characters with `replacement`.
 *
 * Pass `' '` (the default) for a label, so a name that leaned on a control to
 * separate two words still reads as two words; pass `''` for a token that has
 * to round-trip unchanged. Callers that want one plain line collapse the
 * remaining whitespace themselves.
 */
export function replaceSurfaceRewriters(value: string, replacement = ' '): string {
  return value.replace(SURFACE_RUNS, replacement);
}

/**
 * Remove every surface-rewriting character EXCEPT tab, newline and carriage
 * return — the variant for a document body, where those three are structure.
 */
export function stripSurfaceRewritersFromDocument(text: string): string {
  return text.replace(DOCUMENT_REWRITERS, '');
}
