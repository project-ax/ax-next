// Query expansion for the FAIR reranker config (TASK-192).
//
// The prior reranker test (config B, zerank-2) ran with NO query expansion — one
// of the three reasons it was an unfair test. SmartSearch (arXiv 2603.15599) pairs
// its local cross-encoder with query expansion (pseudo-relevance feedback + entity
// discovery) before retrieval. This module implements that expansion as a PURE,
// deterministic function so it is fully testable in CI without any model or keys.
//
// Two signals are combined into the expanded query string:
//   1. PRF (pseudo-relevance feedback): run a first-pass BM25, harvest the most
//      frequent content terms from the top-k hit BODIES (minus stopwords and terms
//      already in the query), and append them. This pulls in vocabulary the user
//      didn't type but that co-occurs with the answer.
//   2. Entity discovery: lift capitalized multi-word spans and quoted phrases out
//      of the original query and repeat them, boosting their weight in the BM25
//      re-query (proper nouns are usually the load-bearing terms in a memory recall
//      question — "the Patagonia jacket", "Dr. Alvarez").

/** Hits from the first-pass retrieval, used as the PRF feedback set. */
export interface PrfHit {
  body: string;
}

export interface ExpandQueryOptions {
  /** How many PRF terms to append (default 10). */
  prfTermCount?: number;
  /** Minimum token length for a PRF term to be eligible (default 3). */
  minTermLength?: number;
  /** Override the stopword set (defaults to {@link DEFAULT_STOPWORDS}). */
  stopwords?: ReadonlySet<string>;
}

// A compact English stopword list. Deliberately small + inline (no new dep): PRF
// only needs to drop the highest-frequency function words that would otherwise
// dominate the term-frequency ranking.
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'like', 'through',
  'after', 'over', 'between', 'out', 'against', 'during', 'without', 'before',
  'under', 'around', 'among', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'have', 'has', 'had', 'having', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should',
  'now', 'there', 'here', 'from', 'up', 'down', 'would', 'could', 'did', 'get',
  'got', 'one', 'two', 'also', 'said', 'user', 'assistant',
]);

/** Lowercase word tokens (letters/digits/apostrophes), 1+ chars. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

/**
 * Discover candidate entities in the query: quoted phrases first (highest signal),
 * then capitalized multi-word spans (e.g. "San Francisco", "Dr. Alvarez"). Returns
 * each entity once, in first-seen order. Single capitalized words are included only
 * when they are not the sentence-initial word (which is capitalized by grammar, not
 * because it is a proper noun).
 */
export function discoverEntities(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (phrase: string) => {
    const p = phrase.trim();
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  // 1. Quoted phrases ("..." or '...').
  const quoted = query.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  for (const q of quoted) add(q.slice(1, -1));

  // 2. Capitalized multi-word spans, plus standalone non-initial capitalized words.
  //    Allow internal "." (Dr.) and "'" (O'Brien). Split into sentence-ish chunks so
  //    a leading capital after "? " isn't mistaken for a mid-sentence proper noun.
  const words = query.split(/\s+/);
  let run: string[] = [];
  let runStartIdx = -1;
  const flush = () => {
    if (run.length >= 2) {
      add(run.join(' '));
    } else if (run.length === 1 && runStartIdx > 0) {
      // Single capitalized word: keep only if not query-initial.
      add(run[0]!);
    }
    run = [];
    runStartIdx = -1;
  };
  const isCapWord = (w: string) => /^[A-Z][A-Za-z'.]*$/.test(w.replace(/[^A-Za-z'.]+$/, ''));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const cleaned = w.replace(/[^A-Za-z'.]+$/, '');
    if (cleaned && isCapWord(cleaned)) {
      if (run.length === 0) runStartIdx = i;
      run.push(cleaned);
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Harvest the top PRF terms from the first-pass hit bodies: content tokens ranked by
 * frequency, dropping stopwords, short tokens, pure numbers, and anything already in
 * the query. Deterministic tie-break: higher frequency first, then alphabetical.
 */
export function prfTerms(
  query: string,
  hits: ReadonlyArray<PrfHit>,
  opts: ExpandQueryOptions = {},
): string[] {
  const stop = opts.stopwords ?? DEFAULT_STOPWORDS;
  const minLen = opts.minTermLength ?? 3;
  const count = opts.prfTermCount ?? 10;
  const inQuery = new Set(tokenize(query));
  const freq = new Map<string, number>();
  for (const hit of hits) {
    for (const tok of tokenize(hit.body)) {
      if (tok.length < minLen) continue;
      if (stop.has(tok)) continue;
      if (inQuery.has(tok)) continue;
      if (/^[0-9]+$/.test(tok)) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([term]) => term);
}

/**
 * Build the expanded query string fed to the second-pass BM25 retrieval:
 * `<original query> <discovered entities…> <PRF terms…>`. With no PRF hits and no
 * entities, returns the original query unchanged (a clean passthrough).
 */
export function expandQuery(
  query: string,
  hits: ReadonlyArray<PrfHit>,
  opts: ExpandQueryOptions = {},
): string {
  const entities = discoverEntities(query);
  const terms = prfTerms(query, hits, opts);
  const parts = [query, ...entities, ...terms].map((p) => p.trim()).filter(Boolean);
  return parts.join(' ');
}
