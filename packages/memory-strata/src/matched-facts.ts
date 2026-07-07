// Host-side fact-line matching for memory_search enrichment (enumeration
// design, D2). Term-match is deliberately naive — lowercase tokens, mutual
// prefix stemming — because it runs over the agent's OWN doc bodies as plain
// strings; no query text ever reaches a search engine on this path. The
// class-semantics gap ("citrus" won't match "lime") is handled by retrieval
// coaching (D3), not here.

// NOTE: 'user' is deliberately NOT in this list (deviation from the initial
// draft) — every fact line is written as "User <did something>", so treating
// 'user' as a stopword would make a literal `?query=user` (or any query whose
// only substantive-length token is "user") always short-circuit to [] before
// the maxLines cap ever runs, even though every fact line is a legitimate
// (if maximally unspecific) match.
//
// The cost is over-inclusion: a query carrying the token "user" matches ~every
// line. That's deliberately tolerated (TASK-203) because it's bounded by the
// per-doc / per-response caps in withMatchedFacts (memory-search.ts) + the
// truncation marker, over-inclusion is the safe direction for enumeration, and
// real queries rarely carry the literal token "user" (the user self-refers as
// I/me/my, all stopwords). Special-casing the leading "User " here would also
// break the maxLines cap test below, which relies on "user" matching it. If the
// `memory_strata_matched_facts_*_clipped` debug telemetry shows this cap binding
// often on real traffic, revisit then — with evidence, not on the synthetic case.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'my', 'i', 'me', 'did', 'do', 'does', 'how', 'many', 'much', 'what', 'when',
  'which', 'who', 'have', 'has', 'had', 'was', 'were', 'is', 'are',
]);

const DEFAULT_MAX_LINES = 20;

export function extractMatchedFacts(
  body: string,
  query: string,
  opts?: { maxLines?: number },
): string[] {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  if (maxLines <= 0) return [];
  const qTokens = tokenize(query).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (qTokens.length === 0) return [];

  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const words = tokenize(line);
    const hit = qTokens.some((q) =>
      words.some((w) => (w.length >= 3 && q.startsWith(w)) || w.startsWith(q)),
    );
    if (!hit) continue;
    out.push(line.slice(2));
    if (out.length >= maxLines) break;
  }
  return out;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}
