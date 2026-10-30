// ---------------------------------------------------------------------------
// Identity content safety scan — the prompt-injection mitigation for the text
// an agent's system prompt carries about itself.
//
// Two callers:
//   - `scanIdentityText` (TASK-989) backs the `identity:scan` service.
//     @ax/agents calls it on every identity, soul and Instructions write, and
//     refuses the write on anything but `clean`. That text is frozen into the
//     session config at spawn and composed VERBATIM into the system prompt.
//     Instructions (kind 'instructions') skip only the weak egress-near-secret
//     heuristic, which refuses ordinary instructions; see IdentityTextKind.
//   - `regexScan` alone backs the legacy `workspace:pre-apply` gate on the
//     `.ax/` identity files (see plugin.ts), which the runner no longer reads.
//
// A small, high-signal, PURE regex set (Layer 1 only — no LLM layer). Because
// the text goes into the system prompt verbatim, an injection signature hidden
// in it is a system-prompt override primitive: it could disable the safety
// floor, jailbreak the agent, or exfiltrate the runner's secrets through the
// model. A signature is therefore a HARD refusal (unlike validator-skill's
// skills:scan, which is accept-but-annotate — a quarantined skill is inert
// until promoted, but identity text goes live on the next turn).
//
// This is a deliberate COPY of @ax/validator-skill's regexScan Layer 1
// (Invariant #2 forbids the cross-plugin runtime import). If the two regex sets
// drift, reconcile them. Layer 2 (the soft LLM scan) is intentionally omitted:
// identity self-edits are small and were authored by the agent in-session
// (lower injection surface than an installed third-party skill), so the regex
// wall is the proportionate gate for Phase 3. Adding an LLM layer later is a
// follow-up, not MVP.
// ---------------------------------------------------------------------------

import { HIDDEN_FORMAT_CHARS } from '@ax/core/surface-text';

/**
 * Why a text was refused. `regexScan` only ever reports the last three; the
 * first two are `scanIdentityText`'s own checks on the text's shape.
 */
export type IdentityScanCategory =
  | 'too-large'
  | 'not-well-formed'
  | 'instruction-override'
  | 'credential-exfiltration'
  | 'obfuscation';

export interface ScanHit {
  category: IdentityScanCategory;
  /** Short, sanitized reason surfaced to the agent + a human. */
  reason: string;
}

// Bounded so we never echo a large attacker blob into logs/UI.
const MAX_REASON_LEN = 160;

function hit(category: IdentityScanCategory, detail: string): ScanHit {
  const reason = `flagged by identity safety scan (${category}): ${detail}`;
  return { category, reason: reason.slice(0, MAX_REASON_LEN) };
}

// --- Layer 1: pure regex --------------------------------------------------

const INSTRUCTION_OVERRIDE: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier|the\s+above)\s+(instructions|prompts?|messages|context|rules)/i,
  /disregard\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|system|safety|instructions)/i,
  /\b(developer|debug|god|jailbreak|dan)\s+mode\b/i,
  /\byou\s+are\s+now\s+(in\s+)?(dan|developer|jailbreak|god)\b/i,
  /(reveal|print|repeat|leak|show)\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions)/i,
];

const SECRET = '(api[_\\s-]?keys?|secret|token|password|credential|env(?:ironment)?\\s+var)';
const EGRESS = '(send|post|upload|exfiltrate|leak|transmit|curl|wget|fetch|http\\b)';

// STRONG exfil signals: a secret sent as request DATA (a curl/http body flag),
// or a secret routed TO an external URL / webhook / "exfil". Unambiguous — fire
// even inside an auth-header line.
const CRED_EXFIL_STRONG: RegExp[] = [
  new RegExp(
    `(-d\\b|--data(?:-raw|-binary|-urlencode)?\\b|--form\\b|\\b(?:body|payload|data)\\b[^\\n]{0,12}[:=])[^\\n]{0,40}${SECRET}`,
    'i',
  ),
  new RegExp(`${SECRET}[^\\n]{0,80}(to\\s+https?://|webhook|exfil)`, 'i'),
];

// WEAK signal: an egress VERB sitting near a secret. High recall but it
// false-trips on the legitimate "use my own credential via an Authorization
// header" pattern; only flag this weak signal when the surrounding line is NOT
// an auth-header use (the STRONG patterns above still catch real exfil even
// inside an auth line).
const EGRESS_NEAR_SECRET = new RegExp(`${EGRESS}[^\\n]{0,80}${SECRET}`, 'i');
const AUTH_HEADER = /(authorization\s*:|bearer\b|-H\b|--header\b)/i;

