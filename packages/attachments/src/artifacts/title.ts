import { ARTIFACT_TITLE_MAX } from '@ax/ipc-protocol';

// C0 (U+0000-U+001F) and C1 (U+007F-U+009F) controls become a space, so a
// newline between two words still separates them.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// Zero-width, directional marks and embeddings/overrides/isolates, word joiner
// and invisible operators, BOM. Removed outright: they render as nothing, and
// the directional ones can make a title read differently from what it is.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * The one spelling of an artifact title: NFC, one line, no invisible or
 * directional characters, whitespace collapsed and trimmed, 1..200 UTF-16 code
 * units. Anything else, including a non-string, is null. Titles come from the
 * agent (untrusted) or a person, and are shown to both.
 */
export function normalizeArtifactTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw
    .normalize('NFC')
    .replace(CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length === 0 || title.length > ARTIFACT_TITLE_MAX) return null;
  return title;
}
