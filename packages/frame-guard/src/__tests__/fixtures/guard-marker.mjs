// What a page the transform made contains, and so what the pool looks for in an answer: the opening of the guard's <script> and
// the guard's text (src/frame-guard.js, which is the package's FRAME_GUARD_SOURCE). The stand-in workers put it in front of what
// they say, so that their answers are ones the pool accepts; the tests take it off again. Plain JavaScript, so Node runs it as it is.
import { readFileSync } from 'node:fs';

export const GUARD_MARKER = `<script>${readFileSync(new URL('../../frame-guard.js', import.meta.url), 'utf8')}`;

/** The bytes of an answer that says `text`, with the guard in front of it. */
export const withGuard = (text) => new TextEncoder().encode(GUARD_MARKER + text);
