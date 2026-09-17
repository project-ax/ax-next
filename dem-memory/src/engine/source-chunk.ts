/**
 * Attach a verbatim slice of the dialogue a fact was extracted from.
 *
 * Extraction is lossy and terminal: if the extractor compresses "seal the vase with Mod Podge"
 * into "suggested DIY projects", the detail does not exist in the bank and no amount of
 * retrieval depth recovers it. Measured at n=100 with a terse extractor (gpt-4.1-nano), 30 of
 * 56 answerable failures had the gold nowhere in the bank at all.
 *
 * Attribution is HEURISTIC by design. The extractor returns no pointer back to the turn a fact
 * came from, and asking it for one would change the extraction prompt — which re-keys the fact
 * cache and forces a full cold re-extract of every session. Scoring each turn against the fact
 * costs nothing, needs no model call, and is good enough for what this is: a safety net that
 * puts the neighbouring raw text in front of the answerer.
 */

const STOPWORDS = new Set(
  ("the a an and or of to in on for with that this it is was were be been have has had you your" +
    " i my we our they their what when where which who how at as by from about into during would" +
    " will can could should there here then than so if not no yes also more most some any each" +
    " other its user assistant system").split(/\s+/),
);

const DEFAULT_CHUNK_CHARS = 300;

/** Content words, lowercased, stopwords and short tokens dropped. */
function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []).filter(
    (token) => !STOPWORDS.has(token),
  );
}

/** Drop `[timestamp] role: ` so the excerpt reads as speech, not as transcript scaffolding. */
function stripTurnPrefix(line: string): string {
  return line
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/^\s*(user|assistant|system)\s*:\s*/i, "")
    .trim();
}

interface Scored {
  text: string;
  matched: number;
  density: number;
  score: number;
}

function scoreLine(line: string, wanted: Set<string>): Scored {
  const tokens = contentTokens(line);
  let matched = 0;
  for (const token of new Set(tokens)) if (wanted.has(token)) matched += 1;
  const density = tokens.length > 0 ? matched / tokens.length : 0;
  // matched x density (= matched^2 / tokens). Raw match COUNT alone always picks the longest
  // turn: a five-item list the assistant gave shares more words with "user likes the cork board
  // and coasters" than the user's own one-line reply does, but the reply is the provenance.
  return { text: line, matched, density, score: matched * density };
}

/**
 * The best `maxChars` window inside a turn, centred on where the matches actually are.
 *
 * A head-slice loses the detail whenever the fact summarises a long turn: the sealant
 * instruction sits in the middle of a five-item list, so `slice(0, 300)` returns the first item
 * and drops the answer.
 */
function bestWindow(text: string, wanted: Set<string>, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const words = [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    hit: wanted.has(match[0].toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")),
  }));

  let best = { start: 0, score: -1 };
  for (let i = 0; i < words.length; i += 1) {
    const anchor = words[i];
    if (!anchor) continue;
    const from = anchor.start;
    let score = 0;
    for (const word of words) {
      if (word.start >= from && word.end <= from + maxChars && word.hit) score += 1;
    }
    // `>=` so ties resolve to the LATEST qualifying start. Equal-scoring windows all contain
    // the same hits; the latest one hugs them, and an early tie would otherwise be pulled back
    // to the head of the turn by the centring below and lose the tail of the match.
    if (score >= best.score) best = { start: from, score };
  }

  // Centre the window on the matching span rather than starting at it, so a match near the end
  // still carries the sentence that introduced it — but never pull back so far that a hit the
  // chosen window contained falls out of it.
  const hits = words.filter(
    (word) => word.hit && word.start >= best.start && word.end <= best.start + maxChars,
  );
  const lastHitEnd = hits.at(-1)?.end ?? best.start + maxChars;
  const earliest = Math.max(0, lastHitEnd - maxChars);
  const desired = best.start - Math.floor(maxChars / 4);
  const start = Math.max(0, Math.min(text.length - maxChars, Math.max(earliest, desired)));
  return text.slice(start, start + maxChars).trim();
}

export function findSourceChunk(
  statement: string,
  sourceText: string,
  maxChars: number = DEFAULT_CHUNK_CHARS,
): string | undefined {
  if (!statement.trim() || !sourceText.trim()) return undefined;
  const wanted = new Set(contentTokens(statement));
  if (wanted.size === 0) return undefined;

  const lines = sourceText
    .split("\n")
    .map(stripTurnPrefix)
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  let best: Scored | undefined;
  for (const line of lines) {
    const scored = scoreLine(line, wanted);
    if (scored.matched === 0) continue;
    // More matched terms wins; ties go to the denser (shorter, more on-topic) turn.
    if (best === undefined || scored.score > best.score) best = scored;
  }
  // One incidental word in common is coincidence, not provenance.
  if (best === undefined || best.matched < 2) return undefined;

  return bestWindow(best.text, wanted, maxChars);
}
