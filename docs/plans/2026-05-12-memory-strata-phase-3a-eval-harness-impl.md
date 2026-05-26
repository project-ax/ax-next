# `@ax/memory-strata` Phase 3A implementation plan (eval harness scaffolding)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the eval harness scaffolding for Strata Phase 3 — three retrieval-config drivers (A: BM25-only, B: BM25 + zerank-2 rerank, C: BM25 + zembed-1 dense + RRF), three corpus loaders (LongMemEval-S, LoCoMo, internal synthetic), a cost meter with a $50 hard cap, a report writer, and a stubbed smoke test. No real-LLM runs land in this PR except a single `BENCH_LIVE=1` smoke (one config, one corpus, one question, hard-fails above $0.50). The binding three-config bench run is Phase 3B.

**Architecture:** Adds `packages/memory-strata/test/bench/` under the existing `@ax/memory-strata` package. Bench is a dev-only on-demand CLI invoked via `pnpm --filter @ax/memory-strata bench`. All new dependencies (`zeroentropy`, `openai`, `@huggingface/hub`, `sqlite-vec`) go in `devDependencies` of `@ax/memory-strata`. Config A reuses the shipped `memory:index:search` hook by instantiating `@ax/memory-strata-index-sqlite` in-process against a temp DB (eslint exception added for `test/bench/**`). Configs B and C wrap A's results with ZeroEntropy SDK calls + RRF math local to the bench. Production indexer packages are NOT extended in Phase 3A — if Phase 3B's decision is "Level 3 in," a follow-up phase wires vectors into production.

**Tech Stack:** TypeScript, pnpm monorepo, Node 22+, vitest. New test-time-only deps: `zeroentropy@0.1.0-alpha.10` (embed + rerank), `openai@^4` (Grok 4.3 via OpenRouter base URL), `@anthropic-ai/sdk@^0.27` (Sonnet 4.6 agent — likely already a dep), `@huggingface/hub@^0.20` (dataset fetcher), `sqlite-vec@^0.1` (vector extension for Config C), `better-sqlite3` (already a dep transitively). Spec: `docs/plans/2026-05-12-memory-strata-phase-3-design.md`.

---

## Source of truth

