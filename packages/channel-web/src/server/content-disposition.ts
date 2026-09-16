/**
 * The one sanitizer for a filename we put in a `Content-Disposition` header.
 *
 * It lives on its own because there are now TWO routes that hand a file to a
 * browser — the chat attachment download (`routes-attachments.ts`) and the
 * workspace file downloads (`routes-workspace.ts`) — and the name going into
 * that header is agent- or user-authored either way. Two copies of a header
 * sanitizer is two places a fix has to land and one place it silently doesn't
 * (invariant 4).
 *
 * WHAT THE HEADER CAN BE MADE TO DO. Browsers parse `Content-Disposition`
 * loosely and historically forgivingly. A quote ends the filename early, a
 * semicolon starts a new parameter, and a CR or LF ends the HEADER — which, on
 * a server that did not filter it, is response splitting. So this is an
 * ALLOW-LIST, not a block-list: `[A-Za-z0-9._ -]` survives and every other
 * character becomes `_`. Nothing has to be enumerated, which is the property
 * that makes it hold up against the next encoding trick.
 *
 * It is deliberately NOT RFC 5987 (`filename*=UTF-8''…`). A non-ASCII filename
 * therefore downloads with underscores where its characters were, which is a
 * cosmetic loss on a header, and the alternative is a second encoding to get
 * wrong. Worth revisiting when someone complains; not worth guessing at now.
 */

/**
 * What a name sanitizes DOWN TO when nothing legible survives.
 *
 * `filename=""` is not a neutral outcome — browsers fall back to the last URL
 * path segment, which on these routes is a percent-encoded blob, or to
 * `download` with no extension. Naming the fallback ourselves means the worst
 * case is a file the person can find on their disk rather than one they cannot.
 */
export const FALLBACK_DOWNLOAD_FILENAME = 'download';

/** How much of a name the header will carry. */
const FILENAME_MAX_CHARS = 255;

/**
 * A name made of nothing but dots and spaces. `.`, `..`, `...`, `' '` — each of
 * them is a PATH or an empty string to the filesystem this is about to be saved
 * to, not a filename, and each of them survives the allow-list above intact.
 * A leading dot on a real name (`.gitignore`) is a name and is kept.
 */
const NOTHING_LEGIBLE = /^[.\s]*$/;

export function sanitizeContentDispositionFilename(displayName: string): string {
  const cleaned = displayName
    .slice(0, FILENAME_MAX_CHARS)
    .replace(/[^A-Za-z0-9._ -]/g, '_');
  return NOTHING_LEGIBLE.test(cleaned) ? FALLBACK_DOWNLOAD_FILENAME : cleaned;
}
