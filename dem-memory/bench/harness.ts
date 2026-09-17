import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createVertexEmbedder, hashEmbedder } from "../src/models/embeddings.js";
import { normalizeTimestamp, type EmbeddingFn } from "../src/types.js";

export interface LongMemEvalTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LongMemEvalSample {
  question_id: string;
  question_type?: string;
  question: string;
  question_date?: string;
  answer: string;
  haystack_dates?: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
}

export type Stack = "production" | "vertex" | "stub";

export const CACHE_DIR = join(import.meta.dirname, "cache");

export const CORPUS_PATH =
  process.env.DEM_BENCH_CORPUS_PATH ??
  join(process.env.HOME ?? "~", ".cache/ax-memory-bench/longmemeval-s/longmemeval_s_cleaned.json");

export function loadCorpus(path = CORPUS_PATH): LongMemEvalSample[] {
  return JSON.parse(readFileSync(path, "utf8")) as LongMemEvalSample[];
}

export function totalTurns(sample: LongMemEvalSample): number {
  return sample.haystack_sessions.reduce((sum, session) => sum + session.length, 0);
}

export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      args[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
      if (next !== undefined && !next.startsWith("--")) i += 1;
    }
  }
  return args;
}

/**
 * LongMemEval dates look like "2023/05/27 (Sat) 10:19" — strip the weekday, and read
 * the remainder as UTC so every timestamp in the bench shares one frame of reference.
 */
export function sessionDateToIso(raw: string): string {
  const cleaned = raw.replace(/\s*\(\w+\)\s*/, " ").trim();
  return normalizeTimestamp(cleaned.replace(/\//g, "-").replace(" ", "T") + ":00Z", "session date");
}

function hasVertexCredentials(): boolean {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  return existsSync(join(homedir(), ".config/gcloud/application_default_credentials.json"));
}

/**
 * `GoogleAuth.getProjectId()` cannot infer a project from user ADC credentials, so fall
 * back to whatever project the gcloud CLI is configured with.
 */
function ensureVertexProject(): void {
  if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID) return;
  const gcloudConfig = join(homedir(), ".config/gcloud/configurations/config_default");
  if (!existsSync(gcloudConfig)) return;
  const match = readFileSync(gcloudConfig, "utf8").match(/^\s*project\s*=\s*(\S+)\s*$/m);
  if (match?.[1]) process.env.GOOGLE_CLOUD_PROJECT = match[1];
}

export interface ResolvedStack {
  embed: EmbeddingFn;
  rerank: "cohere" | "lexical";
  label: string;
  flushEmbed: (() => void) | null;
}

export function resolveStack(stack: Stack): ResolvedStack {
  if (stack === "stub") {
    return {
      embed: hashEmbedder(),
      rerank: "lexical",
      label: "stub (hash embedder + lexical reranker)",
      flushEmbed: null,
    };
  }
  if (!hasVertexCredentials()) {
    throw new Error(
      "Vertex AI credentials not found — run `gcloud auth application-default login`, set GOOGLE_APPLICATION_CREDENTIALS, or use --stack stub",
    );
  }
  ensureVertexProject();
  if (stack === "production" && !process.env.COHERE_API_KEY) {
    throw new Error(
      "COHERE_API_KEY is required for --stack production — export it, or use --stack vertex (Vertex embeddings + lexical reranker) or --stack stub",
    );
  }
  const wrapped = embedCacheWrap(createVertexEmbedder());
  return {
    embed: wrapped,
    rerank: stack === "production" ? "cohere" : "lexical",
    label: `${stack} (Vertex text-embedding-005 @ 384d + ${stack === "production" ? "Cohere rerank" : "lexical reranker"})`,
    flushEmbed: wrapped.flush,
  };
}

/**
 * Embedding cache: ONE JSON RECORD PER LINE, appended, never rewritten.
 *
 * It used to be a single JSON object rewritten in full on every flush. At 536,270,828 bytes
 * `JSON.stringify` exceeded V8's max string length (536,870,888) and threw
 * `Invalid string length` — inside run.ts's per-question try block, so 49 questions of an
 * n=100 run scored `error` after their work had already succeeded, and no restart could ever
 * converge because every flush threw again. Appending only what is new keeps each write small
 * however large the cache grows, and drops the per-question cost from "rewrite half a gigabyte"
 * to "write the rows you just added".
 *
 * Reads go through a Buffer and slice per line for the same reason: `readFileSync(path, "utf8")`
 * on a cache this size would hit the same ceiling from the other direction.
 */
export const EMBED_CACHE_FILE = "embeddings.ndjson";
/** Pre-2026-09-16 format. Adopted once, then left alone. */
export const LEGACY_EMBED_CACHE_FILE = "embeddings.json";

const FLUSH_BATCH_LINES = 512;

interface EmbedCacheRecord {
  k: string;
  v: number[];
}

function readNdjsonCache(path: string, into: Map<string, number[]>): void {
  // Buffer, not string: the whole-file string is exactly the ceiling this format exists to duck.
  const buffer = readFileSync(path);
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0x0a, start);
    if (end === -1) end = buffer.length;
    if (end > start) {
      try {
        const record = JSON.parse(buffer.toString("utf8", start, end)) as EmbedCacheRecord;
        if (typeof record.k === "string" && Array.isArray(record.v)) into.set(record.k, record.v);
      } catch {
        /* a line torn by a kill mid-append costs that one vector, not the file */
      }
    }
    start = end + 1;
  }
}

