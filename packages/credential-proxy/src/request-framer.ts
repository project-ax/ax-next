/** Minimal substitution surface, satisfied by SharedCredentialRegistry. */
export interface Replacer {
  replaceAll(input: string): string;
  replaceAllBuffer(input: Buffer): Buffer;
}

/** First canary token present in `data`, or null. Mirrors the listener's existing `includes` scan. */
export function findCanaryHit(data: string | Buffer, tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  const hay = typeof data === 'string' ? data : data.toString('latin1');
  for (const token of tokens) {
    if (token && hay.includes(token)) return token;
  }
  return null;
}

export interface HeadTransform {
  head: Buffer;
  canaryToken: string | null;
}

// Matches `Authorization: Basic <b64>` / `Proxy-Authorization: Basic <b64>` (scheme case-insensitive).
const BASIC_AUTH_LINE_RE = /^((?:proxy-)?authorization):[ \t]*(basic)[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i;

/**
 * Decode → canary-scan → substitute → re-encode each Basic auth header in an HTTP
 * request head. All other bytes (including Bearer/Digest auth) are preserved 1:1
 * (latin1 round-trip). Re-encoding to base64 cannot emit CR/LF, so a malicious
 * decoded value cannot inject headers. If a canary token appears in any decoded
 * value, returns `{ canaryToken }` and leaves the head unmodified (caller blocks).
 */
export function transformBasicAuthHead(
  head: Buffer,
  replacer: Replacer,
  canaryTokens: readonly string[],
): HeadTransform {
  const lines = head.toString('latin1').split('\r\n');
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BASIC_AUTH_LINE_RE);
    if (!m) continue;
    const [, name, scheme, b64] = m;
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const hit = findCanaryHit(decoded, canaryTokens);
    if (hit) return { head, canaryToken: hit };
    const replaced = replacer.replaceAll(decoded);
    if (replaced !== decoded) {
      lines[i] = `${name}: ${scheme} ${Buffer.from(replaced, 'utf8').toString('base64')}`;
      mutated = true;
    }
  }
  if (!mutated) return { head, canaryToken: null };
  return { head: Buffer.from(lines.join('\r\n'), 'latin1'), canaryToken: null };
}
