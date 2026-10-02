/** The name AX presents to authorization servers when no branding is set. */
export const DEFAULT_CLIENT_NAME = 'AX';

/** Consent screens show this name to people deciding whether to grant access,
 * so it is display text from an admin-editable field, not trusted markup.
 * Strip control and bidi-override characters (which can visually reorder the
 * surrounding consent text), collapse whitespace, and cap the length. */
const MAX_CLIENT_NAME_CHARS = 64;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function oauthClientName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const capped = [...cleaned].slice(0, MAX_CLIENT_NAME_CHARS).join('').trim();
  return capped || DEFAULT_CLIENT_NAME;
}