function adoptLegacyCache(path: string, into: Map<string, number[]>): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>;
    for (const [key, vector] of Object.entries(parsed)) {
      if (Array.isArray(vector)) into.set(key, vector);
    }
    return into.size;
  } catch (error) {
    // Best-effort by design: a cache is an optimization, and re-embedding is merely expensive.
    // Taking the run down over one unreadable file is not.
    console.warn(
      `embedding cache: ignoring unreadable ${LEGACY_EMBED_CACHE_FILE} (${error instanceof Error ? error.message : String(error)})`,
    );
    return 0;
  }
}

export function embedCacheWrap(
  inner: EmbeddingFn,
  cacheDir: string = CACHE_DIR,
): EmbeddingFn & { flush(): void } {
  const path = join(cacheDir, EMBED_CACHE_FILE);
  const legacyPath = join(cacheDir, LEGACY_EMBED_CACHE_FILE);
  mkdirSync(cacheDir, { recursive: true });

  const cache = new Map<string, number[]>();
  const pending: string[] = [];
  if (existsSync(path)) {
    readNdjsonCache(path, cache);
  } else if (existsSync(legacyPath)) {
    const adopted = adoptLegacyCache(legacyPath, cache);
    if (adopted > 0) {
      console.log(`embedding cache: adopting ${adopted} entries from ${LEGACY_EMBED_CACHE_FILE}`);
      // Everything adopted is unwritten in the new format, so the first flush lays down the
      // ndjson. The legacy file is left in place rather than deleted — it is the only copy
      // until that flush lands, and deleting an expensive cache is the caller's call.
      for (const [key, vector] of cache) pending.push(JSON.stringify({ k: key, v: vector }));
    }
  }

  const keyOf = (text: string, task?: string): string =>
    createHash("sha1").update(`${task ?? "document"}:${text}`).digest("hex");

  const wrapper = async (texts: string[], task?: "document" | "query"): Promise<number[][]> => {
    const keys = texts.map((text) => keyOf(text, task));
    const missing = new Map<number, string>();
    keys.forEach((key, index) => {
      if (!cache.has(key)) missing.set(index, key);
    });
    if (missing.size > 0) {
      const missingTexts = [...missing.keys()].map((index) => texts[index] ?? "");
      const vectors = await inner(missingTexts, task);
      let offset = 0;
      for (const [, key] of missing) {
        const vector = vectors[offset];
        offset += 1;
        if (vector) {
          cache.set(key, vector);
          pending.push(JSON.stringify({ k: key, v: vector }));
        }
      }
    }
    return keys.map((key) => cache.get(key) ?? []);
  };

  wrapper.flush = (): void => {
    if (pending.length === 0) return;
    for (let i = 0; i < pending.length; i += FLUSH_BATCH_LINES) {
      appendFileSync(path, `${pending.slice(i, i + FLUSH_BATCH_LINES).join("\n")}\n`);
    }
    pending.length = 0;
  };
  return wrapper;
}

/**
 * Deterministic stratified sampling, ported from the in-repo Strata bench
 * (`packages/memory-strata/test/bench/stratify.ts`) so that numbers from the two
 * harnesses are comparable. dem-memory is deliberately outside the pnpm workspace and
 * cannot import it; keep the two implementations in step by hand.
 *
 * Proportional allocation by largest remainder, then EVENLY SPACED picks within each
 * stratum. The spacing is the point: this bench's original picker sorted each type by
 * haystack size and took the k shortest, which put all 30 of an n=30 sample below the
 * corpus median haystack (median 3rd percentile) and made every score an easy-slice score.
 */
function allocate(sizes: number[], limit: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return sizes.map(() => 0);
  if (limit >= total) return [...sizes];

  const exact = sizes.map((size) => (size * limit) / total);
  const out = exact.map(Math.floor);
  let used = out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (used >= limit) break;
    if ((out[index] ?? 0) >= (sizes[index] ?? 0)) continue;
    out[index] = (out[index] ?? 0) + 1;
    used += 1;
  }
  return out;
}

