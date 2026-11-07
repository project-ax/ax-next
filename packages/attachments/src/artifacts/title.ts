import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { ARTIFACT_TITLE_MAX } from '@ax/ipc-protocol';

// C0 (U+0000-U+001F) and C1 (U+007F-U+009F) controls, and the line and
// paragraph separators, become a space, so a line break between two words still
// separates them. Every other surface-rewriting character (zero-width,
// directional; the one class lives in @ax/core/surface-text) is then removed
// outright: they render as nothing, and the directional ones can make a title
// read differently from what it is.
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * The one spelling of an artifact title: NFC, one line, no invisible or
 * directional characters, whitespace collapsed and trimmed, 1..200 UTF-16 code
 * units. Anything else, including a non-string, is null. Titles come from the
 * agent (untrusted) or a person, and are shown to both.
 */
export function normalizeArtifactTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = replaceSurfaceRewriters(raw.normalize('NFC').replace(LINE_BREAKERS, ' '), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length === 0 || title.length > ARTIFACT_TITLE_MAX) return null;
  return title;
}
