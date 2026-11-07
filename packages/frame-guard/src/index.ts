import { readFileSync } from 'node:fs';

// Shared defense for agent-authored HTML that runs in a sandboxed frame: the
// in-page guard script (WebRTC and child-context locks) plus the lists of
// markup that can open a child browsing context. Pure library: no plugin
// manifest, no hooks. The chat visual (channel-web) and the artifact content
// origin (attachments) both consume it, so the two can't drift apart.

/**
 * The guard runtime, as text, ready to be placed in a <script> element.
 * Defines `window.axFrameGuard(win, opts)`.
 *
 * Read from src/frame-guard.js whether this module runs from src/ (vitest) or
 * from dist/ (the compiled package), so a bare `tsc --build` is all it takes:
 * there is no copy step to forget. package.json `files` ships that one file
 * with dist/, and channel-web takes the same file as a raw string through the
 * `./frame-guard.js` export.
 */
export const FRAME_GUARD_SOURCE: string = readFileSync(
  new URL('../src/frame-guard.js', import.meta.url),
  'utf8',
);

/**
 * Elements that can give a document a child browsing context, plus
 * <noscript>: a parser with scripting off sees a <noscript> body as markup
 * while the frame (scripting on) sees raw text, the classic way to smuggle a
 * tag past a parse-and-check.
 */
export const CHILD_FRAME_TAGS: readonly string[] = [
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
  'fencedframe',
  'noscript',
];

/**
 * Attributes that turn a <template> into a declarative shadow root, which
 * hides its contents from a MutationObserver. Without them it's inert.
 */
export const DSD_ATTRS: readonly string[] = ['shadowrootmode', 'shadowroot'];