const OBFUSCATION_PATTERNS: RegExp[] = [
  // NOTE: These patterns match the string literals "eval" and "atob" AS THEY
  // APPEAR in the identity file being scanned — this code does NOT execute
  // eval(). It is a detector for obfuscated payloads hidden in a SOUL.md/etc.
  /\b(eval|Function)\s*\(\s*atob\s*\(/i,
  /[A-Za-z0-9+/]{220,}={0,2}/, // long base64 run
];
// Zero-width / bidi / invisible format characters (Trojan Source) — the shared
// class from `@ax/core/surface-text`, minus C0/C1 controls because a document's
// newlines and tabs are its own structure (TASK-562; before it this was a
// narrower local copy that missed U+2060-2064, U+2028/9, U+061C and a mid-text
// U+FEFF). A leading BOM never reaches here: the strict TextDecoder consumes it.
const HIDDEN_CHARS = HIDDEN_FORMAT_CHARS;

/** `regexScan` options. Every default is validator-skill's behaviour. */
export interface RegexScanOptions {
  /**
   * Run the WEAK per-line egress-near-secret heuristic. Default true. Only
   * `scanIdentityText` turns it off, for people's Instructions (see
   * {@link IdentityTextKind}).
   */
  egressNearSecret?: boolean;
}

/**
 * Pure synchronous regex scan. Returns the FIRST category hit or null. Order:
 * instruction-override → credential-exfiltration → obfuscation (most actionable
 * reason first).
 */
export function regexScan(text: string, opts: RegexScanOptions = {}): ScanHit | null {
  for (const re of INSTRUCTION_OVERRIDE) {
    if (re.test(text)) {
      return hit('instruction-override', 'possible prompt-injection / instruction override');
    }
  }
  // STRONG exfil signals fire regardless of context (incl. auth-header lines).
  for (const re of CRED_EXFIL_STRONG) {
    if (re.test(text)) return hit('credential-exfiltration', 'possible credential/secret exfiltration');
  }
  // WEAK egress-near-secret signal: evaluated PER LINE so an auth-header line
  // (legitimate credential USE) is spared while a genuine exfil line elsewhere
  // still trips.
  if (opts.egressNearSecret !== false) {
    for (const line of text.split('\n')) {
      if (EGRESS_NEAR_SECRET.test(line) && !AUTH_HEADER.test(line)) {
        return hit('credential-exfiltration', 'possible credential/secret exfiltration');
      }
    }
  }
  if (HIDDEN_CHARS.test(text)) return hit('obfuscation', 'hidden zero-width/bidi control characters');
  for (const re of OBFUSCATION_PATTERNS) {
    if (re.test(text)) return hit('obfuscation', 'suspicious obfuscation (base64 blob / eval(atob))');
  }
  return null;
}

// --- identity:scan (TASK-989) ----------------------------------------------

/**
 * The most UTF-8 bytes one scanned text may be: 256 KiB. The same ceiling the
 * runner used to put on each `.ax/` identity file it read; identity now
 * arrives as text, so the limit moved to the write.
 */
export const IDENTITY_TEXT_MAX_BYTES = 262_144;

/**
 * What a scanned text is, which picks how strict the credential check is:
 *
 *   - `self-description` (the default) — an agent's identity or soul. Mostly
 *     written by the agent itself, so model output: the full check.
 *   - `instructions` — the standing instructions its people wrote. Every
 *     check but one: the WEAK egress-near-secret heuristic is skipped, because
 *     ordinary instructions trip it all the time ("Send my weekly report to my
 *     secretary", "Never post passwords in a chat", "the postgres token
 *     budget"). The STRONG exfiltration signatures, instruction overrides,
 *     obfuscation, hidden characters, lone surrogates and the size cap all
 *     still apply.
 */
export type IdentityTextKind = 'self-description' | 'instructions';

/** Every {@link IdentityTextKind}; `identity:scan` refuses any other `kind`. */
export const IDENTITY_TEXT_KINDS: readonly IdentityTextKind[] = ['self-description', 'instructions'];

/** `identity:scan` input. `kind` absent means `self-description`. */
export interface IdentityScanInput {
  text: string;
  kind?: IdentityTextKind;
}

/**
 * `identity:scan` output. A caller saves the text only on exactly
 * `{ verdict: 'clean' }`; `reason` is a fixed sentence of at most 160
 * characters that names the category and never quotes the text.
 */
export type IdentityScanOutput =
  | { verdict: 'clean' }
  | { verdict: 'refused'; category: IdentityScanCategory; reason: string };

// A UTF-16 surrogate half without its partner: a high not followed by a low,
// or a low not preceded by a high. A JS string cannot hold invalid UTF-8 bytes,
// so this is what "not valid UTF-8" means for one: it has no UTF-8 encoding
// (`Buffer` and `TextEncoder` quietly swap in U+FFFD, so the stored text would
// differ from what was scanned). `String.prototype.isWellFormed` is the same
// test, but it is ES2024 and this repo's TS lib is ES2023.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The `identity:scan` check. Pure. First match wins, cheapest and most
 * structural first:
 *   1. more than {@link IDENTITY_TEXT_MAX_BYTES} UTF-8 bytes → `too-large`
 *   2. a lone surrogate                                       → `not-well-formed`
 *   3. a `regexScan` signature                                → its category
 * Size goes first so the regexes never run over an oversized text. For
 * `kind: 'instructions'`, step 3 skips only the weak egress-near-secret
 * heuristic (see {@link IdentityTextKind}).
 */
export function scanIdentityText(
  text: string,
  kind: IdentityTextKind = 'self-description',
): IdentityScanOutput {
  const found =
    Buffer.byteLength(text, 'utf8') > IDENTITY_TEXT_MAX_BYTES
      ? hit('too-large', 'over the 256 KiB limit')
      : LONE_SURROGATE.test(text)
        ? hit('not-well-formed', 'text is not valid Unicode (lone surrogate)')
        : regexScan(text, { egressNearSecret: kind !== 'instructions' });
  if (found === null) return { verdict: 'clean' };
  return { verdict: 'refused', category: found.category, reason: found.reason };
}
