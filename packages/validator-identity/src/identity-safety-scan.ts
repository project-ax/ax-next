// ---------------------------------------------------------------------------
// Identity content safety scan — the prompt-injection mitigation for an agent's
// self-authored identity files (.ax/IDENTITY.md, .ax/SOUL.md, .ax/AGENTS.md).
//
// A small, high-signal, PURE regex set (Layer 1 only — no LLM layer). The
// runner injects these files VERBATIM into the composed systemPrompt every
// spawn, so an injection signature hidden in an identity file is a system-prompt
// override primitive: it could disable the safety floor, jailbreak the agent, or
// exfiltrate the runner's secrets through the model. A signature here is a HARD
// veto on workspace:pre-apply (unlike validator-skill's skills:scan, which is
// accept-but-annotate — a quarantined skill is inert until promoted, but an
// identity file goes live on the next turn).
//
// This is a deliberate COPY of @ax/validator-skill's regexScan Layer 1
// (Invariant #2 forbids the cross-plugin runtime import). If the two regex sets
// drift, reconcile them. Layer 2 (the soft LLM scan) is intentionally omitted:
// identity self-edits are small and were authored by the agent in-session
// (lower injection surface than an installed third-party skill), so the regex
// wall is the proportionate gate for Phase 3. Adding an LLM layer later is a
// follow-up, not MVP.
// ---------------------------------------------------------------------------

type ScanCategory = 'instruction-override' | 'credential-exfiltration' | 'obfuscation';

export interface ScanHit {
  /** 'instruction-override' | 'credential-exfiltration' | 'obfuscation' */
  category: ScanCategory;
  /** Short, sanitized reason surfaced to the agent + a human. */
  reason: string;
}

// Bounded so we never echo a large attacker blob into logs/UI.
const MAX_REASON_LEN = 160;

function hit(category: ScanCategory, detail: string): ScanHit {
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
// Zero-width / bidi control characters (Trojan Source). Explicit \u escapes —
// never embed the literal invisible characters in source.
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Pure synchronous regex scan. Returns the FIRST category hit or null. Order:
 * instruction-override → credential-exfiltration → obfuscation (most actionable
 * reason first).
 */
export function regexScan(text: string): ScanHit | null {
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
  for (const line of text.split('\n')) {
    if (EGRESS_NEAR_SECRET.test(line) && !AUTH_HEADER.test(line)) {
      return hit('credential-exfiltration', 'possible credential/secret exfiltration');
    }
  }
  if (HIDDEN_CHARS.test(text)) return hit('obfuscation', 'hidden zero-width/bidi control characters');
  for (const re of OBFUSCATION_PATTERNS) {
    if (re.test(text)) return hit('obfuscation', 'suspicious obfuscation (base64 blob / eval(atob))');
  }
  return null;
}
