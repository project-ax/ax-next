// Pure helpers for the rung-6 lifetime soak (TASK-520). Everything here is deterministic
// given its inputs — the harness (`memory-lifetime-soak.mjs`) owns I/O, providers and time.

/** The synthetic-row generator seed the report pins. */
export const SOAK_SEED = 520;

/** mulberry32: a small, fast, seedable PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller; `rand` must never return exactly 1. */
function gaussian(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A uniformly random direction in `dims` dimensions, L2-normalised — what a synthetic row
 * carries in place of an embedding. Gaussian components make the direction uniform on the
 * sphere; uniform components would not.
 */
export function randomUnitVector(rand, dims = 384) {
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const g = gaussian(rand);
    out[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) out[i] /= norm;
  return out;
}

/** Fisher–Yates on a copy. */
export function seededShuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A frequency-weighted unigram vocabulary over real statement values, so synthetic text has
 * the real corpus's term distribution — which is what sets FTS5 posting-list lengths, the
 * one content property the sparse channel's cost depends on.
 */
export function buildVocabulary(texts) {
  const counts = new Map();
  for (const text of texts) {
    for (const word of String(text).split(/\s+/)) {
      if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const words = [...counts.keys()].sort();
  if (words.length === 0) throw new Error('Cannot build a vocabulary from no words');
  const cumulative = new Float64Array(words.length);
  let total = 0;
  words.forEach((word, i) => {
    total += counts.get(word);
    cumulative[i] = total;
  });
  return { words, cumulative, total };
}

export function sampleWord(vocab, rand) {
  const target = rand() * vocab.total;
  let lo = 0;
  let hi = vocab.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vocab.cumulative[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return vocab.words[lo];
}

/**
 * One synthetic statement: `about` and `relation` copied from a randomly chosen real row,
 * and a `value` of vocabulary words filled to that row's total length — so the length
 * distribution is the real one (~240 chars on average), not a constant.
 */
export function syntheticStatement(templates, vocab, rand) {
  const template = templates[Math.floor(rand() * templates.length)];
  // `about` and `relation` are the template's own, so matching its value length matches
  // its total statement length.
  const target = Math.max(1, template.value.length);
  const words = [];
  let length = 0;
  while (length < target) {
    const word = sampleWord(vocab, rand);
    words.push(word);
    length += word.length + (words.length > 1 ? 1 : 0);
  }
  return { about: template.about, relation: template.relation, value: words.join(' ') };
}

/**
 * Gold rows for one probe: the probe's OWN bank's active rows extracted from one of the
 * question's evidence sessions. Absent gold is an empty set, never a guess.
 */
export function goldIds(bankRows, answerSessionIds, activeSentinel) {
  const evidence = new Set(answerSessionIds);
  return new Set(bankRows.filter(r => r.valid_end === activeSentinel && evidence.has(r.conversation_id)).map(r => r.id));
}

/** 1-based rank of the first gold id in a ranked id list, or null when none is present. */
export function rankOfFirstGold(rankedIds, gold) {
  const index = rankedIds.findIndex(id => gold.has(id));
  return index === -1 ? null : index + 1;
}

/** Nearest-rank quantile over finite numbers; q in (0, 1]. */
export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { n: 0, mean: null, p50: null, p95: null, max: null };
  return {
    n: finite.length,
    mean: finite.reduce((a, b) => a + b, 0) / finite.length,
    p50: quantile(finite, 0.5),
    p95: quantile(finite, 0.95),
    max: Math.max(...finite),
  };
}

/** Ordinary least squares y = intercept + slope·x, with r². */
export function linearFit(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) throw new Error('linearFit needs ≥2 paired points');
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) throw new Error('linearFit needs distinct x values');
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

/**
 * Whether growing the store by `addRows` leaves at least `reserveBytes` free, using a
 * measured bytes-per-row with a safety `margin`. A full disk breaks every process on the
 * machine, so the soak stops at the largest checkpoint that fits rather than finding out.
 */
export function diskAllows({ freeBytes, bytesPerRow, addRows, reserveBytes, margin = 1.3 }) {
  if (![freeBytes, bytesPerRow, addRows, reserveBytes].every(Number.isFinite) || bytesPerRow <= 0) {
    throw new Error('diskAllows needs finite inputs and a positive bytes-per-row');
  }
  const projected = addRows * bytesPerRow * margin;
  return { ok: freeBytes - projected >= reserveBytes, projectedBytes: projected };
}

/** Hit@k over ranks (null = absent from the returned list). */
export function hitRate(ranks, k) {
  if (ranks.length === 0) return null;
  return ranks.filter(r => r !== null && r <= k).length / ranks.length;
}
