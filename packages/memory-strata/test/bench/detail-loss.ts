// Where does a specific value get lost — extraction, consolidation, or neither?
// (TASK-361.) Pure scoring; the CLI that produces the layers lives in
// `diag-detail-loss.ts`.
//
// The question this answers: all 9 false refusals in the 2026-09-14 e2e run have
// the same shape — the agent retrieves the right document and narrates that the
// specific value (a count, a year, a proper noun) is not in it. The resume JSONL
// cannot say whether the Observer never extracted the value or the consolidator
// later dropped it, and those are different fixes.

/** Words that carry no evidence, so their survival proves nothing. */
const STOP = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','was','were','is','are',
  'he','she','they','it','his','her','their','you','your','user','that','this','have','has','had',
  'about','from','them','then','there','which','what','when','where','who','how','why',
  'said','says','mentioned','also','been','being','would','could','should','will','shall','into',
  'one','two','answers','acceptable','ranging','approximately','average','improvement','using',
]);

/**
 * Evidence-bearing tokens of a gold answer.
 *
 * Deliberately NOT shared with `diag-truncation.ts`'s lookalike, which drops
 * every token under 4 characters. That is correct there (it asks whether a
 * document body survived a cut) and wrong here: the values this diagnostic
 * tracks ARE the short ones — "38" subjects, "20" percent. Filtering them would
 * leave only the generic noun and score every question as "survived", which is
 * the answer we already know is wrong.
 */
export function contentTokens(value: unknown): string[] {
  const s = Array.isArray(value) ? value.join(' ') : value === null || value === undefined ? '' : String(value);
  const seen = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    if (STOP.has(raw)) continue;
    // Numbers are kept at any length; words must be substantial enough that a
    // chance match is not the reason they appear.
    if (!/^\d+$/.test(raw) && raw.length < 4) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** The three texts a value has to survive, in pipeline order. */
export interface DetailLayers {
  /** Every haystack turn, concatenated — what the pipeline was shown. */
  raw: string;
  /** Every fact the Observer wrote to the inbox, before consolidation ran. */
  extracted: string;
  /** The whole memory tree after ingest — what the agent could retrieve. */
  consolidated: string;
}

export interface DetailLossOptions {
  /**
   * Exact phrases to probe alongside the derived tokens, for gold answers that
   * do not tokenize usefully (a chord progression, a multi-word band name).
   */
  needles?: string[];
}

export type DetailLossVerdict =
  /** The Observer never wrote it down. */
  | 'extraction'
  /** Extracted, then not carried into the tree the agent retrieves from. */
  | 'consolidation'
  /** Memory kept it — so the failure is downstream (retrieval or answer). */
  | 'retained'
  /** No probe appears in the sessions at all, so this question proves nothing. */
  | 'absent-from-corpus';

export interface DetailLossResult {
  probes: string[];
  presentInRaw: string[];
  survivedExtraction: string[];
  survivedConsolidation: string[];
  lostAt: DetailLossVerdict;
  /** For each probe that survived to the tree, the prose line it matched. */
  evidence: Array<{ probe: string; line: string }>;
}

/**
 * Lines that carry no meaning, only identifiers.
 *
 * A short numeric probe matches hex digests and uuids constantly: in the first
 * live run, "38" matched twelve `hash:` / uuid lines before it matched the one
 * sentence that answered the question. Counting those would have scored a
 * question `retained` on a digest collision and pointed the next fix at
 * retrieval instead of memory. Same defect class as the dead-map-line metric
 * that counted a truncated clause as a whole line — a probe must land on prose.
 */
function isMetadataLine(line: string): boolean {
  const t = line.trim();
  if (/^[a-z_]*hash:\s*[0-9a-f]+$/i.test(t)) return true;
  if (/^(id|uuid|rollup_id|source_ids?):/i.test(t)) return true;
  // A bare list item or scalar that is nothing but a uuid / hex digest.
  return /^-?\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/** The prose of a layer: everything an identifier line is not. */
function proseLines(text: string): string[] {
  return text.split('\n').filter((l) => !isMetadataLine(l));
}

/**
 * Classify where a gold value stopped appearing.
 *
 * Survival is checked only for probes that appear in `raw`: a probe the corpus
 * never contained says nothing about the pipeline, and counting it as a loss is
 * how a token-overlap metric invents bugs. When no probe survives that filter
 * the verdict is `absent-from-corpus`, not a blame assignment.
 */
export function classifyDetailLoss(
  goldAnswer: unknown,
  layers: DetailLayers,
  options: DetailLossOptions = {},
): DetailLossResult {
  const probes = [...(options.needles ?? []), ...contentTokens(goldAnswer)];
  const matchIn = (lines: string[], probe: string): string | undefined =>
    lines.find((l) => l.toLowerCase().includes(probe.toLowerCase()));

  const rawLines = proseLines(layers.raw);
  const extractedLines = proseLines(layers.extracted);
  const consolidatedLines = proseLines(layers.consolidated);

  const presentInRaw = probes.filter((p) => matchIn(rawLines, p) !== undefined);
  const survivedExtraction = presentInRaw.filter((p) => matchIn(extractedLines, p) !== undefined);
  const evidence: Array<{ probe: string; line: string }> = [];
  const survivedConsolidation: string[] = [];
  for (const p of survivedExtraction) {
    const line = matchIn(consolidatedLines, p);
    if (line === undefined) continue;
    survivedConsolidation.push(p);
    evidence.push({ probe: p, line: line.trim().slice(0, 400) });
  }

  const lostAt: DetailLossVerdict =
    presentInRaw.length === 0
      ? 'absent-from-corpus'
      : survivedExtraction.length === 0
        ? 'extraction'
        : survivedConsolidation.length === 0
          ? 'consolidation'
          : 'retained';

  return { probes, presentInRaw, survivedExtraction, survivedConsolidation, lostAt, evidence };
}
