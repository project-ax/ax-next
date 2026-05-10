// Sensitive-content gate (Phase 1, design § "Sensitive-Content Gate").
//
// Pure regex-based filter. Runs against every Observation the Observer
// emits BEFORE that observation is written to inbox/. The whole point
// is that we'd rather drop a useful fact than persist a credential into
// the agent's memory tree (where it gets re-loaded into the context next
// turn — an automatic exfil channel for the next prompt-injection).
//
// I7 from the plan: this gate exists, has fixtures, and runs on every
// path that lands in inbox/. Phase 2 swaps these regex heuristics for the
// shared @ax/scanner-canary classifier (same one that vetoes secrets at
// workspace:pre-apply); the regexes here are the floor, not the ceiling.
//
// All patterns are intentionally over-broad. False positives drop a
// useful fact; false negatives leak a credential. We err toward
// false positives every time.

export type RejectionKind =
  | 'anthropic-api-key'
  | 'aws-access-key'
  | 'jwt'
  | 'email'
  | 'phone'
  | 'password-assignment'
  | 'secret-assignment';

export interface RejectedFact {
  kind: RejectionKind;
  /** Truncated match excerpt — never the full credential. Up to 4 chars + ellipsis. */
  excerpt: string;
}

export interface FilterResult {
  /** True iff every pattern missed. False if any pattern fired. */
  kept: boolean;
  /** One entry per pattern hit, in pattern-declaration order. */
  rejections: RejectedFact[];
}

interface Pattern {
  kind: RejectionKind;
  re: RegExp;
}

// Pattern registry. Order matters only for deterministic test output.
//
// Anthropic API key: documented format is `sk-ant-<env>-<token>`. We match
// the prefix and at least 20 of the alnum tail so a literal `sk-ant-foo`
// doesn't trigger but a real-shaped key does. CWE-798 (hardcoded
// credentials) is the relevant Common Weakness.
//
// AWS access key id: documented as 20 chars, prefixed `AKIA` (long-lived)
// or `ASIA` (session). Phase 1 only matches `AKIA*` — `ASIA*` is rare in
// extracted facts and we'll add it when we see one in the wild.
// Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html
//
// JWT: three base64url segments separated by `.`. Each segment must look
// like base64url and the first MUST start `eyJ` (which decodes to `{"`).
// This catches the overwhelmingly common case and avoids catching every
// dotted identifier.
//
// Email: RFC 5321 lite — local@domain.tld with a TLD of 2+ letters. We
// don't try to parse RFC-5321 fully because we don't need to validate,
// only flag.
//
// Phone (US): three common shapes — (NXX) NXX-XXXX, NXX-NXX-XXXX,
// NXX.NXX.XXXX. International numbers slip through; that's a Phase 2 gap.
//
// password= / secret= : conservative — looks for the literal token
// "password" or "secret" followed by `=` or `:` and a non-whitespace value.
// CWE-256 (cleartext storage of credentials).

const PATTERNS: Pattern[] = [
  { kind: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', re: /\bAKIA[A-Z0-9]{16}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: 'phone',
    re: /(?:\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/g,
  },
  { kind: 'password-assignment', re: /\bpassword\s*[:=]\s*\S+/gi },
  { kind: 'secret-assignment', re: /\bsecret\s*[:=]\s*\S+/gi },
];

// Excerpt length for log lines. Short enough that even a fully-leaked
// match wouldn't disclose a working credential — 4 chars of an
// `sk-ant-…` key, AKIA prefix, or `bob@` is enough to disambiguate
// pattern hits visually without giving an attacker reading the audit
// log usable material.
const EXCERPT_PREFIX_LEN = 4;

export function filterSensitive(text: string): FilterResult {
  const rejections: RejectedFact[] = [];
  for (const { kind, re } of PATTERNS) {
    const seen = new Set<string>();
    // matchAll iterates without mutating the regex's lastIndex across
    // calls, which is what we want for shared per-pattern globals.
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      rejections.push({ kind, excerpt: redactExcerpt(raw) });
    }
  }
  return { kept: rejections.length === 0, rejections };
}

/**
 * Truncate a match for logging. We never want the full credential in any
 * audit trail — even an "I rejected this" log line shouldn't carry it.
 *
 * ALWAYS truncates, even for short inputs. An earlier version returned
 * the raw match when length was below the threshold, which leaked
 * complete short secrets (a 6-char email, an 8-char `secret=a`, a
 * 10-char `password=a`) verbatim into operator logs. Per CLAUDE.md
 * invariant 5, untrusted content must not survive into operator-visible
 * surfaces in usable form.
 */
function redactExcerpt(raw: string): string {
  if (raw.length <= EXCERPT_PREFIX_LEN) return '…';
  return `${raw.slice(0, EXCERPT_PREFIX_LEN)}…`;
}