/** Evenly spaced indices across `size`, always including the first. */
function spacedIndices(size: number, take: number): number[] {
  if (take <= 0) return [];
  if (take >= size) return Array.from({ length: size }, (_, i) => i);
  const step = size / take;
  const out: number[] = [];
  for (let k = 0; k < take; k += 1) out.push(Math.min(size - 1, Math.floor(k * step)));
  return [...new Set(out)];
}

/**
 * Interleave per-stratum picks so EVERY prefix is proportional — a run killed at 40% is
 * then a representative sample rather than a census of whichever types came first.
 */
function representativeOrder(groups: readonly (readonly number[])[]): number[] {
  const keyed: Array<{ idx: number; key: number; size: number }> = [];
  for (const picks of groups) {
    for (let j = 0; j < picks.length; j += 1) {
      keyed.push({ idx: picks[j] ?? 0, key: (j + 0.5) / picks.length, size: picks.length });
    }
  }
  keyed.sort((a, b) => a.key - b.key || b.size - a.size || a.idx - b.idx);
  return keyed.map((entry) => entry.idx);
}

export function stratifiedSample(samples: LongMemEvalSample[], limit: number): LongMemEvalSample[] {
  if (limit >= samples.length) return [...samples];
  if (limit <= 0) return [];

  const strata = new Map<string, number[]>();
  samples.forEach((sample, index) => {
    const key = sample.question_type ?? "__unlabelled__";
    const bucket = strata.get(key);
    if (bucket) bucket.push(index);
    else strata.set(key, [index]);
  });

  const keys = [...strata.keys()];
  const counts = allocate(
    keys.map((key) => strata.get(key)?.length ?? 0),
    limit,
  );
  const groups = keys.map((key, i) => {
    const idxs = strata.get(key) ?? [];
    return spacedIndices(idxs.length, counts[i] ?? 0).map((pos) => idxs[pos] ?? 0);
  });
  return representativeOrder(groups).flatMap((i) => {
    const sample = samples[i];
    return sample ? [sample] : [];
  });
}

/**
 * The ORIGINAL picker: proportional by type, then the k shortest haystacks within each.
 * Retained only so the 2026-09-16 runs stay reproducible — it is an easy-slice sampler and
 * its scores are not comparable to a spaced sample or to the Strata bench.
 */
export function pickShortest(
  samples: LongMemEvalSample[],
  n: number,
  minAbs: number,
): LongMemEvalSample[] {

  const byType = new Map<string, LongMemEvalSample[]>();
  for (const sample of samples) {
    const type = sample.question_type ?? "(none)";
    const bucket = byType.get(type) ?? [];
    bucket.push(sample);
    byType.set(type, bucket);
  }
  let selected: LongMemEvalSample[] = [];
  for (const [type, bucket] of byType) {
    const share = Math.max(type === "(none)" ? 0 : 1, Math.round((n * bucket.length) / samples.length));
    const ordered = [...bucket]
      .map((sample) => ({ sample, turns: totalTurns(sample) }))
      .sort((a, b) => a.turns - b.turns || a.sample.question_id.localeCompare(b.sample.question_id));
    selected.push(...ordered.slice(0, Math.min(share, ordered.length)).map((entry) => entry.sample));
  }

  const absCount = selected.filter((sample) => sample.question_id.endsWith("_abs")).length;
  const need = Math.max(0, Math.min(minAbs, n) - absCount);
  if (need > 0) {
    const chosen = new Set(selected.map((sample) => sample.question_id));
    const additions = samples
      .filter((sample) => sample.question_id.endsWith("_abs") && !chosen.has(sample.question_id))
      .map((sample) => ({ sample, turns: totalTurns(sample) }))
      .sort((a, b) => a.turns - b.turns || a.sample.question_id.localeCompare(b.sample.question_id))
      .slice(0, need)
      .map((entry) => entry.sample);
    if (selected.length + additions.length > n) {
      const removeCount = selected.length + additions.length - n;
      const nonAbs = selected
        .filter((sample) => !sample.question_id.endsWith("_abs"))
        .map((sample) => ({ sample, turns: totalTurns(sample) }))
        .sort((a, b) => b.turns - a.turns)
        .slice(0, removeCount)
        .map((entry) => entry.sample.question_id);
      const remove = new Set(nonAbs);
      selected = selected.filter((sample) => !remove.has(sample.question_id));
    }
    selected.push(...additions);
  }
  return selected;
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
