// @vitest-environment node
/**
 * The filename sanitizer, on its own.
 *
 * Two routes now hand a file to a browser — the chat attachment download and
 * the workspace file downloads — and both put a name somebody else chose into
 * a header. The routes have their own tests; this is the rule set, tested
 * where a reader can see all of it at once.
 *
 * The inputs below are reachable from at least one caller: the workspace
 * routes run `workspaceFilePath` first, which rejects a colon or a `..` before
 * the name gets here, but the attachments route takes its display name
 * straight out of a multipart part, where none of that has happened.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_DOWNLOAD_FILENAME,
  sanitizeContentDispositionFilename,
} from '../util/content-disposition.js';

const s = sanitizeContentDispositionFilename;

describe('sanitizeContentDispositionFilename', () => {
  it('leaves an ordinary filename alone', () => {
    expect(s('quarterly-report v2.pdf')).toBe('quarterly-report v2.pdf');
    expect(s('notes_2026.md')).toBe('notes_2026.md');
  });

  it('keeps a leading dot — `.gitignore` is a name, not a path', () => {
    expect(s('.gitignore')).toBe('.gitignore');
  });

  it('removes the characters that end a header or a parameter', () => {
    // A quote closes the filename early; a CR or LF ends the header, which is
    // response splitting; a semicolon starts a new parameter.
    expect(s('a"b.md')).toBe('a_b.md');
    expect(s('a\r\nX-Evil- 1.md')).toBe('a__X-Evil- 1.md');
    expect(s('a;b.md')).toBe('a_b.md');
    expect(s('a\\b.md')).toBe('a_b.md');
  });

  it('is an ALLOW-LIST, so an unfamiliar character does not need naming', () => {
    // The point of the allow-list: nothing here had to be anticipated.
    // Four Cyrillic letters, four underscores. This is the cost of not doing
    // RFC 5987 yet: a non-ASCII name downloads legible-ish rather than right.
    expect(s('файл.md')).toBe('____.md');
    expect(s('a‮bmd.exe')).toBe('a_bmd.exe');
    expect(s('emoji🙂.png')).toBe('emoji__.png');
  });

  it('caps the length rather than letting a name run', () => {
    expect(s('a'.repeat(400))).toHaveLength(255);
  });

  it('falls back when nothing legible survives', () => {
    /*
      `.` and `..` are PATHS on the machine this is about to be saved to, and
      both sail straight through an allow-list that (rightly) keeps dots. An
      empty `filename=""` is not a neutral outcome either — the browser then
      names the file after the last URL segment, which on these routes is a
      percent-encoded blob. So we name it ourselves.
    */
    expect(s('..')).toBe(FALLBACK_DOWNLOAD_FILENAME);
    expect(s('.')).toBe(FALLBACK_DOWNLOAD_FILENAME);
    expect(s('...')).toBe(FALLBACK_DOWNLOAD_FILENAME);
    expect(s('   ')).toBe(FALLBACK_DOWNLOAD_FILENAME);
    expect(s('')).toBe(FALLBACK_DOWNLOAD_FILENAME);
  });

  it('does NOT fall back for a name that merely starts with dots', () => {
    // `..hidden.md` is a legible name. Collapsing it to `download` would lose
    // information over a rule that was about `.` and `..` specifically.
    expect(s('..hidden.md')).toBe('..hidden.md');
  });

  it('never returns a string that can close the quoted parameter', () => {
    // The property behind every case above, asserted as a property.
    for (const input of [
      'a"b',
      '""',
      'x";y="z',
      '\r\n\r\n',
      '\u0000name',
      '..',
      'a'.repeat(400),
    ]) {
      const out = s(input);
      expect(out).not.toContain('"');
      expect(out).not.toContain('\r');
      expect(out).not.toContain('\n');
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(255);
    }
  });
});
