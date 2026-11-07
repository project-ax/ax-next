import { readFileSync } from 'node:fs';

// Shared defense for agent-authored HTML that runs in a sandboxed frame: the
// in-page guard script (WebRTC and child-context locks) plus the lists of
// markup that can open a child browsing context. Pure library: no plugin
// manifest, no hooks. The chat visual (channel-web) and the artifact content
// origin (attachments) both consume it, so the two can't drift apart.

/**
 * The guard runtime, as text, ready to be placed in a <script> element. Read
 * from frame-guard.js next to this module (src/ when run from source, dist/
 * after the build copies it). Defines `window.axFrameGuard(win, opts)`.
 */
export const FRAME_GUARD_SOURCE: string = readFileSync(
  new URL('./frame-guard.js', import.meta.url),
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