- **Design spec:** `docs/plans/2026-05-12-memory-strata-phase-3-design.md` — decisions D1–D6, architecture, data flow, error handling. This plan implements the Phase 3A scaffolding portion.
- **Strata master design:** `docs/plans/memory-strata-design.md` § "Evaluation Plan" + § "The vector-vs-no-vector spike" + § "Progressive Enhancement Path".
- **Roadmap:** `docs/plans/2026-05-10-memory-strata-roadmap.md` § "Phase 3" — done-when checklist that Phase 3A unlocks and Phase 3B completes.
- **Phase 2B ship list:** `docs/plans/2026-05-10-memory-strata-phase-2b-retriever-impl.md` invariants I17–I24 — Phase 3A continues this audit trail from I24.
- **Production BM25 hook surface:** `packages/memory-strata-index-contract/src/index.ts` defines the four `memory:index:*` hook payload shapes the bench drives.
- **Production sqlite indexer plugin:** `packages/memory-strata-index-sqlite/src/plugin.ts` — `createMemoryStrataIndexSqlitePlugin({ databasePath })`. Bench instantiates this directly.
- **ESLint cross-plugin import exception list:** `eslint.config.mjs` — Task 3A.0 adds `packages/memory-strata/test/bench/**` with a comment explaining why bench needs to import the indexer plugin (genuine production-path measurement).
- **Memory:** `feedback_yagni_check_in_plans.md`, `feedback_half_wired_window_pattern.md` (not directly applicable since bench is dev-only — PR notes call this out), `feedback_check_plan_vs_reality.md` (the design doc's "trigger gap acknowledgement" section captures the deviation).

## Invariants (audit trail per project pattern)

Continues from Phase 2B's I24.

- **I25 — No production code paths added.** All Phase 3A code lives under `packages/memory-strata/test/bench/` or `packages/memory-strata/test/bench/__tests__/`. `packages/memory-strata/src/` is unchanged. Verified by a ship-list test: greps for new bench module names appearing in `src/` and fails if any do.
- **I26 — All new dependencies are devDependencies.** `zeroentropy`, `openai`, `@huggingface/hub`, `sqlite-vec` are listed only under `devDependencies` of `@ax/memory-strata`. A package.json lint asserts they do not appear in `dependencies`. Runtime capability surface (per CLAUDE.md invariant 5) is unchanged.
- **I27 — Cross-plugin import is bench-only.** The bench imports `@ax/memory-strata-index-sqlite` to drive Config A through the production hook. ESLint exception is scoped to `packages/memory-strata/test/bench/**` with a comment pointing to this plan. No runtime code path imports across plugins.
- **I28 — Cost meter is a hard cap, not a budget.** The `$50` cap is enforced by projection-before-call. Hitting the cap is a runtime fault (bug or unexpected corpus size), not normal operation. A unit test asserts cap-hit aborts the run and writes a partial report.
- **I29 — All three providers' API keys are env-only, never logged.** `ANTHROPIC_API_KEY`, `ZEROENTROPY_API_KEY`, `OPENROUTER_API_KEY` are read once at startup and never echoed. A grep-style ship-list test fails if any of those strings appear in a log/console call site.
- **I30 — Bench `--smoke` runs offline.** No network calls; stubbed LLMs return canned vectors and scores. A CI-runnable smoke completes in <2 minutes. `--bench-live` / `BENCH_LIVE=1` is the only path that hits real APIs; it is NEVER triggered by `pnpm test` or by CI by default.
- **I31 — Internal corpus is deterministic between regens.** Bench reads from the committed `internal-corpus.json` unless `--regen-internal` is passed. Regen requires `ANTHROPIC_API_KEY` and writes a hand-spot-check report alongside the new corpus. A unit test asserts that two runs against the same `internal-corpus.json` produce identical question ordering and identical retrieval-input shapes.
- **I32 — Half-wired window N/A.** Bench is on-demand dev tooling, not user-facing functionality. PR notes contain an explicit "half-wired window: N/A — dev-only on-demand bench" line so reviewers don't grep for the usual CLAUDE.md invariant 3 wording.

---

## Open decisions (resolve in Task 3A.0)

### Decision A: Where does Config A get its FTS5 index instance?

| Option | Pros | Cons |
|---|---|---|
| **A1: Instantiate `@ax/memory-strata-index-sqlite` directly in-process per (corpus, config)** *(recommended)* | Genuine production-path measurement. Same plugin, same SQL, same `MAX_TOP_K` clamp, same tokenization. If the bench is "fair" to Config A, B and C compete on equal footing. | Requires the eslint exception (I27). Bench owns per-test temp-dir lifecycle. |
| A2: Reimplement BM25 + FTS5 locally in the bench | No cross-plugin import. | Two implementations to drift between. Config A's score becomes "bench's BM25" not "production's BM25." |

**Recommendation: A1.** The whole point of the spike is comparing against the real shipped path. A2 makes the comparison less defensible.

### Decision B: Vector store for Config C

| Option | Pros | Cons |
|---|---|---|
| **B1: `sqlite-vec` extension loaded into a fresh better-sqlite3 instance** *(recommended)* | Matches the FTS5 path's storage shape; same DB file holds keyword + vector index; cleanest two-query → RRF fusion. Small mature SQLite extension. | Adds `sqlite-vec` to devDeps. Native extension load requires `better-sqlite3` to be built with `loadExtension` support (default in published prebuilds). |
| B2: In-memory dense index (e.g., `hnswlib-node` or a NumPy-style array brute-force) | No SQLite extension. Pure-JS or simpler native binding. | Different storage shape than FTS5 — fusion logic has to reconcile two stores; doesn't model what a production vector index would look like. |
| B3: External vector DB (Chroma, Qdrant, etc.) | Production-grade. | Wildly over-scoped for a bench; adds infra to spin up. |

**Recommendation: B1.** sqlite-vec is the lowest-friction option that still resembles a real shipping decision.

### Decision C: Live-API smoke gating

| Option | Pros | Cons |
|---|---|---|
| **C1: Env var `BENCH_LIVE=1` plus CLI flag `--live-smoke` required** *(recommended)* | Two-factor: env var AND explicit flag. Impossible to accidentally trigger via `pnpm test`. | Slightly more typing for the one user who needs to run it. |
| C2: CLI flag only | One-factor. Simpler. | A future CI config could pass `--live-smoke` and burn LLM cost without the explicit env var consent. |

**Recommendation: C1.** Defense in depth on a cost-spending code path.

---

## YAGNI audit (per `feedback_yagni_check_in_plans.md`)

Each Phase 3A task is load-bearing for either (a) Phase 3B's binding decision, or (b) the audit trail backing it. Items deliberately deferred:

- **Multi-model judge sweep (e.g., GPT-5, Opus 4.7).** The design doc lists this as a Phase 5+ follow-up if the binding decision is close (≤5-point margin). Not in Phase 3A.
- **Token tokenizer for fallback cost estimation.** When provider SDKs report `usage`, we use it. The fallback "tokenizer estimate" is mentioned in the design doc, but every provider we're calling (Anthropic, OpenRouter via OpenAI-shape, ZeroEntropy) returns usage. We do NOT ship a tokenizer in 3A. If a provider stops returning usage, that's a follow-up.
- **Cache-hit metrics for prompt caching.** Phase 4 territory (KV-cache assembly). Not measured in 3A.
- **Latency-per-doc breakdowns.** We measure per-question latency (p50/p95). Per-doc retrieval latency isn't load-bearing for the binding decision.
- **Bench result diffing across runs.** Each Phase 3B run produces a dated report. We don't ship a "diff this run against last run" tool — the user reads two markdown files.
- **Web UI for the report.** Markdown only.
- **Automatic design-doc + roadmap updates.** Phase 3B's PR author updates these manually based on the binding-decision output. Automating it is over-engineering for a one-time decision.

---

## File structure

```
packages/memory-strata/
├── package.json                                  # MODIFY: devDeps + "bench" script
├── tsconfig.json                                 # MODIFY: include test/bench
├── test/
│   └── bench/
│       ├── types.ts                              # CREATE
│       ├── env.ts                                # CREATE
│       ├── cache.ts                              # CREATE
│       ├── meter.ts                              # CREATE
│       ├── agent.ts                              # CREATE
│       ├── judge.ts                              # CREATE
│       ├── corpora/
│       │   ├── shared.ts                         # CREATE
│       │   ├── longmemeval-s.ts                  # CREATE
│       │   ├── locomo.ts                         # CREATE
│       │   └── internal.ts                       # CREATE
│       ├── configs/
│       │   ├── shared.ts                         # CREATE
│       │   ├── a-bm25.ts                         # CREATE
│       │   ├── b-rerank.ts                       # CREATE
│       │   └── c-rrf.ts                          # CREATE
│       ├── report.ts                             # CREATE
│       ├── cli.ts                                # CREATE
│       ├── internal-corpus.json                  # CREATE
│       └── __tests__/
│           ├── env.test.ts                       # CREATE
│           ├── cache.test.ts                     # CREATE
│           ├── meter.test.ts                     # CREATE
│           ├── corpora.test.ts                   # CREATE
│           ├── agent.test.ts                     # CREATE
│           ├── judge.test.ts                     # CREATE
│           ├── configs.test.ts                   # CREATE
│           ├── report.test.ts                    # CREATE
│           ├── smoke.test.ts                     # CREATE
│           └── ship-list.test.ts                 # CREATE
└── vitest.config.ts                              # MODIFY: include test/bench/__tests__
eslint.config.mjs                                 # MODIFY: add test/bench/** to no-restricted-imports exception
```

---

## Tasks

### Task 3A.0: Setup foundations (deps, scripts, eslint exception)

**Files:**
- Modify: `packages/memory-strata/package.json`
- Modify: `packages/memory-strata/tsconfig.json`
- Modify: `packages/memory-strata/vitest.config.ts`
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Add devDependencies to `packages/memory-strata/package.json`**

In the `devDependencies` block, add:

```json
"zeroentropy": "0.1.0-alpha.10",
"openai": "^4.68.0",
"@huggingface/hub": "^0.20.0",
"sqlite-vec": "^0.1.6",
"@ax/memory-strata-index-sqlite": "workspace:*"
```

Note: `@ax/memory-strata-index-sqlite` is a workspace dep at devDep level. Bench imports it; production code in `src/` does not.

- [ ] **Step 2: Add the bench script to `packages/memory-strata/package.json`**

In the `scripts` block, add:

```json
"bench": "tsx test/bench/cli.ts"
```

- [ ] **Step 3: Ensure `tsx` is available**

Check `package.json` of the repo root for `tsx` in devDependencies. If absent, add it. If already there, skip.

- [ ] **Step 4: Extend tsconfig to include `test/bench`**

In `packages/memory-strata/tsconfig.json` `"include"`, ensure `test/bench/**/*.ts` is covered. If `include` already contains `src/**/*.ts` and `test/**/*.ts`, no change needed.

- [ ] **Step 5: Extend vitest config to include bench tests**

In `packages/memory-strata/vitest.config.ts`, ensure the `test.include` glob covers `test/bench/__tests__/**/*.test.ts`. Adjust as needed.

- [ ] **Step 6: Add eslint exception for `test/bench/**`**

In `eslint.config.mjs`, locate the override block whose `files` array lists `packages/test-harness/src/**` and `packages/workspace-git/src/**`. Add `packages/memory-strata/test/bench/**` to that `files` array, with the following comment immediately above the new entry:

```js
// The Strata Phase 3 eval harness lives under test/bench/ and must
// instantiate @ax/memory-strata-index-sqlite directly to drive Config A
// (BM25 baseline) through the genuine production hook surface. Re-implementing
// FTS5 locally would defeat the spike's whole point. Not subject to I2.
// See docs/plans/2026-05-12-memory-strata-phase-3-design.md § D1.
'packages/memory-strata/test/bench/**',
```

- [ ] **Step 7: Run install + lint to verify setup**

```bash
pnpm install
pnpm --filter @ax/memory-strata lint
```
Expected: install succeeds, lint passes.

- [ ] **Step 8: Commit**

```bash
git add packages/memory-strata/package.json packages/memory-strata/tsconfig.json packages/memory-strata/vitest.config.ts eslint.config.mjs pnpm-lock.yaml
git commit -m "chore(memory-strata): scaffold Phase 3A bench deps + eslint exception"
```

---

### Task 3A.1: Shared bench types

**Files:**
- Create: `packages/memory-strata/test/bench/types.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
// Shared types for the Strata Phase 3 eval harness.
// See docs/plans/2026-05-12-memory-strata-phase-3-design.md.

export interface MarkdownDoc {
  path: string;          // e.g. "docs/entities/people/john-doe.md"
  category: string;      // "entities" | "knowledge" | "episodes" | "procedures" | "system"
  slug: string;          // e.g. "john-doe"
  summary: string;       // YAML-frontmatter summary
  factType: string;      // YAML-frontmatter fact_type
  headers: string;       // section headers joined newline
  body: string;          // full markdown body (used for indexing)
}

export interface BenchQuestion {
  id: string;
  text: string;
  goldAnswer: string;
  goldDocIds?: string[];  // optional: dataset-provided list of relevant doc paths for recall@k
  metadata?: Record<string, unknown>;
}

export interface BenchCorpus {
  name: 'longmemeval-s' | 'locomo' | 'internal';
  memoryTree: Map<string, MarkdownDoc>;   // key = doc.path
  questions: BenchQuestion[];
}

export type ConfigName = 'a-bm25' | 'b-rerank' | 'c-rrf';

export interface RetrievedDoc {
  path: string;
  score: number;
  summary: string;
}

export interface RetrievalResult {
  retrievedDocs: RetrievedDoc[];
  latencyMs: number;
  embeddingTokens: number;
  rerankTokens: number;
}

export interface ConfigDriver {
  name: ConfigName;
  build(corpus: BenchCorpus): Promise<void>;
  teardown(): Promise<void>;
  retrieve(question: BenchQuestion, topK: number, signal: AbortSignal): Promise<RetrievalResult>;
}

export type Verdict = 'correct' | 'incorrect' | 'uncertain';

export interface QuestionResult {
  corpus: BenchCorpus['name'];
  config: ConfigName;
  question: BenchQuestion;
  retrieval: RetrievalResult;
  agentAnswer: string;
  verdict: Verdict;
  judgeReason: string;
  agentTokens: { in: number; out: number };
  judgeTokens: { in: number; out: number };
  totalDollars: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/memory-strata/test/bench/types.ts
git commit -m "feat(memory-strata): bench shared types (Phase 3A)"
```

---

### Task 3A.2: Env check helper

**Files:**
- Create: `packages/memory-strata/test/bench/env.ts`
- Create: `packages/memory-strata/test/bench/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing test `env.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { requireKeys } from '../env.js';

describe('requireKeys', () => {
  it('throws listing every missing key', () => {
    expect(() =>
      requireKeys({ A: undefined, B: 'set', C: undefined }),
    ).toThrow(/missing.*A.*C/i);
  });

  it('returns the value object when all keys present', () => {
    expect(requireKeys({ A: 'a', B: 'b' })).toEqual({ A: 'a', B: 'b' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ax/memory-strata test -- test/bench/__tests__/env.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `env.ts`**

```ts
export function requireKeys<T extends Record<string, string | undefined>>(env: T): {
  [K in keyof T]: string;
} {
  const missing: string[] = [];
  for (const [key, val] of Object.entries(env)) {
    if (!val) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Bench environment is missing required keys: ${missing.join(', ')}. ` +
        `Set them in your shell or .env file before running pnpm bench.`,
    );
  }
  return env as { [K in keyof T]: string };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ax/memory-strata test -- test/bench/__tests__/env.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/env.ts packages/memory-strata/test/bench/__tests__/env.test.ts
git commit -m "feat(memory-strata): bench env-check helper (Phase 3A)"
```

---

### Task 3A.3: Cost meter with $50 hard cap

**Files:**
- Create: `packages/memory-strata/test/bench/meter.ts`
- Create: `packages/memory-strata/test/bench/__tests__/meter.test.ts`

- [ ] **Step 1: Write the failing test `meter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { CostMeter, type Pricing } from '../meter.js';

const pricing: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};

describe('CostMeter', () => {
  it('accumulates spend by model', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    m.record('claude-sonnet-4-6', { in: 1_000_000, out: 1_000_000 });
    expect(m.totalDollars()).toBeCloseTo(18, 5);
  });

  it('projectWouldExceedCap returns true above cap', () => {
    const m = new CostMeter({ capDollars: 1, pricing });
    m.record('claude-sonnet-4-6', { in: 100_000, out: 100_000 });
    expect(m.projectWouldExceedCap('claude-sonnet-4-6', { in: 1_000_000, out: 1_000_000 })).toBe(true);
  });

  it('projectWouldExceedCap returns false below cap', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    expect(m.projectWouldExceedCap('claude-sonnet-4-6', { in: 1_000, out: 1_000 })).toBe(false);
  });

  it('snapshot returns per-model totals', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    m.record('claude-sonnet-4-6', { in: 1_000_000, out: 0 });
    m.record('x-ai/grok-4.3', { in: 1_000_000, out: 0 });
    const snap = m.snapshot();
    expect(snap['claude-sonnet-4-6'].dollars).toBeCloseTo(3, 5);
    expect(snap['x-ai/grok-4.3'].dollars).toBeCloseTo(1.25, 5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ax/memory-strata test -- test/bench/__tests__/meter.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `meter.ts`**

```ts
export interface PriceEntry { in: number; out: number; } // dollars per token
export type Pricing = Record<string, PriceEntry>;

export interface ModelUsage { in: number; out: number; }   // tokens

export interface MeterOptions {
  capDollars: number;
  pricing: Pricing;
}

export interface ModelSnapshot { tokensIn: number; tokensOut: number; dollars: number; }

export class CostMeter {
  private totals = new Map<string, ModelSnapshot>();

  constructor(private readonly opts: MeterOptions) {}

  record(model: string, usage: ModelUsage): void {
    const price = this.opts.pricing[model];
    if (!price) throw new Error(`No pricing entry for model: ${model}`);
    const current = this.totals.get(model) ?? { tokensIn: 0, tokensOut: 0, dollars: 0 };
    current.tokensIn += usage.in;
    current.tokensOut += usage.out;
    current.dollars += usage.in * price.in + usage.out * price.out;
    this.totals.set(model, current);
  }

  totalDollars(): number {
    let sum = 0;
    for (const m of this.totals.values()) sum += m.dollars;
    return sum;
  }

  projectWouldExceedCap(model: string, projected: ModelUsage): boolean {
    const price = this.opts.pricing[model];
    if (!price) throw new Error(`No pricing entry for model: ${model}`);
    const projectedDollars = projected.in * price.in + projected.out * price.out;
    return this.totalDollars() + projectedDollars > this.opts.capDollars;
  }

  snapshot(): Record<string, ModelSnapshot> {
    return Object.fromEntries(this.totals);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/meter.ts packages/memory-strata/test/bench/__tests__/meter.test.ts
git commit -m "feat(memory-strata): bench cost meter with hard cap (Phase 3A)"
```

---

### Task 3A.4: Dataset cache helper

**Files:**
- Create: `packages/memory-strata/test/bench/cache.ts`
- Create: `packages/memory-strata/test/bench/__tests__/cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchCache } from '../cache.js';

describe('BenchCache', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bench-cache-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns cached payload on hit', async () => {
    const cache = new BenchCache(dir);
    const path = await cache.getPath('demo', '1.jsonl');
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(path, 'hello');
    const buf = await cache.readIfHit('demo', '1.jsonl');
    expect(buf?.toString()).toBe('hello');
  });

  it('returns null on cache miss', async () => {
    const cache = new BenchCache(dir);
    expect(await cache.readIfHit('demo', 'missing.jsonl')).toBeNull();
  });

  it('writes payload to expected path', async () => {
    const cache = new BenchCache(dir);
    await cache.write('demo', '1.jsonl', Buffer.from('content'));
    const path = await cache.getPath('demo', '1.jsonl');
    expect(readFileSync(path).toString()).toBe('content');
  });

  it('purge deletes the dataset subdir', async () => {
    const cache = new BenchCache(dir);
    await cache.write('demo', '1.jsonl', Buffer.from('x'));
    await cache.purge('demo');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `cache.ts`**

```ts
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_ROOT = join(homedir(), '.cache', 'ax-memory-bench');

export class BenchCache {
  constructor(private readonly root: string = DEFAULT_ROOT) {
    mkdirSync(root, { recursive: true });
  }

  async getPath(dataset: string, file: string): Promise<string> {
    return join(this.root, dataset, file);
  }

  async readIfHit(dataset: string, file: string): Promise<Buffer | null> {
    const path = await this.getPath(dataset, file);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  async write(dataset: string, file: string, payload: Buffer): Promise<void> {
    const path = await this.getPath(dataset, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload);
  }

  async purge(dataset: string): Promise<void> {
    rmSync(join(this.root, dataset), { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/cache.ts packages/memory-strata/test/bench/__tests__/cache.test.ts
git commit -m "feat(memory-strata): bench cache helper (Phase 3A)"
```

---

### Task 3A.5: Corpus shared utilities + LongMemEval-S loader

**Files:**
- Create: `packages/memory-strata/test/bench/corpora/shared.ts`
- Create: `packages/memory-strata/test/bench/corpora/longmemeval-s.ts`
- Create: `packages/memory-strata/test/bench/__tests__/corpora.test.ts`

- [ ] **Step 1: Write the failing test (LongMemEval-S round-trip)**

```ts
import { describe, it, expect } from 'vitest';
import { transformLongMemEvalSample } from '../corpora/longmemeval-s.js';

describe('LongMemEval-S transform', () => {
  it('emits a Strata-shaped memory tree from a sample row', () => {
    const sample = {
      question_id: 'q1',
      question: 'What did the user say about coffee?',
      answer: 'They like cortados.',
      haystack_sessions: [
        {
          session_id: 's0',
          turns: [
            { role: 'user', content: 'I love cortados.' },
            { role: 'assistant', content: 'Noted.' },
          ],
        },
      ],
      relevant_session_ids: ['s0'],
    };
    const out = transformLongMemEvalSample(sample);
    expect(out.question).toMatchObject({
      id: 'q1',
      text: expect.stringContaining('coffee'),
      goldAnswer: 'They like cortados.',
      goldDocIds: ['episodes/s0'],
    });
    const doc = out.docs.get('episodes/s0');
    expect(doc).toBeDefined();
    expect(doc!.body).toMatch(/cortado/);
    expect(doc!.category).toBe('episodes');
    expect(doc!.slug).toBe('s0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `corpora/shared.ts`**

```ts
import type { MarkdownDoc, BenchCorpus, BenchQuestion } from '../types.js';

export function makeDoc(input: {
  category: MarkdownDoc['category'];
  slug: string;
  summary: string;
  body: string;
  factType?: string;
}): MarkdownDoc {
  const path = `${input.category}/${input.slug}`;
  return {
    path,
    category: input.category,
    slug: input.slug,
    summary: input.summary,
    factType: input.factType ?? 'episode',
    headers: extractHeaders(input.body),
    body: input.body,
  };
}

function extractHeaders(body: string): string {
  const lines = body.split('\n').filter((l) => /^#{1,6}\s+/.test(l));
  return lines.join('\n');
}

export function emptyCorpus(name: BenchCorpus['name']): BenchCorpus {
  return { name, memoryTree: new Map(), questions: [] };
}
```

- [ ] **Step 4: Implement `corpora/longmemeval-s.ts`**

```ts
import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LongMemEvalSample {
  question_id: string;
  question: string;
  answer: string;
  haystack_sessions: Array<{
    session_id: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  }>;
  relevant_session_ids?: string[];
}

export function transformLongMemEvalSample(s: LongMemEvalSample): {
  docs: Map<string, MarkdownDoc>;
  question: BenchQuestion;
} {
  const docs = new Map<string, MarkdownDoc>();
  for (const session of s.haystack_sessions) {
    const body = session.turns
      .map((t) => `## ${t.role}\n${t.content}`)
      .join('\n\n');
    const summary = firstSentence(session.turns.map((t) => t.content).join(' '));
    const doc = makeDoc({
      category: 'episodes',
      slug: session.session_id,
      summary,
      body,
    });
    docs.set(doc.path, doc);
  }
  return {
    docs,
    question: {
      id: s.question_id,
      text: s.question,
      goldAnswer: s.answer,
      goldDocIds: (s.relevant_session_ids ?? []).map((id) => `episodes/${id}`),
    },
  };
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?]{10,200}[.!?]/);
  return (m ? m[0] : s).slice(0, 200);
}

const DATASET_NAME = 'longmemeval-s';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_s.json';

export async function loadLongMemEvalS(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, 'longmemeval_s.json');
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(HF_DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LongMemEval-S from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/longmemeval_s.json.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, 'longmemeval_s.json', raw);
  }
  const samples = JSON.parse(raw.toString()) as LongMemEvalSample[];
  const corpus: BenchCorpus = { name: 'longmemeval-s', memoryTree: new Map(), questions: [] };
  for (const sample of samples) {
    const { docs, question } = transformLongMemEvalSample(sample);
    for (const [path, doc] of docs) corpus.memoryTree.set(path, doc);
    corpus.questions.push(question);
  }
  return corpus;
}
```

Note on dataset path: if the HuggingFace dataset's resolve URL changes, the implementation engineer updates the URL based on the HF dataset's current "Files" tab.

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/test/bench/corpora/shared.ts packages/memory-strata/test/bench/corpora/longmemeval-s.ts packages/memory-strata/test/bench/__tests__/corpora.test.ts
git commit -m "feat(memory-strata): bench LongMemEval-S loader (Phase 3A)"
```

---

### Task 3A.6: LoCoMo loader

**Files:**
- Create: `packages/memory-strata/test/bench/corpora/locomo.ts`
- Modify: `packages/memory-strata/test/bench/__tests__/corpora.test.ts`

- [ ] **Step 1: Add a failing test for LoCoMo transform**

Append to `corpora.test.ts`:

```ts
import { transformLoCoMoSample } from '../corpora/locomo.js';

describe('LoCoMo transform', () => {
  it('emits a Strata-shaped memory tree from a sample row', () => {
    const sample = {
      sample_id: 'lc-1',
      conversation: [
        { speaker: 'Alice', text: 'My birthday is March 5.' },
        { speaker: 'Bob', text: 'Got it.' },
      ],
      qa: [{ question: "What is Alice's birthday?", answer: 'March 5' }],
    };
    const out = transformLoCoMoSample(sample);
    expect(out.docs.size).toBeGreaterThan(0);
    expect(out.questions[0].text).toContain('birthday');
    expect(out.questions[0].goldAnswer).toBe('March 5');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `corpora/locomo.ts`**

```ts
import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LoCoMoSample {
  sample_id: string;
  conversation: Array<{ speaker: string; text: string }>;
  qa: Array<{ question: string; answer: string }>;
}

export function transformLoCoMoSample(s: LoCoMoSample): {
  docs: Map<string, MarkdownDoc>;
  questions: BenchQuestion[];
} {
  const slug = s.sample_id;
  const body = s.conversation.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
  const summary = (s.conversation[0]?.text ?? '').slice(0, 200);
  const doc = makeDoc({ category: 'episodes', slug, summary, body });
  const docs = new Map([[doc.path, doc]]);
  const questions: BenchQuestion[] = s.qa.map((q, i) => ({
    id: `${s.sample_id}-q${i}`,
    text: q.question,
    goldAnswer: q.answer,
    goldDocIds: [doc.path],
  }));
  return { docs, questions };
}

const DATASET_NAME = 'locomo';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/snap-research/LoCoMo/resolve/main/data.json';

export async function loadLoCoMo(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, 'data.json');
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(HF_DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LoCoMo from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/data.json.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, 'data.json', raw);
  }
  const samples = JSON.parse(raw.toString()) as LoCoMoSample[];
  const corpus: BenchCorpus = { name: 'locomo', memoryTree: new Map(), questions: [] };
  for (const sample of samples) {
    const { docs, questions } = transformLoCoMoSample(sample);
    for (const [path, doc] of docs) corpus.memoryTree.set(path, doc);
    corpus.questions.push(...questions);
  }
  return corpus;
}
```

Note: the transform shape (one doc per sample, multiple questions per doc) is the load-bearing contract; if the upstream JSON schema differs, the implementing engineer updates `transformLoCoMoSample` and the test fixture together.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/corpora/locomo.ts packages/memory-strata/test/bench/__tests__/corpora.test.ts
git commit -m "feat(memory-strata): bench LoCoMo loader (Phase 3A)"
```

---

### Task 3A.7: Internal corpus reader

**Files:**
- Create: `packages/memory-strata/test/bench/corpora/internal.ts`
- Create: `packages/memory-strata/test/bench/internal-corpus.json`
- Modify: `packages/memory-strata/test/bench/__tests__/corpora.test.ts`

The *read* path lands now; the *regenerate* path lands in Task 3A.16 (requires the agent wrapper from Task 3A.8).

- [ ] **Step 1: Add a failing test**

Append to `corpora.test.ts`:

```ts
import { loadInternalCorpusFromJson } from '../corpora/internal.js';

describe('internal corpus loader', () => {
  it('reads the committed internal-corpus.json into a BenchCorpus', () => {
    const json = JSON.stringify({
      docs: [
        {
          path: 'knowledge/architecture/plugin-bus',
          category: 'knowledge',
          slug: 'plugin-bus',
          summary: 'How the hook bus works',
          factType: 'knowledge',
          headers: '## Overview',
          body: '# Plugin bus\n## Overview\nplugins talk through the bus.',
        },
      ],
      questions: [
        {
          id: 'q1',
          text: 'How do plugins communicate?',
          goldAnswer: 'Through the hook bus.',
          goldDocIds: ['knowledge/architecture/plugin-bus'],
        },
      ],
    });
    const corpus = loadInternalCorpusFromJson(json);
    expect(corpus.name).toBe('internal');
    expect(corpus.memoryTree.size).toBe(1);
    expect(corpus.questions[0].id).toBe('q1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement the *read* portion of `corpora/internal.ts`**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchCorpus, MarkdownDoc, BenchQuestion } from '../types.js';

export interface InternalCorpusFile {
  docs: MarkdownDoc[];
  questions: BenchQuestion[];
}

export function loadInternalCorpusFromJson(json: string): BenchCorpus {
  const parsed = JSON.parse(json) as InternalCorpusFile;
  const memoryTree = new Map<string, MarkdownDoc>(parsed.docs.map((d) => [d.path, d]));
  return { name: 'internal', memoryTree, questions: parsed.questions };
}

export const INTERNAL_CORPUS_PATH = join(
  new URL('./', import.meta.url).pathname,
  '../internal-corpus.json',
);

export function loadInternalCorpus(): BenchCorpus {
  if (!existsSync(INTERNAL_CORPUS_PATH)) {
    throw new Error(
      `Internal corpus not found at ${INTERNAL_CORPUS_PATH}. ` +
        `Run "pnpm --filter @ax/memory-strata bench --regen-internal" to generate it.`,
    );
  }
  return loadInternalCorpusFromJson(readFileSync(INTERNAL_CORPUS_PATH, 'utf8'));
}
```

- [ ] **Step 4: Create an initial stub `internal-corpus.json`**

```json
{
  "docs": [],
  "questions": []
}
```

This stub is replaced by Task 3A.16's real regeneration.

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/test/bench/corpora/internal.ts packages/memory-strata/test/bench/internal-corpus.json packages/memory-strata/test/bench/__tests__/corpora.test.ts
git commit -m "feat(memory-strata): bench internal corpus reader (Phase 3A)"
```

---

### Task 3A.8: Agent wrapper (Sonnet 4.6)

**Files:**
- Create: `packages/memory-strata/test/bench/agent.ts`
- Create: `packages/memory-strata/test/bench/__tests__/agent.test.ts`

- [ ] **Step 1: Write the failing test (uses an injected SDK stub)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { runAgent, type AgentClient } from '../agent.js';

describe('runAgent', () => {
  it('composes a system prompt with retrieved summaries and returns the model answer', async () => {
    const stub: AgentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'The answer is 42.', usage: { in: 100, out: 5 } }),
    };
    const result = await runAgent(
      stub,
      { id: 'q1', text: 'What is the answer?', goldAnswer: '42' },
      [{ path: 'k/a', score: 1, summary: 'The number 42 is special.' }],
    );
    expect(result.text).toBe('The answer is 42.');
    expect(stub.complete).toHaveBeenCalledOnce();
    const [args] = vi.mocked(stub.complete).mock.calls[0];
    expect(args.system).toContain('The number 42 is special');
    expect(args.user).toContain('What is the answer?');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `agent.ts`**

```ts
import type { BenchQuestion, RetrievedDoc } from './types.js';
import Anthropic from '@anthropic-ai/sdk';

export interface AgentClient {
  complete(args: { system: string; user: string }): Promise<{ text: string; usage: { in: number; out: number } }>;
}

export interface AgentResponse {
  text: string;
  usage: { in: number; out: number };
}

const SYSTEM_PROMPT_PREAMBLE = `You are an assistant answering a question using ONLY the provided memory snippets.
If the snippets do not contain the answer, say "I don't know."
Be concise.`;

export async function runAgent(
  client: AgentClient,
  question: BenchQuestion,
  retrieved: RetrievedDoc[],
): Promise<AgentResponse> {
  const memoryBlock = retrieved
    .map((d, i) => `[${i + 1}] (${d.path}) ${d.summary}`)
    .join('\n');
  const system = `${SYSTEM_PROMPT_PREAMBLE}\n\n## Memory snippets\n${memoryBlock}`;
  const user = question.text;
  return client.complete({ system, user });
}

export function makeAnthropicAgentClient(apiKey: string, model = 'claude-sonnet-4-6'): AgentClient {
  const a = new Anthropic({ apiKey });
  return {
    async complete({ system, user }) {
      const resp = await a.messages.create({
        model,
        max_tokens: 512,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = resp.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens } };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/agent.ts packages/memory-strata/test/bench/__tests__/agent.test.ts
git commit -m "feat(memory-strata): bench agent wrapper (Phase 3A)"
```

---

### Task 3A.9: Judge wrapper (Grok 4.3 via OpenRouter)

**Files:**
- Create: `packages/memory-strata/test/bench/judge.ts`
- Create: `packages/memory-strata/test/bench/__tests__/judge.test.ts`

- [ ] **Step 1: Write the failing test (stubbed JudgeClient)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { judgeAnswer, type JudgeClient } from '../judge.js';

describe('judgeAnswer', () => {
  it('parses correct/incorrect/uncertain verdicts from the model response', async () => {
    const stub: JudgeClient = {
      complete: vi.fn()
        .mockResolvedValueOnce({ text: 'VERDICT: correct\nREASON: matches gold.', usage: { in: 50, out: 10 } })
        .mockResolvedValueOnce({ text: 'VERDICT: incorrect\nREASON: wrong number.', usage: { in: 50, out: 10 } })
        .mockResolvedValueOnce({ text: 'VERDICT: uncertain\nREASON: ambiguous.', usage: { in: 50, out: 10 } }),
    };
    const a = await judgeAnswer(stub, 'q?', 'gold', 'gold');
    const b = await judgeAnswer(stub, 'q?', 'gold', 'wrong');
    const c = await judgeAnswer(stub, 'q?', 'gold', 'maybe');
    expect(a.verdict).toBe('correct');
    expect(b.verdict).toBe('incorrect');
    expect(c.verdict).toBe('uncertain');
  });

  it('defaults to uncertain when the verdict line is malformed', async () => {
    const stub: JudgeClient = {
      complete: vi.fn().mockResolvedValue({ text: 'gibberish', usage: { in: 50, out: 5 } }),
    };
    const r = await judgeAnswer(stub, 'q?', 'gold', 'answer');
    expect(r.verdict).toBe('uncertain');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `judge.ts`**

```ts
import type { Verdict } from './types.js';
import OpenAI from 'openai';

export interface JudgeClient {
  complete(args: { system: string; user: string }): Promise<{ text: string; usage: { in: number; out: number } }>;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  usage: { in: number; out: number };
}

const SYSTEM = `You are an evaluation judge. Score whether an answer matches the gold answer.

Respond in EXACTLY this format on two lines:
VERDICT: <correct|incorrect|uncertain>
REASON: <one short sentence>

Use "correct" only if the answer's meaning matches the gold answer. Use "incorrect" if the answer contradicts gold. Use "uncertain" if you cannot tell from the gold whether the answer is right (e.g., partial answers, ambiguous gold).`;

export async function judgeAnswer(
  client: JudgeClient,
  question: string,
  goldAnswer: string,
  agentAnswer: string,
): Promise<JudgeResult> {
  const user = `Question: ${question}\nGold answer: ${goldAnswer}\nAgent answer: ${agentAnswer}`;
  const resp = await client.complete({ system: SYSTEM, user });
  const verdictMatch = resp.text.match(/VERDICT:\s*(correct|incorrect|uncertain)/i);
  const reasonMatch = resp.text.match(/REASON:\s*(.+)/i);
  const verdict: Verdict = verdictMatch ? (verdictMatch[1].toLowerCase() as Verdict) : 'uncertain';
  const reason = reasonMatch ? reasonMatch[1].trim() : resp.text.trim();
  return { verdict, reason, usage: resp.usage };
}

export function makeOpenRouterJudgeClient(apiKey: string, model = 'x-ai/grok-4.3'): JudgeClient {
  const o = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
  return {
    async complete({ system, user }) {
      const resp = await o.chat.completions.create({
        model,
        max_tokens: 120,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = resp.choices[0]?.message?.content ?? '';
      const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
      return { text, usage: { in: usage.prompt_tokens, out: usage.completion_tokens } };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/judge.ts packages/memory-strata/test/bench/__tests__/judge.test.ts
git commit -m "feat(memory-strata): bench judge wrapper (Grok 4.3, Phase 3A)"
```

---

### Task 3A.10: Config A driver (BM25 baseline via production hook)

**Files:**
- Create: `packages/memory-strata/test/bench/configs/shared.ts`
- Create: `packages/memory-strata/test/bench/configs/a-bm25.ts`
- Create: `packages/memory-strata/test/bench/__tests__/configs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
import type { BenchCorpus } from '../types.js';
import { makeDoc } from '../corpora/shared.js';

describe('Config A (BM25)', () => {
  let dir: string;
  let corpus: BenchCorpus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-cfg-a-'));
    corpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const docA = makeDoc({ category: 'knowledge', slug: 'cortado', summary: 'about cortados', body: 'A cortado is espresso with milk.' });
    const docB = makeDoc({ category: 'knowledge', slug: 'latte', summary: 'about lattes', body: 'A latte is mostly milk.' });
    corpus.memoryTree.set(docA.path, docA);
    corpus.memoryTree.set(docB.path, docB);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('retrieves cortado-relevant doc for a cortado query', async () => {
    const driver = createConfigA({ tempDir: dir });
    await driver.build(corpus);
    const result = await driver.retrieve(
      { id: 'q', text: 'What is a cortado?', goldAnswer: 'espresso + milk' },
      5,
      new AbortController().signal,
    );
    expect(result.retrievedDocs[0].path).toBe('knowledge/cortado');
    await driver.teardown();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `configs/shared.ts`**

```ts
import type { ConfigDriver } from '../types.js';

export interface ConfigFactoryOptions {
  tempDir: string;
}
export type { ConfigDriver };
```

- [ ] **Step 4: Implement `configs/a-bm25.ts`**

```ts
import { HookBus, makeAgentContext } from '@ax/core';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { join } from 'node:path';
import type { BenchCorpus, BenchQuestion, ConfigDriver, RetrievalResult, RetrievedDoc } from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export function createConfigA(opts: ConfigFactoryOptions): ConfigDriver {
  let bus: HookBus | null = null;
  let teardownFn: (() => Promise<void>) | null = null;
  const ctx = makeAgentContext({ sessionId: 'bench', agentId: 'bench', userId: 'bench' });

  return {
    name: 'a-bm25',
    async build(corpus: BenchCorpus) {
      const dbPath = join(opts.tempDir, `${corpus.name}.db`);
      bus = new HookBus();
      const plugin = createMemoryStrataIndexSqlitePlugin({ databasePath: dbPath });
      await plugin.init({ bus, config: {} });
      teardownFn = async () => {
        if (plugin.shutdown) await plugin.shutdown({ bus: bus!, config: {} });
      };
      for (const doc of corpus.memoryTree.values()) {
        await bus.call('memory:index:upsert', ctx, {
          docId: doc.path,
          category: doc.category,
          slug: doc.slug,
          summary: doc.summary,
          factType: doc.factType,
          body: doc.body,
          headers: doc.headers,
        });
      }
    },
    async teardown() {
      if (teardownFn) await teardownFn();
      bus = null;
      teardownFn = null;
    },
    async retrieve(question: BenchQuestion, topK: number, _signal: AbortSignal): Promise<RetrievalResult> {
      if (!bus) throw new Error('Config A: build() not called');
      const t0 = Date.now();
      const out = await bus.call('memory:index:search', ctx, {
        query: question.text,
        topK,
      });
      const retrievedDocs: RetrievedDoc[] = (out.results ?? []).map((r: any) => ({
        path: r.docId,
        score: r.score,
        summary: r.summary,
      }));
      return {
        retrievedDocs,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
      };
    },
  };
}
```

Note: the import shape for `HookBus` and `makeAgentContext` follows the existing contract test at `packages/memory-strata-index-contract/src/index.ts`. If the production plugin's shutdown method has a different name, the implementing engineer matches it.

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/test/bench/configs/shared.ts packages/memory-strata/test/bench/configs/a-bm25.ts packages/memory-strata/test/bench/__tests__/configs.test.ts
git commit -m "feat(memory-strata): bench Config A (BM25 baseline) (Phase 3A)"
```

---

### Task 3A.11: Config B driver (BM25 + zerank-2 rerank)

**Files:**
- Create: `packages/memory-strata/test/bench/configs/b-rerank.ts`
- Modify: `packages/memory-strata/test/bench/__tests__/configs.test.ts`

- [ ] **Step 1: Add a failing test using a stubbed rerank client**

Append to `configs.test.ts`:

```ts
import { createConfigB } from '../configs/b-rerank.js';

describe('Config B (BM25 + rerank)', () => {
  it('reorders Config A results via stubbed reranker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-b-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'knowledge', slug: 'd1', summary: 'first', body: 'cortado milk espresso' });
    const d2 = makeDoc({ category: 'knowledge', slug: 'd2', summary: 'second', body: 'cortado is great' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigB({
      tempDir: dir,
      rerankClient: {
        async rerank(_query, docs) {
          return { reranked: [...docs].reverse().map((d, i) => ({ docId: d.docId, score: 1 - i * 0.1 })), tokens: 50 };
        },
      },
    });
    await driver.build(corpus);
    const r = await driver.retrieve(
      { id: 'q', text: 'cortado', goldAnswer: 'x' },
      2,
      new AbortController().signal,
    );
    expect(r.retrievedDocs.length).toBe(2);
    expect(r.rerankTokens).toBe(50);
    rmSync(dir, { recursive: true, force: true });
    await driver.teardown();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `configs/b-rerank.ts`**

```ts
import { createConfigA } from './a-bm25.js';
import { ZeroEntropy } from 'zeroentropy';
import type { BenchCorpus, BenchQuestion, ConfigDriver, RetrievalResult, RetrievedDoc } from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface RerankClient {
  rerank(query: string, docs: Array<{ docId: string; text: string }>): Promise<{
    reranked: Array<{ docId: string; score: number }>;
    tokens: number;
  }>;
}

export interface ConfigBOptions extends ConfigFactoryOptions {
  rerankClient: RerankClient;
  bm25CandidateCount?: number;
}

export function createConfigB(opts: ConfigBOptions): ConfigDriver {
  const inner = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;
  return {
    name: 'b-rerank',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await inner.build(corpus);
    },
    async teardown() {
      corpusRef = null;
      await inner.teardown();
    },
    async retrieve(question: BenchQuestion, topK: number, signal: AbortSignal): Promise<RetrievalResult> {
      const candidateK = opts.bm25CandidateCount ?? topK * 3;
      const inner1 = await inner.retrieve(question, candidateK, signal);
      if (!corpusRef) throw new Error('Config B: build() not called');
      const docs = inner1.retrievedDocs.map((d) => ({
        docId: d.path,
        text: corpusRef!.memoryTree.get(d.path)?.summary ?? d.summary,
      }));
      const t0 = Date.now();
      const reranked = await opts.rerankClient.rerank(question.text, docs);
      const reorderMs = Date.now() - t0;
      const scoreMap = new Map(reranked.reranked.map((r) => [r.docId, r.score]));
      const retrieved: RetrievedDoc[] = inner1.retrievedDocs
        .map((d) => ({ ...d, score: scoreMap.get(d.path) ?? -Infinity }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return {
        retrievedDocs: retrieved,
        latencyMs: inner1.latencyMs + reorderMs,
        embeddingTokens: 0,
        rerankTokens: reranked.tokens,
      };
    },
  };
}

export function makeZeroEntropyRerankClient(apiKey: string, model = 'zerank-2'): RerankClient {
  const z = new ZeroEntropy({ apiKey });
  return {
    async rerank(query, docs) {
      const resp = await z.models.rerank({
        model,
        query,
        documents: docs.map((d) => d.text),
      });
      const items = (resp as any).results as Array<{ index: number; relevance_score: number }>;
      const reranked = items.map((it) => ({ docId: docs[it.index].docId, score: it.relevance_score }));
      const tokens = (resp as any).usage?.total_tokens ?? 0;
      return { reranked, tokens };
    },
  };
}
```

Note: ZeroEntropy SDK is `0.1.0-alpha.10`. The response shape (`results` array of `{index, relevance_score}` plus a `usage` field) is the inferred shape; the implementing engineer verifies against the live SDK on first run and adjusts. The `as any` is a deliberate test-time accommodation.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/configs/b-rerank.ts packages/memory-strata/test/bench/__tests__/configs.test.ts
git commit -m "feat(memory-strata): bench Config B (rerank) (Phase 3A)"
```

---

### Task 3A.12: Config C driver (BM25 + zembed-1 + RRF)

**Files:**
- Create: `packages/memory-strata/test/bench/configs/c-rrf.ts`
- Modify: `packages/memory-strata/test/bench/__tests__/configs.test.ts`

- [ ] **Step 1: Add a failing test (stubbed embedder)**

Append to `configs.test.ts`:

```ts
import { createConfigC, rrfFuse } from '../configs/c-rrf.js';

describe('rrfFuse', () => {
  it('combines two ranked lists with reciprocal rank fusion', () => {
    const bm = [{ path: 'a', score: 1 }, { path: 'b', score: 0.5 }];
    const vec = [{ path: 'b', score: 0.9 }, { path: 'c', score: 0.8 }];
    const fused = rrfFuse(bm, vec, { k: 60, topK: 3 });
    expect(fused[0].path).toBe('b');  // appears in both lists → top
  });
});

describe('Config C (BM25 + dense + RRF)', () => {
  it('returns a fused list and accounts embedding tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-c-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'knowledge', slug: 'd1', summary: 'first', body: 'apple banana' });
    const d2 = makeDoc({ category: 'knowledge', slug: 'd2', summary: 'second', body: 'orange grape' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigC({
      tempDir: dir,
      embedClient: {
        async embed(texts) {
          return { vectors: texts.map((t) => [t.length, 0, 0, 0]), tokens: texts.length * 10 };
        },
      },
      embeddingDim: 4,
    });
    await driver.build(corpus);
    const r = await driver.retrieve(
      { id: 'q', text: 'apple', goldAnswer: 'fruit' },
      2,
      new AbortController().signal,
    );
    expect(r.retrievedDocs.length).toBeGreaterThan(0);
    expect(r.embeddingTokens).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
    await driver.teardown();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `configs/c-rrf.ts`**

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
import { createConfigA } from './a-bm25.js';
import { ZeroEntropy } from 'zeroentropy';
import type { BenchCorpus, BenchQuestion, ConfigDriver, RetrievalResult, RetrievedDoc } from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface EmbedClient {
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
}

export interface ConfigCOptions extends ConfigFactoryOptions {
  embedClient: EmbedClient;
  embeddingDim?: number;
  rrfK?: number;
  candidateK?: number;
}

export function rrfFuse(
  bm25: Array<{ path: string; score: number }>,
  vector: Array<{ path: string; score: number }>,
  opts: { k: number; topK: number },
): Array<{ path: string; score: number }> {
  const fused = new Map<string, number>();
  bm25.forEach((d, i) => fused.set(d.path, (fused.get(d.path) ?? 0) + 1 / (opts.k + i + 1)));
  vector.forEach((d, i) => fused.set(d.path, (fused.get(d.path) ?? 0) + 1 / (opts.k + i + 1)));
  return [...fused.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);
}

export function createConfigC(opts: ConfigCOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let db: Database.Database | null = null;
  let corpusRef: BenchCorpus | null = null;
  const dim = opts.embeddingDim ?? 1024;
  const rrfK = opts.rrfK ?? 60;
  const candidateK = opts.candidateK ?? 30;
  let totalEmbedTokens = 0;

  return {
    name: 'c-rrf',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await bm.build(corpus);
      const vecPath = join(opts.tempDir, `${corpus.name}.vec.db`);
      db = new Database(vecPath);
      sqliteVec.load(db);
      db.exec(`CREATE VIRTUAL TABLE docs USING vec0(embedding float[${dim}]);`);
      db.exec(`CREATE TABLE doc_map (rowid INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);`);
      const insertVec = db.prepare(`INSERT INTO docs(rowid, embedding) VALUES (?, ?)`);
      const insertMap = db.prepare(`INSERT INTO doc_map(rowid, path) VALUES (?, ?)`);
      const paths = [...corpus.memoryTree.keys()];
      const texts = paths.map((p) => {
        const d = corpus.memoryTree.get(p)!;
        return `${d.summary}\n${d.headers}`;
      });
      const embed = await opts.embedClient.embed(texts);
      totalEmbedTokens += embed.tokens;
      const txn = db.transaction(() => {
        for (let i = 0; i < paths.length; i++) {
          insertMap.run(i + 1, paths[i]);
          insertVec.run(i + 1, Buffer.from(new Float32Array(embed.vectors[i]).buffer));
        }
      });
      txn();
    },
    async teardown() {
      if (db) { db.close(); db = null; }
      corpusRef = null;
      await bm.teardown();
    },
    async retrieve(question: BenchQuestion, topK: number, signal: AbortSignal): Promise<RetrievalResult> {
      if (!db || !corpusRef) throw new Error('Config C: build() not called');
      const t0 = Date.now();
      const [bmResult, qEmbed] = await Promise.all([
        bm.retrieve(question, candidateK, signal),
        opts.embedClient.embed([question.text]),
      ]);
      totalEmbedTokens += qEmbed.tokens;
      const qVecBuf = Buffer.from(new Float32Array(qEmbed.vectors[0]).buffer);
      const vecHits = db.prepare(
        `SELECT m.path AS path, d.distance AS distance
         FROM docs d JOIN doc_map m USING (rowid)
         WHERE d.embedding MATCH ? AND k = ?
         ORDER BY distance ASC`,
      ).all(qVecBuf, candidateK) as Array<{ path: string; distance: number }>;
      const vecList = vecHits.map((h) => ({ path: h.path, score: -h.distance }));
      const bmList = bmResult.retrievedDocs.map((d) => ({ path: d.path, score: d.score }));
      const fused = rrfFuse(bmList, vecList, { k: rrfK, topK });
      const retrievedDocs: RetrievedDoc[] = fused.map((f) => ({
        path: f.path,
        score: f.score,
        summary: corpusRef!.memoryTree.get(f.path)?.summary ?? '',
      }));
      return {
        retrievedDocs,
        latencyMs: Date.now() - t0,
        embeddingTokens: totalEmbedTokens,
        rerankTokens: 0,
      };
    },
  };
}

export function makeZeroEntropyEmbedClient(apiKey: string, model = 'zembed-1'): EmbedClient {
  const z = new ZeroEntropy({ apiKey });
  return {
    async embed(texts) {
      const resp = await z.models.embed({ model, input: texts });
      const items = (resp as any).data as Array<{ embedding: number[] }>;
      const vectors = items.map((i) => i.embedding);
      const tokens = (resp as any).usage?.total_tokens ?? 0;
      return { vectors, tokens };
    },
  };
}
```

Note: the `sqlite-vec` virtual table query syntax (`MATCH` + `k = ?`) matches the extension's documented API as of 0.1.x. The vector dimension (1024) is the published zembed-1 size; verify on live-smoke and update if different.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/configs/c-rrf.ts packages/memory-strata/test/bench/__tests__/configs.test.ts
git commit -m "feat(memory-strata): bench Config C (dense + RRF) (Phase 3A)"
```

---

### Task 3A.13: Report writer

**Files:**
- Create: `packages/memory-strata/test/bench/report.ts`
- Create: `packages/memory-strata/test/bench/__tests__/report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderReport } from '../report.js';
import type { QuestionResult } from '../types.js';

const sampleResult: QuestionResult = {
  corpus: 'internal',
  config: 'a-bm25',
  question: { id: 'q1', text: 'x?', goldAnswer: 'y' },
  retrieval: { retrievedDocs: [{ path: 'a', score: 1, summary: 's' }], latencyMs: 10, embeddingTokens: 0, rerankTokens: 0 },
  agentAnswer: 'y',
  verdict: 'correct',
  judgeReason: 'matches',
  agentTokens: { in: 100, out: 5 },
  judgeTokens: { in: 50, out: 5 },
  totalDollars: 0.001,
};

describe('renderReport', () => {
  it('produces markdown with per-corpus tables and a decision section', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 0.001,
      capExceeded: false,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toContain('# Strata vector-vs-no-vector spike report');
    expect(md).toContain('2026-05-12');
    expect(md).toContain('| internal');
    expect(md).toContain('Binding decision');
  });

  it('marks the report as aborted when cap is exceeded', () => {
    const md = renderReport({
      results: [sampleResult],
      cap: 50,
      totalSpent: 50.01,
      capExceeded: true,
      runDate: new Date('2026-05-12T00:00:00Z'),
    });
    expect(md).toMatch(/Aborted: cost cap exceeded/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement `report.ts`**

```ts
import type { QuestionResult, ConfigName, BenchCorpus } from './types.js';

export interface ReportInput {
  results: QuestionResult[];
  cap: number;
  totalSpent: number;
  capExceeded: boolean;
  runDate: Date;
}

type CorpusName = BenchCorpus['name'];

interface Aggregate {
  total: number;
  correct: number;
  uncertain: number;
  latencyP50: number;
  latencyP95: number;
  totalDollars: number;
  totalAgentInTokens: number;
  totalAgentOutTokens: number;
  recallAt5: number;
}

function aggregateByConfig(results: QuestionResult[]): Map<CorpusName, Map<ConfigName, Aggregate>> {
  const byCorpus = new Map<CorpusName, Map<ConfigName, Aggregate>>();
  for (const r of results) {
    if (!byCorpus.has(r.corpus)) byCorpus.set(r.corpus, new Map());
    const cm = byCorpus.get(r.corpus)!;
    if (!cm.has(r.config)) cm.set(r.config, {
      total: 0, correct: 0, uncertain: 0, latencyP50: 0, latencyP95: 0, totalDollars: 0,
      totalAgentInTokens: 0, totalAgentOutTokens: 0, recallAt5: 0,
    });
    const a = cm.get(r.config)!;
    a.total += 1;
    if (r.verdict === 'correct') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
    a.totalDollars += r.totalDollars;
    a.totalAgentInTokens += r.agentTokens.in;
    a.totalAgentOutTokens += r.agentTokens.out;
    if (r.question.goldDocIds && r.question.goldDocIds.length > 0) {
      const top5 = r.retrieval.retrievedDocs.slice(0, 5).map((d) => d.path);
      const hit = r.question.goldDocIds.some((g) => top5.includes(g));
      if (hit) a.recallAt5 += 1;
    }
  }
  for (const [corpus, cm] of byCorpus) {
    for (const [config, a] of cm) {
      const latencies = results
        .filter((r) => r.corpus === corpus && r.config === config)
        .map((r) => r.retrieval.latencyMs)
        .sort((x, y) => x - y);
      a.latencyP50 = percentile(latencies, 0.5);
      a.latencyP95 = percentile(latencies, 0.95);
      a.recallAt5 = a.recallAt5 / Math.max(a.total, 1);
    }
  }
  return byCorpus;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

const CONFIG_LABELS: Record<ConfigName, string> = {
  'a-bm25': 'A: BM25-only',
  'b-rerank': 'B: BM25 + zerank-2',
  'c-rrf': 'C: BM25 + zembed-1 + RRF',
};

export function renderReport(input: ReportInput): string {
  const date = input.runDate.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Strata vector-vs-no-vector spike report`);
  lines.push(``);
  lines.push(`**Date:** ${date}`);
  lines.push(`**Cap:** $${input.cap}`);
  lines.push(`**Total spent:** $${input.totalSpent.toFixed(4)}`);
  if (input.capExceeded) {
    lines.push(``);
    lines.push(`> **Aborted: cost cap exceeded.** Report reflects partial results.`);
  }
  lines.push(``);
  const agg = aggregateByConfig(input.results);
  for (const [corpus, cm] of agg) {
    lines.push(`## Corpus: ${corpus}`);
    lines.push(``);
    lines.push(`| Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const [config, a] of cm) {
      lines.push(`| ${CONFIG_LABELS[config]} | ${a.total} | ${(100 * a.correct / a.total).toFixed(1)}% | ${(100 * a.recallAt5).toFixed(1)}% | ${(100 * a.uncertain / a.total).toFixed(1)}% | ${a.latencyP50} | ${a.latencyP95} | $${a.totalDollars.toFixed(4)} |`);
    }
    lines.push(``);
  }
  lines.push(`## Binding decision`);
  lines.push(``);
  lines.push(`Apply the roadmap's >= 3-point LongMemEval-S accuracy threshold:`);
  lines.push(`- If C beats both A and B by >= 3 points -> Level 3 stays IN.`);
  lines.push(`- If A or B comes within 3 points of C -> Level 3 is OUT.`);
  lines.push(`- If B beats A by a clear margin but C does not beat B -> Level 3 OUT, prioritise reranker (Level 6) in Phase 4.`);
  lines.push(``);
  lines.push(`> _Phase 3B PR author fills in the explicit decision based on the LongMemEval-S row above._`);
  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`- Internal corpus is synthetic; treat as directional, not authoritative.`);
  lines.push(`- Judge is Grok 4.3 (cross-family with Sonnet 4.6 agent under test), but still a large model with its own biases. Cross-judge sweep is a Phase 5+ follow-up if the decision is close.`);
  lines.push(`- LongMemEval and LoCoMo are research-licensed datasets; results are not redistributed.`);
  lines.push(`- zeroentropy@0.1.0-alpha.10 (alpha SDK) — re-runs may need to re-pin if the SDK changes.`);
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/report.ts packages/memory-strata/test/bench/__tests__/report.test.ts
git commit -m "feat(memory-strata): bench report writer (Phase 3A)"
```

---

### Task 3A.14: CLI orchestration

**Files:**
- Create: `packages/memory-strata/test/bench/cli.ts`

There is no dedicated unit test for `cli.ts` — Task 3A.15 (smoke) exercises the orchestration end-to-end through the driver functions.

- [ ] **Step 1: Implement `cli.ts`**

```ts
#!/usr/bin/env tsx
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { requireKeys } from './env.js';
import { CostMeter, type Pricing } from './meter.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalS } from './corpora/longmemeval-s.js';
import { loadLoCoMo } from './corpora/locomo.js';
import { loadInternalCorpus } from './corpora/internal.js';
import { createConfigA } from './configs/a-bm25.js';
import { createConfigB, makeZeroEntropyRerankClient } from './configs/b-rerank.js';
import { createConfigC, makeZeroEntropyEmbedClient } from './configs/c-rrf.js';
import { runAgent, makeAnthropicAgentClient, type AgentClient } from './agent.js';
import { judgeAnswer, makeOpenRouterJudgeClient, type JudgeClient } from './judge.js';
import { renderReport } from './report.js';
import type { BenchCorpus, ConfigName, ConfigDriver, QuestionResult } from './types.js';

const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};

interface CliArgs {
  corpus: 'longmemeval-s' | 'locomo' | 'internal' | 'all';
  config: ConfigName | 'all';
  sample?: number;
  smoke: boolean;
  liveSmoke: boolean;
  regenInternal: boolean;
  topK: number;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'all' },
      config: { type: 'string', default: 'all' },
      sample: { type: 'string' },
      smoke: { type: 'boolean', default: false },
      'live-smoke': { type: 'boolean', default: false },
      'regen-internal': { type: 'boolean', default: false },
      'top-k': { type: 'string', default: '10' },
    },
  });
  return {
    corpus: values.corpus as CliArgs['corpus'],
    config: values.config as CliArgs['config'],
    sample: values.sample ? Number(values.sample) : undefined,
    smoke: values.smoke === true,
    liveSmoke: values['live-smoke'] === true,
    regenInternal: values['regen-internal'] === true,
    topK: Number(values['top-k']),
  };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.smoke) {
    console.log('Run "pnpm --filter @ax/memory-strata test -- test/bench/__tests__/smoke.test.ts" for the smoke suite.');
    return 0;
  }

  if (args.regenInternal) {
    const env2 = requireKeys({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
    const { regenerateInternalCorpus } = await import('./corpora/internal.js');
    const result = await regenerateInternalCorpus({
      agentClient: makeAnthropicAgentClient(env2.ANTHROPIC_API_KEY),
      repoRoot: process.cwd(),
    });
    console.log(`Regenerated internal corpus: ${result.docCount} docs, ${result.questionCount} questions -> ${result.outputPath}`);
    return 0;
  }

  if (args.liveSmoke) {
    if (process.env.BENCH_LIVE !== '1') {
      console.error('--live-smoke requires BENCH_LIVE=1 in the environment. Aborting.');
      return 2;
    }
  }

  const env = requireKeys({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });

  const cache = new BenchCache();
  const meter = new CostMeter({ capDollars: args.liveSmoke ? 0.5 : 50, pricing: PRICING });
  const tempDir = mkdtempSync(join(tmpdir(), 'ax-bench-'));

  const agentClient: AgentClient = makeAnthropicAgentClient(env.ANTHROPIC_API_KEY);
  const judgeClient: JudgeClient = makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY);
  const rerankClient = makeZeroEntropyRerankClient(env.ZEROENTROPY_API_KEY);
  const embedClient = makeZeroEntropyEmbedClient(env.ZEROENTROPY_API_KEY);

  const corpora: BenchCorpus[] = [];
  const want = (name: BenchCorpus['name']) => args.corpus === 'all' || args.corpus === name;
  if (want('longmemeval-s')) corpora.push(await loadLongMemEvalS(cache));
  if (want('locomo')) corpora.push(await loadLoCoMo(cache));
  if (want('internal')) corpora.push(loadInternalCorpus());

  if (args.sample !== undefined) {
    for (const c of corpora) c.questions = c.questions.slice(0, args.sample);
  }

  const wantCfg = (n: ConfigName) => args.config === 'all' || args.config === n;
  const driverFactories: Array<() => ConfigDriver> = [];
  if (wantCfg('a-bm25')) driverFactories.push(() => createConfigA({ tempDir }));
  if (wantCfg('b-rerank')) driverFactories.push(() => createConfigB({ tempDir, rerankClient }));
  if (wantCfg('c-rrf')) driverFactories.push(() => createConfigC({ tempDir, embedClient }));

  const results: QuestionResult[] = [];
  let capExceeded = false;

  outer: for (const corpus of corpora) {
    for (const factory of driverFactories) {
      const driver = factory();
      await driver.build(corpus);
      try {
        for (const question of corpus.questions) {
          if (meter.projectWouldExceedCap('claude-sonnet-4-6', { in: 4000, out: 512 })) {
            capExceeded = true;
            break outer;
          }
          const retrieval = await driver.retrieve(question, args.topK, new AbortController().signal);
          if (retrieval.embeddingTokens > 0) meter.record('zembed-1', { in: retrieval.embeddingTokens, out: 0 });
          if (retrieval.rerankTokens > 0) meter.record('zerank-2', { in: retrieval.rerankTokens, out: 0 });
          const agentResp = await runAgent(agentClient, question, retrieval.retrievedDocs);
          meter.record('claude-sonnet-4-6', agentResp.usage);
          const verdict = await judgeAnswer(judgeClient, question.text, question.goldAnswer, agentResp.text);
          meter.record('x-ai/grok-4.3', verdict.usage);
          results.push({
            corpus: corpus.name,
            config: driver.name,
            question,
            retrieval,
            agentAnswer: agentResp.text,
            verdict: verdict.verdict,
            judgeReason: verdict.reason,
            agentTokens: agentResp.usage,
            judgeTokens: verdict.usage,
            totalDollars: 0,
          });
          if (results.length % 50 === 0) {
            console.log(`Progress: ${results.length} questions evaluated, $${meter.totalDollars().toFixed(2)} spent.`);
          }
        }
      } finally {
        await driver.teardown();
      }
    }
  }

  const date = new Date();
  const md = renderReport({
    results,
    cap: 50,
    totalSpent: meter.totalDollars(),
    capExceeded,
    runDate: date,
  });
  const outPath = `docs/plans/${date.toISOString().slice(0, 10)}-memory-strata-vector-spike-report.md`;
  writeFileSync(outPath, md);
  console.log(`Report written to ${outPath}. Total spend: $${meter.totalDollars().toFixed(2)}.`);
  rmSync(tempDir, { recursive: true, force: true });
  return capExceeded ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the CLI module type-checks**

```bash
pnpm --filter @ax/memory-strata typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/memory-strata/test/bench/cli.ts
git commit -m "feat(memory-strata): bench CLI orchestration (Phase 3A)"
```

---

### Task 3A.15: Smoke test (stubbed end-to-end)

**Files:**
- Create: `packages/memory-strata/test/bench/__tests__/smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigA } from '../configs/a-bm25.js';
import { createConfigB } from '../configs/b-rerank.js';
import { createConfigC } from '../configs/c-rrf.js';
import { runAgent } from '../agent.js';
import { judgeAnswer } from '../judge.js';
import type { BenchCorpus } from '../types.js';
import { makeDoc } from '../corpora/shared.js';

function makeStubCorpus(name: BenchCorpus['name']): BenchCorpus {
  const c: BenchCorpus = { name, memoryTree: new Map(), questions: [] };
  for (let i = 0; i < 10; i++) {
    const d = makeDoc({
      category: 'knowledge',
      slug: `doc-${i}`,
      summary: `Summary of doc ${i}`,
      body: `# Doc ${i}\n## Section\nThis doc covers topic-${i} extensively.`,
    });
    c.memoryTree.set(d.path, d);
    c.questions.push({
      id: `q-${i}`,
      text: `What does topic-${i} cover?`,
      goldAnswer: `topic-${i}`,
      goldDocIds: [d.path],
    });
  }
  return c;
}

describe('Smoke: all configs × 3 corpora × 10 Qs with stubbed LLMs', () => {
  it('runs end-to-end without network in under 2 minutes', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-smoke-'));
    const corpora: BenchCorpus[] = [
      makeStubCorpus('longmemeval-s'),
      makeStubCorpus('locomo'),
      makeStubCorpus('internal'),
    ];
    const agentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'topic-stub', usage: { in: 100, out: 5 } }),
    };
    const judgeClient = {
      complete: vi.fn().mockResolvedValue({ text: 'VERDICT: correct\nREASON: ok', usage: { in: 50, out: 5 } }),
    };
    const rerankClient = {
      async rerank(_q: string, docs: Array<{ docId: string; text: string }>) {
        return { reranked: docs.map((d, i) => ({ docId: d.docId, score: 1 - i * 0.01 })), tokens: 10 };
      },
    };
    const embedClient = {
      async embed(texts: string[]) {
        return { vectors: texts.map((t) => Array.from({ length: 4 }, (_, i) => (t.length + i) % 100 / 100)), tokens: texts.length * 10 };
      },
    };
    const drivers = [
      createConfigA({ tempDir: dir }),
      createConfigB({ tempDir: dir, rerankClient }),
      createConfigC({ tempDir: dir, embedClient, embeddingDim: 4 }),
    ];
    for (const corpus of corpora) {
      for (const driver of drivers) {
        await driver.build(corpus);
        try {
          for (const q of corpus.questions) {
            const r = await driver.retrieve(q, 5, new AbortController().signal);
            const a = await runAgent(agentClient, q, r.retrievedDocs);
            const v = await judgeAnswer(judgeClient, q.text, q.goldAnswer, a.text);
            expect(v.verdict).toBe('correct');
          }
        } finally {
          await driver.teardown();
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the smoke**

```bash
pnpm --filter @ax/memory-strata test -- test/bench/__tests__/smoke.test.ts
```
Expected: PASS in under 2 minutes.

- [ ] **Step 3: Commit**

```bash
git add packages/memory-strata/test/bench/__tests__/smoke.test.ts
git commit -m "test(memory-strata): bench smoke test (Phase 3A I30)"
```

---

### Task 3A.16: Internal corpus regen + 20% hand-spot-check

**Files:**
- Modify: `packages/memory-strata/test/bench/corpora/internal.ts` (add regen logic)
- Modify: `packages/memory-strata/test/bench/internal-corpus.json` (regenerate from real docs)
- Create: `docs/plans/2026-05-12-internal-corpus-spotcheck.md` (the hand-check log; local-only per gitignore)

This is the largest task. The synthesizer:
1. Reads selected files from `docs/plans/`, `.claude/memory/`, and `README.md` of root + `CLAUDE.md`.
2. Chunks each into one Strata-shaped doc per file.
3. For each triplet of docs, asks the agent to propose ONE Q&A pair answerable from those docs.
4. Writes everything to `internal-corpus.json`.

- [ ] **Step 1: Append `regenerateInternalCorpus` to `corpora/internal.ts`**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import type { AgentClient } from '../agent.js';

interface SourceFile { path: string; content: string; }

const SOURCE_GLOBS = [
  'docs/plans/*-design.md',
  'docs/plans/*-impl.md',
  '.claude/memory/*.md',
  'README.md',
  'CLAUDE.md',
];

const MAX_DOCS_FOR_REGEN = 60;

export async function regenerateInternalCorpus(opts: {
  agentClient: AgentClient;
  repoRoot: string;
  outputPath?: string;
}): Promise<{ docCount: number; questionCount: number; outputPath: string }> {
  const out = opts.outputPath ?? INTERNAL_CORPUS_PATH;
  const sources = await collectSources(opts.repoRoot);
  const docs: MarkdownDoc[] = [];
  for (const src of sources.slice(0, MAX_DOCS_FOR_REGEN)) {
    const slug = src.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
    const headers = src.content.split('\n').filter((l) => /^#{1,6}\s+/.test(l)).join('\n');
    const summary = headers.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 200) ?? '';
    docs.push({
      path: `knowledge/${slug}`,
      category: 'knowledge',
      slug,
      summary,
      factType: 'knowledge',
      headers,
      body: src.content,
    });
  }
  const questions: BenchQuestion[] = [];
  for (let i = 0; i < docs.length; i += 3) {
    const triplet = docs.slice(i, i + 3);
    const qa = await synthesizeQuestion(opts.agentClient, triplet);
    if (qa) questions.push(qa);
  }
  const payload: InternalCorpusFile = { docs, questions };
  writeFileSync(out, JSON.stringify(payload, null, 2));
  return { docCount: docs.length, questionCount: questions.length, outputPath: out };
}

async function collectSources(repoRoot: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  for (const pattern of SOURCE_GLOBS) {
    for await (const entry of glob(pattern, { cwd: repoRoot })) {
      const full = `${repoRoot}/${entry}`;
      try { found.push({ path: entry as string, content: readFileSync(full, 'utf8') }); }
      catch { /* ignore unreadable */ }
    }
  }
  return found;
}

async function synthesizeQuestion(
  client: AgentClient,
  docs: MarkdownDoc[],
): Promise<BenchQuestion | null> {
  const docBlock = docs.map((d, i) => `[${i + 1}] (${d.path})\n${d.body.slice(0, 1500)}`).join('\n\n---\n\n');
  const system = `Given some documents, propose exactly ONE question that is answerable from these documents and ONE concise gold answer.

Format:
QUESTION: <one specific question>
ANSWER: <one short answer that the documents support>

If the documents are insufficient to ground a precise question/answer pair, output exactly: SKIP.`;
  const user = docBlock;
  const resp = await client.complete({ system, user });
  if (/^\s*SKIP\b/i.test(resp.text)) return null;
  const qm = resp.text.match(/QUESTION:\s*(.+)/i);
  const am = resp.text.match(/ANSWER:\s*(.+)/i);
  if (!qm || !am) return null;
  return {
    id: `internal-${docs.map((d) => d.slug).join('+')}`,
    text: qm[1].trim(),
    goldAnswer: am[1].trim(),
    goldDocIds: docs.map((d) => d.path),
  };
}
```

The CLI already wires `--regen-internal` (Task 3A.14 step 1).

- [ ] **Step 2: Run regen against real repo (real Anthropic API call)**

```bash
ANTHROPIC_API_KEY=<set> pnpm --filter @ax/memory-strata bench --regen-internal
```
Expected: writes a populated `internal-corpus.json` with ~50–60 docs and ~15–20 questions. Cost: ~$0.50–1.50.

- [ ] **Step 3: Hand-spot-check 20% of generated questions**

Pick every 5th question (indices 0, 5, 10, 15, … through the generated list). For each, confirm:
- The question is answerable from the cited docs.
- The "gold answer" is genuinely correct, not just plausible.

Record each (question, gold, verdict, note) in a new file `docs/plans/2026-05-12-internal-corpus-spotcheck.md` (gitignored per project convention, lives locally):

```markdown
# Internal corpus 20% hand-spot-check — 2026-05-12

Sampled questions: q0, q5, q10, q15 (every 5th of N generated).

| ID | Question | Gold | Verdict | Notes |
|---|---|---|---|---|
| q0  | <quote> | <quote> | OK / WRONG / AMBIGUOUS | ... |
| q5  | ... | ... | ... | ... |
| q10 | ... | ... | ... | ... |
| q15 | ... | ... | ... | ... |

**Total OK:** N/4 -> X%

If <80%, supplement with up to 30 hand-authored Q&A pairs and re-run the smoke test.
```

- [ ] **Step 4: If hand-check accuracy is <80%, supplement**

Hand-author up to 30 additional questions against the existing `internal-corpus.json`'s docs. Append them to the `questions` array directly (no agent involvement). Re-run the smoke test to make sure the loader still works.

- [ ] **Step 5: Commit regen output**

```bash
git add packages/memory-strata/test/bench/corpora/internal.ts packages/memory-strata/test/bench/internal-corpus.json
git commit -m "feat(memory-strata): regenerate internal corpus + hand-spot-check (Phase 3A I31)"
```

(Note: `docs/plans/2026-05-12-internal-corpus-spotcheck.md` lives in the gitignored `docs/plans/` dir, same as this plan and the design doc — local only.)

---

### Task 3A.17: Live smoke test (BENCH_LIVE=1)

**Files:**
- Modify: `packages/memory-strata/test/bench/__tests__/smoke.test.ts` (add live block)

- [ ] **Step 1: Append a live-smoke block to `smoke.test.ts`**

```ts
describe.skipIf(process.env.BENCH_LIVE !== '1')('Live smoke (BENCH_LIVE=1, hard-fails above $0.50)', () => {
  it('runs one question with Config C against the internal corpus', { timeout: 60_000 }, async () => {
    const env = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    if (!env.ANTHROPIC_API_KEY || !env.ZEROENTROPY_API_KEY || !env.OPENROUTER_API_KEY) {
      throw new Error('Missing API keys for live smoke');
    }
    const { loadInternalCorpus } = await import('../corpora/internal.js');
    const corpus = loadInternalCorpus();
    expect(corpus.questions.length).toBeGreaterThan(0);

    const { createConfigC, makeZeroEntropyEmbedClient } = await import('../configs/c-rrf.js');
    const { runAgent, makeAnthropicAgentClient } = await import('../agent.js');
    const { judgeAnswer, makeOpenRouterJudgeClient } = await import('../judge.js');
    const { CostMeter } = await import('../meter.js');

    const meter = new CostMeter({ capDollars: 0.5, pricing: {
      'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
      'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
      'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
      'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
    }});

    const dir = mkdtempSync(join(tmpdir(), 'bench-live-'));
    const driver = createConfigC({ tempDir: dir, embedClient: makeZeroEntropyEmbedClient(env.ZEROENTROPY_API_KEY!) });
    await driver.build(corpus);
    const question = corpus.questions[0];
    const r = await driver.retrieve(question, 5, new AbortController().signal);
    meter.record('zembed-1', { in: r.embeddingTokens, out: 0 });

    const a = await runAgent(makeAnthropicAgentClient(env.ANTHROPIC_API_KEY!), question, r.retrievedDocs);
    meter.record('claude-sonnet-4-6', a.usage);

    const v = await judgeAnswer(makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY!), question.text, question.goldAnswer, a.text);
    meter.record('x-ai/grok-4.3', v.usage);

    await driver.teardown();
    rmSync(dir, { recursive: true, force: true });

    expect(meter.totalDollars()).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run the live smoke (requires real API keys)**

```bash
BENCH_LIVE=1 ANTHROPIC_API_KEY=… ZEROENTROPY_API_KEY=… OPENROUTER_API_KEY=… \
  pnpm --filter @ax/memory-strata test -- test/bench/__tests__/smoke.test.ts
```
Expected: PASS. If pricing or SDK shapes differ from this plan's assumptions, adjust the wrapper or pricing table.

- [ ] **Step 3: Commit**

```bash
git add packages/memory-strata/test/bench/__tests__/smoke.test.ts
git commit -m "test(memory-strata): bench live-smoke gated on BENCH_LIVE=1 (Phase 3A)"
```

---

### Task 3A.18: Ship-list test + invariant audit

**Files:**
- Create: `packages/memory-strata/test/bench/__tests__/ship-list.test.ts`

- [ ] **Step 1: Write the ship-list test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PKG_ROOT = join(new URL('./', import.meta.url).pathname, '../../../');
const SRC_DIR = join(PKG_ROOT, 'src');
const PKG_JSON = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('Phase 3A ship list', () => {
  it('I25: no bench module names appear in src/', () => {
    const forbidden = ['createConfigA', 'createConfigB', 'createConfigC', 'BenchCache', 'CostMeter', 'judgeAnswer', 'runAgent'];
    const srcFiles = walk(SRC_DIR);
    for (const f of srcFiles) {
      const content = readFileSync(f, 'utf8');
      for (const term of forbidden) {
        expect(content, `${f} should not reference ${term}`).not.toContain(term);
      }
    }
  });

  it('I26: bench-only deps are in devDependencies only', () => {
    const benchOnly = ['zeroentropy', 'openai', '@huggingface/hub', 'sqlite-vec'];
    for (const dep of benchOnly) {
      expect(PKG_JSON.dependencies?.[dep], `${dep} must not be in dependencies`).toBeUndefined();
      expect(PKG_JSON.devDependencies?.[dep], `${dep} must be in devDependencies`).toBeDefined();
    }
  });

  it('I29: API keys are not echoed in any bench file', () => {
    const benchFiles = walk(join(PKG_ROOT, 'test/bench'));
    const forbidden = [
      'console.log(process.env.ANTHROPIC',
      'console.log(process.env.ZEROENTROPY',
      'console.log(process.env.OPENROUTER',
    ];
    for (const f of benchFiles) {
      const content = readFileSync(f, 'utf8');
      for (const term of forbidden) {
        expect(content, `${f} should not log API keys`).not.toContain(term);
      }
    }
  });
});
```

- [ ] **Step 2: Run the ship-list test**

```bash
pnpm --filter @ax/memory-strata test -- test/bench/__tests__/ship-list.test.ts
```
Expected: PASS.

- [ ] **Step 3: Run the full @ax/memory-strata test suite to verify nothing regressed**

```bash
pnpm --filter @ax/memory-strata test
pnpm --filter @ax/memory-strata lint
pnpm --filter @ax/memory-strata typecheck
```
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/memory-strata/test/bench/__tests__/ship-list.test.ts
git commit -m "test(memory-strata): bench ship-list test (Phase 3A I25/I26/I29)"
```

---

### Task 3A.19: PR notes + invariant audit table

- [ ] **Step 1: Draft PR notes locally** (not committed; pasted into the PR description)

```markdown
## Phase 3A — Strata eval harness scaffolding

Lands the scaffolding for the Phase 3 vector-vs-no-vector spike: three retrieval config drivers (A: BM25 baseline, B: BM25 + zerank-2 rerank, C: BM25 + zembed-1 dense + RRF), three corpus loaders (LongMemEval-S, LoCoMo, internal synthesized from real ax-next docs), a $50-hard-cap cost meter, a markdown report writer, stubbed smoke tests, and a single live-smoke gated behind `BENCH_LIVE=1 + --live-smoke`. The binding three-config run lands in Phase 3B.

### Half-wired window

**N/A — dev-only on-demand bench.** No CLI/k8s preset wiring. The bench is invoked via `pnpm --filter @ax/memory-strata bench …` for the binding-decision run.

### Invariant audit

| # | Invariant | Status |
|---|---|---|
| I25 | No production code paths added (bench lives entirely under `test/bench/`) | yes — ship-list test |
| I26 | All new deps are devDependencies (`zeroentropy`, `openai`, `@huggingface/hub`, `sqlite-vec`) | yes — ship-list test |
| I27 | Cross-plugin import is bench-only (eslint exception scoped to `packages/memory-strata/test/bench/**`) | yes — eslint config |
| I28 | Cost meter is a hard cap (projection-before-call abort) | yes — unit test |
| I29 | API keys are env-only, never logged | yes — ship-list test |
| I30 | `--smoke` runs offline; `--live-smoke` requires `BENCH_LIVE=1` | yes — smoke test + cli check |
| I31 | Internal corpus is deterministic between regens | yes — internal-corpus.json committed; `--regen-internal` gated |
| I32 | Half-wired window N/A — dev-only bench | yes — this PR notes |

### Trigger-gap disclosure (per `feedback_check_plan_vs_reality`)

Roadmap Phase 3 trigger said "Phase 2 retrieval has been running for >= 1 week". Phase 2A and 2B both shipped 2026-05-11; this PR was opened 2026-05-12. Decision (user-authorized) was to proceed in full, accepting that the internal-corpus signal is synthetic-only. See `docs/plans/2026-05-12-memory-strata-phase-3-design.md` § "Trigger gap acknowledgement".

### Internal-corpus hand-spot-check

Sampled <N>/<M> generated questions. Accuracy: <X>%. <Note any supplementation>.
Detailed log: `docs/plans/2026-05-12-internal-corpus-spotcheck.md` (gitignored; available locally).

### What this PR does NOT do

- Run the binding three-config bench. That's Phase 3B.
- Wire vectors into production indexer packages. Gated on Phase 3B's decision.
- Add a tokenizer for fallback cost estimation. We rely on each provider's reported `usage`.
- Multi-judge sweep. Phase 5+ if the binding decision is close.

### Boundary review

Phase 3A adds no new service hooks. Existing `memory:index:upsert/search/delete/clear` hooks are consumed unchanged. Cross-plugin import is documented in the eslint exception with a pointer to this PR's design doc.
```

- [ ] **Step 2: Open the PR**

When ready, push the branch and open the PR using the project's normal flow.

- [ ] **Step 3: Verify CI green before merging**

CI must run:
- `pnpm --filter @ax/memory-strata test` (stubbed smoke + unit tests + ship-list)
- `pnpm --filter @ax/memory-strata lint`
- `pnpm --filter @ax/memory-strata typecheck`

The live-smoke does NOT run in CI (gated behind `BENCH_LIVE=1`).

---

## Self-review checklist

Run these before opening the PR:

- [ ] All 19 tasks above are committed and CI-green.
- [ ] Bench scripts run as expected (smoke under 2 min, exit 0).
- [ ] Live smoke runs once locally with real API keys (proves SDK shapes are right) and stays under $0.50.
- [ ] Internal-corpus hand-spot-check report exists and shows >= 80% accuracy (or the supplemented hand-author pack closes the gap).
- [ ] PR notes include the half-wired-window N/A line and the eight-row invariant audit.
- [ ] No new code in `packages/memory-strata/src/`.
- [ ] No production runtime imports added across plugins.
- [ ] No `console.log` of API keys anywhere in `test/bench/`.

## Phase 3B preview (not in this plan)

After Phase 3A merges and the harness has been exercised once via live-smoke, Phase 3B's plan is short:

1. Run `pnpm --filter @ax/memory-strata bench --corpus all --config all` end-to-end.
2. Inspect the generated `docs/plans/<run-date>-memory-strata-vector-spike-report.md`.
3. Fill in the "Binding decision" section based on the LongMemEval-S row applying the >= 3-point threshold.
4. Update `docs/plans/memory-strata-design.md` Progressive Enhancement Path Level 3 wording to match (IN / OUT / OPT-IN).
5. Update `docs/plans/2026-05-10-memory-strata-roadmap.md` Phase 4 trigger language if Level 3 is OUT.
6. If Level 3 is IN, file a follow-up GitHub issue for the production vector-indexer wire-in.
7. Open Phase 3B PR with the report + design-doc + roadmap diffs.

Phase 3B's own impl plan will be written when 3A merges.
