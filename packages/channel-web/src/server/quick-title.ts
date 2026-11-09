import { KICKOFF_TEXT } from '../lib/bootstrap-kickoff.js';

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Long enough to recognise a chat by (in visible characters); the sidebar fades anything wider. */
export const QUICK_TITLE_MAX_CHARS = 60;

/**
 * A new chat's title until the title model has read the first exchange: the
 * opening line of the person's first message, so the chat is named in the
 * sidebar the moment it exists instead of reading "Untitled conversation"
 * while the first reply runs (or forever, when titling fails). Stored as
 * PROVISIONAL — `@ax/conversation-titles` replaces it with its summary, and
 * never replaces a rename.
 *
 * `null` when there is nothing to name it by (a file with no words) and for
 * the hidden greeting that wakes a new agent, which the person never typed.
 *
 * The words are the person's own and are shown only to them; the title is
 * still flattened to one line and fenced again on its way out like every
 * other label (`fenceLine` in routes-workspace).
 */
export function quickTitle(text: string): string | null {
  if (text.trim() === KICKOFF_TEXT) return null;
  const line = text
    .split(/\r?\n/)
    .map((l) =>
      l
        // Control characters, not just whitespace, would survive `\s+`.
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((l) => l.length > 0);
  if (line === undefined) return null;
  // Visible characters, not code points: a flag, a family emoji or a letter
  // with its accent is one character and is never cut in half.
  const chars = [...GRAPHEMES.segment(line)].map((g) => g.segment);
  if (chars.length <= QUICK_TITLE_MAX_CHARS) return line;
  const cut = chars.slice(0, QUICK_TITLE_MAX_CHARS - 1).join('');
  // End on a word when there is one to end on, not mid-word.
  const space = cut.lastIndexOf(' ');
  const head = space >= QUICK_TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}
