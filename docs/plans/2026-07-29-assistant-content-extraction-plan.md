# Assistant-Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@ax/memory-strata` extract and store durable content *the assistant provided* (recommendations, named entities, specific values, enumerated lists), lifting LongMemEval-S `single-session-assistant` from 25.9% (14/54) toward 65%+ without regressing the other five question types or correct-refusal.

**Architecture:** A prompt + taxonomy change inside the Observer. A new `factType: 'answer'` maps to the **existing** `docs/general` category, so an assistant fact lands in the *same* doc as the user-side fact on that subject and BM25 finds it with no retrieval change. A truncation safety net (token cap raise + salvage parse) protects the other question types from the extra output volume. A targeted bench filter (`--types`/`--ids`) makes iteration cost $15 instead of $143.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), vitest, tsx for bench scripts, Anthropic SDK (Haiku 4.5 extraction / Sonnet 4.6 answer), OpenRouter (grok-4.3 judge).

**Design doc:** `docs/plans/2026-07-29-assistant-content-extraction-design.md`
**Brief:** `docs/plans/2026-07-10-assistant-content-extraction-brief.md`

## Global Constraints

- **Branch:** all work happens on `fix/bench-final-session-inbox-stranding`. `main` under-measures (it lacks the inbox-stranding fix) — never bench from it.
- **Bug Fix Policy (CLAUDE.md):** every behavior change lands with a test that would have caught its absence. The test goes in *before* the fix is considered done.
- **TDD:** write the failing test, run it, watch it fail for the *expected reason*, then implement.
- **Invariant 2 (no cross-plugin imports):** every production edit stays inside `packages/memory-strata`.
- **Invariant 5 (capabilities explicit and minimized):** assistant output is untrusted model output. The write-time (I7) and promote-time (I11) sensitive gates must remain on the path — Task 6 proves it.
- **`exactOptionalPropertyTypes` is on.** Never write `foo: undefined`; use conditional spread (`...(x !== undefined ? { x } : {})`). This is the project's standard fix and it is already used throughout `test/bench/`.
- **Test gate before any PR:** `pnpm --filter @ax/memory-strata test` **and** `pnpm build` (vitest tolerates undeclared workspace deps; `tsc` rejects them — both are required).
- **Bench runs import via `dist/`.** `pnpm --filter @ax/memory-strata build` before *every* paid run or you measure stale code and get a silently wrong result.
- **No new dependencies.** Nothing in this plan needs one.

---

### Task 1: Targeted bench sample selection (`--types` / `--ids`)

Ships alone as **PR-A**. No production code — bench harness only. This exists because the corpus is ordered in type blocks and the first `single-session-assistant` question is at **position 434**, so `--sample 100` (and even `--sample 400`) contains **zero** of them. Filtering must therefore happen **before** the limit slice.

**Files:**
- Create: `packages/memory-strata/test/bench/e2e-select.ts`
- Create: `packages/memory-strata/test/bench/__tests__/e2e-select.test.ts`
- Modify: `packages/memory-strata/test/bench/cli.ts` (`CliArgs`, `parseCliArgs` options, the `args.mode === 'e2e'` branch at ~line 121)
- Modify: `packages/memory-strata/test/bench/e2e-cli.ts` (`RunE2EOptions`, the `.slice(0, opts.sample)` at ~line 100, the `command` string at ~line 191)
- Modify: `packages/memory-strata/test/bench/__tests__/cli-args.test.ts`

**Interfaces:**
- Consumes: `LongMemEvalSample` from `./corpora/longmemeval-s.js` (fields used: `question_id: string`, `question_type?: string`).
- Produces: `selectSamples({ samples, types?, ids?, limit }): LongMemEvalSample[]` and `parseCsvFlag(raw: string | undefined): string[] | undefined` — both from `test/bench/e2e-select.ts`. Task 2 uses `selectSamples` to pick its repro transcripts.

- [ ] **Step 1: Write the failing test**

Create `packages/memory-strata/test/bench/__tests__/e2e-select.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectSamples, parseCsvFlag } from '../e2e-select.js';
import type { LongMemEvalSample } from '../corpora/longmemeval-s.js';

/** Minimal sample; only question_id + question_type drive selection. */
function mk(id: string, type: string): LongMemEvalSample {
  return {
    question_id: id,
    question_type: type,
    question: 'q',
    answer: 'a',
    haystack_session_ids: [],
    haystack_sessions: [],
  };
}

/** Mirrors the real corpus's TYPE-BLOCK ordering: the target type is last. */
function corpus(): LongMemEvalSample[] {
  const out: LongMemEvalSample[] = [];
  for (let i = 0; i < 100; i++) out.push(mk(`user-${i}`, 'single-session-user'));
  for (let i = 0; i < 20; i++) out.push(mk(`asst-${i}`, 'single-session-assistant'));
  return out;
}

describe('selectSamples', () => {
  it('with no filters is identical to slice(0, limit) — back-compat guard', () => {
    const all = corpus();
    expect(selectSamples({ samples: all, limit: 10 })).toEqual(all.slice(0, 10));
    expect(selectSamples({ samples: all, limit: 500 })).toEqual(all);
  });

  it('filters BEFORE the limit — the type-block trap', () => {
    // The assistant block starts at index 100. Filtering after a slice(0,100)
    // would yield ZERO rows; filtering first yields all 20.
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      limit: 100,
    });
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.question_type === 'single-session-assistant')).toBe(true);
  });

  it('selects explicit ids in corpus order', () => {
    const rows = selectSamples({ samples: corpus(), ids: ['asst-3', 'user-1'], limit: 500 });
    expect(rows.map((r) => r.question_id)).toEqual(['user-1', 'asst-3']);
  });

  it('unions types and ids', () => {
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      ids: ['user-0'],
      limit: 500,
    });
    expect(rows).toHaveLength(21);
    expect(rows[0]?.question_id).toBe('user-0');
  });

  it('still applies the limit to a filtered set', () => {
    const rows = selectSamples({
      samples: corpus(),
      types: ['single-session-assistant'],
      limit: 5,
    });
    expect(rows).toHaveLength(5);
  });

  it('returns empty (no throw) for an unknown type or id', () => {
    expect(selectSamples({ samples: corpus(), types: ['nope'], limit: 500 })).toEqual([]);
    expect(selectSamples({ samples: corpus(), ids: ['nope'], limit: 500 })).toEqual([]);
  });

  it('treats an empty filter list as no filter', () => {
    const all = corpus();
    expect(selectSamples({ samples: all, types: [], ids: [], limit: 500 })).toEqual(all);
  });
});

describe('parseCsvFlag', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCsvFlag('a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined for undefined or all-empty input', () => {
    expect(parseCsvFlag(undefined)).toBeUndefined();
    expect(parseCsvFlag('  , ')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/e2e-select.test.ts`
Expected: FAIL — `Cannot find module '../e2e-select.js'`.

- [ ] **Step 3: Implement `e2e-select.ts`**

Create `packages/memory-strata/test/bench/e2e-select.ts`:

```ts
// Targeted e2e sample selection. Exists because LongMemEval-S is ordered in
// TYPE BLOCKS (user 70 → multi 133 → preference 30 → temporal 132 →
// knowledge-update 69 → assistant 54), so the first single-session-assistant
// question sits at sample position 434: `--sample 100` contains ZERO of them and
// CANNOT measure an assistant-recall lever at all.
//
// The load-bearing detail is the ORDER: filter, THEN slice. Slicing first and
// filtering the remainder returns an empty set for any type whose block starts
// past the limit — the exact trap this module exists to defeat.
//
// With no filters this is `samples.slice(0, limit)`, byte-identical to the
// pre-existing behavior. Both flags are opt-in; run semantics are unchanged
// unless one is passed.

import type { LongMemEvalSample } from './corpora/longmemeval-s.js';

export interface SelectSamplesInput {
  /** The full loaded corpus, in corpus order. */
  samples: LongMemEvalSample[];
  /** `question_type` values to keep. Empty/absent = no type filter. */
  types?: string[] | undefined;
  /** `question_id` values to keep. Empty/absent = no id filter. */
  ids?: string[] | undefined;
  /** Max rows to return, applied AFTER filtering. */
  limit: number;
}

/**
 * Filter the corpus by question type and/or id, then cap it at `limit`.
 *
 * `types` and `ids` UNION (a row matching either is kept) so an operator can say
 * "the whole assistant block plus these two specific stragglers". Output stays in
 * corpus order regardless of the order ids were listed in, which keeps a resumed
 * run's ordering stable.
 */
export function selectSamples(input: SelectSamplesInput): LongMemEvalSample[] {
  const { samples, limit } = input;
  const typeSet = input.types && input.types.length > 0 ? new Set(input.types) : null;
  const idSet = input.ids && input.ids.length > 0 ? new Set(input.ids) : null;
  if (typeSet === null && idSet === null) return samples.slice(0, limit);
  const filtered = samples.filter(
    (s) =>
      (typeSet !== null && s.question_type !== undefined && typeSet.has(s.question_type)) ||
      (idSet !== null && idSet.has(s.question_id)),
  );
  return filtered.slice(0, limit);
}

/**
 * Parse a comma-separated CLI flag into a list. Returns undefined (not an empty
 * array) when there's nothing usable, so callers can omit the key entirely under
 * `exactOptionalPropertyTypes`.
 */
export function parseCsvFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/e2e-select.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing CLI-parsing tests**

Append to `packages/memory-strata/test/bench/__tests__/cli-args.test.ts`, inside the existing `describe`:

```ts
  it('parses --types and --ids as comma-separated lists', () => {
    const a = parseCliArgs([
      '--mode', 'e2e',
      '--types', 'single-session-assistant, multi-session',
      '--ids', 'q1,q2',
    ]);
    expect(a.types).toEqual(['single-session-assistant', 'multi-session']);
    expect(a.ids).toEqual(['q1', 'q2']);
  });

  it('leaves types/ids undefined when the flags are absent', () => {
    const a = parseCliArgs(['--mode', 'e2e']);
    expect(a.types).toBeUndefined();
    expect(a.ids).toBeUndefined();
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/cli-args.test.ts`
Expected: FAIL — `expected undefined to deeply equal [ 'single-session-assistant', 'multi-session' ]`.

- [ ] **Step 7: Wire the flags through `cli.ts`**

In `packages/memory-strata/test/bench/cli.ts`:

Add the import next to the other bench imports:

```ts
import { parseCsvFlag } from './e2e-select.js';
```

Add to the `CliArgs` interface, after the `fixture` field:

```ts
  /** e2e mode: only run questions of these `question_type`s (opt-in; unioned with --ids). */
  types?: string[];
  /** e2e mode: only run these `question_id`s (opt-in; unioned with --types). */
  ids?: string[];
```

Add to the `parseArgs` options object, after `fixture`:

```ts
      types: { type: 'string' },
      ids: { type: 'string' },
```

Add after the existing `if (values.resume) base.resume = values.resume;`:

```ts
  const types = parseCsvFlag(values.types as string | undefined);
  if (types !== undefined) base.types = types;
  const ids = parseCsvFlag(values.ids as string | undefined);
  if (ids !== undefined) base.ids = ids;
```

Extend the `runE2EMode` call in the `args.mode === 'e2e'` branch (~line 124):

```ts
    return runE2EMode({
      repoRoot: REPO_ROOT,
      sample: args.sample ?? (args.full ? 500 : 100),
      cap: args.cap ?? 25,
      fixture: args.fixture,
      ...(args.resume !== undefined ? { resumeId: args.resume } : {}),
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(args.ids !== undefined ? { ids: args.ids } : {}),
    });
```

- [ ] **Step 8: Run to verify the CLI tests pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/cli-args.test.ts`
Expected: PASS.

- [ ] **Step 9: Apply the selection in `e2e-cli.ts`**

In `packages/memory-strata/test/bench/e2e-cli.ts`:

Add the import:

```ts
import { selectSamples } from './e2e-select.js';
```

Add to `RunE2EOptions`, after `fixture`:

```ts
  /**
   * Opt-in question-type filter (e.g. `['single-session-assistant']`). Applied
   * BEFORE `sample` slices, because the corpus is ordered in type blocks — see
   * e2e-select.ts. Absent = no filter, i.e. today's behavior.
   */
  types?: string[];
  /** Opt-in question-id filter, unioned with `types`. */
  ids?: string[];
```

Replace the loader line (~line 100):

```ts
  const samples = selectSamples({
    samples: await loadLongMemEvalSSamples(cache),
    limit: opts.sample,
    ...(opts.types !== undefined ? { types: opts.types } : {}),
    ...(opts.ids !== undefined ? { ids: opts.ids } : {}),
  });
```

Add a console line right after it so a filtered run is unmistakable in the log:

```ts
  if (opts.types !== undefined || opts.ids !== undefined) {
    console.log(
      `Filtered run: ${samples.length} question(s)` +
        `${opts.types ? ` types=[${opts.types.join(',')}]` : ''}` +
        `${opts.ids ? ` ids=[${opts.ids.join(',')}]` : ''}. ` +
        'NOT comparable to a full-corpus overall score.',
    );
  }
```

Replace the `command` field passed to `renderE2EReport` (~line 191) so a filtered report can never be mistaken for a full run:

```ts
    command:
      `pnpm --filter @ax/memory-strata bench --mode e2e --sample ${opts.sample}` +
      `${opts.types ? ` --types ${opts.types.join(',')}` : ''}` +
      `${opts.ids ? ` --ids ${opts.ids.join(',')}` : ''}`,
```

- [ ] **Step 10: Run the full package suite + build**

Run: `pnpm --filter @ax/memory-strata test`
Expected: PASS, no regressions.

Run: `pnpm build`
Expected: clean (`tsc --build` must pass — vitest alone would not catch a type error here).

- [ ] **Step 11: Verify the filter end-to-end without spending money**

Run: `pnpm --filter @ax/memory-strata bench --mode e2e --fixture --types single-session-assistant`
Expected: exits 0. (Fixture mode ignores the filter by design — it uses its own two built-in samples — so this only proves the flags parse and don't break the path.)

- [ ] **Step 12: Commit**

```bash
git add packages/memory-strata/test/bench/e2e-select.ts \
        packages/memory-strata/test/bench/__tests__/e2e-select.test.ts \
        packages/memory-strata/test/bench/cli.ts \
        packages/memory-strata/test/bench/e2e-cli.ts \
        packages/memory-strata/test/bench/__tests__/cli-args.test.ts
git commit -m "test(memory-strata bench): --types/--ids targeted question filter

LongMemEval-S is ordered in type blocks, so the first single-session-assistant
question is at sample position 434: --sample 100 contains zero of them and cannot
measure an assistant-recall lever at all. Filter BEFORE slicing so a targeted run
of the 54 assistant questions costs ~\$15 instead of a \$143 full run.

Opt-in: with no flags, selectSamples is exactly samples.slice(0, limit), asserted
by a back-compat test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Live extraction repro (`repro-extract.ts`)

The honest red/green for this whole change. A stubbed LLM proves plumbing but **cannot** prove Haiku obeys the new prompt. This script runs the real Observer over three known-failing transcripts for a few cents, so we learn whether the prompt works *before* spending $15 — and again after, as the diff.

Written **now, before the prompt change**, so it captures the "before" behavior (assistant content discarded) as evidence.

**Files:**
- Create: `packages/memory-strata/test/bench/repro-extract.ts`

**Interfaces:**
- Consumes: `runObserver` from `../../src/observer.js`; `loadLongMemEvalSSamples` from `./corpora/longmemeval-s.js`; `BenchCache` from `./cache.js`; `makeAnthropicExtractionLlm` from `./e2e-cli.js`; `selectSamples` from `./e2e-select.js` (Task 1).
- Produces: nothing importable — a `tsx` diagnostic, matching the existing `repro-*.ts` convention.

- [ ] **Step 1: Write the script**

Create `packages/memory-strata/test/bench/repro-extract.ts`:

```ts
#!/usr/bin/env tsx
// Live extraction repro (2026-07-29). Runs the REAL Observer + real Haiku over the
// haystack sessions of known-failing single-session-assistant questions and prints
// every extracted fact, so we can see whether assistant-provided content survives
// extraction — WITHOUT a $15 scored run.
//
// A stubbed-LLM unit test proves the plumbing (an 'answer' factType survives parse
// → write → cluster). It cannot prove Haiku COMPLIES with the prompt. This does.
//
// Usage:
//   set -a; source .env.walk; set +a
//   pnpm --filter @ax/memory-strata exec tsx test/bench/repro-extract.ts [questionId...]
//
// Defaults to the three canonical failures from bm25-full-fixed.jsonl:
//   89527b6b  "what color was the scaly body of the Plesiosaur"  → blue
//   1903aded  "what was the 7th job in the list you provided"    → Transcriptionist
//   6ae235be  "processes used at the Lake Charles Refinery"      → distillation/FCC/…

import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runObserver } from '../../src/observer.js';
import { INBOX_DIR } from '../../src/paths.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { selectSamples } from './e2e-select.js';
import { makeAnthropicExtractionLlm } from './e2e-cli.js';
import { DEFAULT_EXTRACTION_MODEL, parseCorpusDate } from './e2e-driver.js';

const DEFAULT_IDS = ['89527b6b', '1903aded', '6ae235be'];

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY required (set -a; source .env.walk; set +a)');
  process.exit(2);
}

const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;
const samples = selectSamples({
  samples: await loadLongMemEvalSSamples(new BenchCache()),
  ids,
  limit: ids.length,
});
if (samples.length === 0) {
  console.error(`No samples matched ids: ${ids.join(', ')}`);
  process.exit(2);
}

const llm = makeAnthropicExtractionLlm(apiKey);
let totalIn = 0;
let totalOut = 0;

for (const sample of samples) {
  console.log(`\n${'='.repeat(72)}\n${sample.question_id} — ${sample.question}`);
  console.log(`GOLD: ${sample.answer}`);
  const ws = await mkdtemp(join(tmpdir(), 'repro-extract-'));
  try {
    for (const [i, session] of sample.haystack_sessions.entries()) {
      const messages = session
        .map((t) => ({ role: t.role, content: t.content }))
        .filter((m) => m.content.trim().length > 0);
      if (messages.length === 0) continue;
      const result = await runObserver({
        messages,
        llmCall: async (input) => {
          const out = await llm(input);
          totalIn += out.usage.inputTokens;
          totalOut += out.usage.outputTokens;
          return out;
        },
        workspaceRoot: ws,
        now: parseCorpusDate(sample.haystack_dates?.[i]) ?? new Date(),
        timeoutMs: 60_000,
        model: DEFAULT_EXTRACTION_MODEL,
      });
      if (result.kind !== 'written') {
        console.log(`  session ${i}: ${result.kind}`);
      }
    }
    // Print every extracted fact. `- ` bodies are what the consolidator promotes.
    const names = await readdir(join(ws, INBOX_DIR)).catch(() => [] as string[]);
    console.log(`  ${names.length} fact(s) extracted:`);
    for (const n of names.sort()) {
      const raw = await readFile(join(ws, INBOX_DIR, n), 'utf8');
      const summary = /^summary:\s*(.*)$/m.exec(raw)?.[1] ?? '(no summary)';
      const factType = /^factType:\s*(.*)$/m.exec(raw)?.[1] ?? '?';
      console.log(`    [${factType}] ${summary}`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// Haiku 4.5: $1/M in, $5/M out.
const dollars = (totalIn * 1) / 1_000_000 + (totalOut * 5) / 1_000_000;
console.log(`\nTokens: ${totalIn} in / ${totalOut} out — ~$${dollars.toFixed(4)}`);
```

- [ ] **Step 2: Capture the BEFORE evidence**

```bash
set -a; source .env.walk; set +a
pnpm --filter @ax/memory-strata exec tsx test/bench/repro-extract.ts \
  2>&1 | tee /tmp/repro-extract-before.txt
```

Expected (this is the bug, confirmed live): facts describe **topics** —
`[general] User is writing a children's book about dinosaurs` — with **no** fact
containing "blue", no ordered job list, and no Lake Charles process list. Cost well
under $0.05.

**If assistant content IS already present in the before-run, STOP and report it.**
That would falsify the brief's root cause and make the rest of this plan the wrong
fix — the failure would be retrieval or answer-side, not extraction.

- [ ] **Step 3: Commit**

```bash
git add packages/memory-strata/test/bench/repro-extract.ts
git commit -m "test(memory-strata bench): live extraction repro for assistant content

Runs the real Observer + real Haiku over known-failing single-session-assistant
transcripts and prints every extracted fact, for a few cents. A stubbed-LLM test
proves plumbing but cannot prove the model complies with the extraction prompt;
this is the actual red/green for the assistant-content lever.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `answer` factType plumbing

Three edits, no new doc category. An `answer` observation routes to the **existing** `docs/general` category so it co-locates with the user-side facts on the same subject — the co-location BM25 retrieval depends on.

**Files:**
- Modify: `packages/memory-strata/src/types.ts` (the `Observation.factType` union, ~line 98; the `MemoryFrontmatter.factType` doc comment, ~line 56)
- Modify: `packages/memory-strata/src/observer.ts` (the `parseObservations` allowlist, ~line 179)
- Modify: `packages/memory-strata/src/cluster.ts` (`normalizeCategory`, ~line 68)
- Modify: `packages/memory-strata/src/__tests__/observer.test.ts`
- Modify: `packages/memory-strata/src/__tests__/cluster.test.ts`
- Modify: `packages/memory-strata/src/__tests__/consolidator.test.ts`
- Modify: `packages/memory-strata/src/__tests__/recent.test.ts`

**Interfaces:**
- Consumes: `Observation` from `src/types.ts`; `ClusterCategory` / `clusterBySubject` from `src/cluster.ts`; `runConsolidation` from `src/consolidator.ts`.
- Produces: `Observation['factType']` gains the `'answer'` member. `docs/` categories are **unchanged** — `ClusterCategory` and `DocCategory` keep their existing values, and `answer` maps onto `'general'`.

- [ ] **Step 1: Write the failing observer test**

Add to `packages/memory-strata/src/__tests__/observer.test.ts` (helpers `llmReturning`, `readInboxFiles`, `TRANSCRIPT`, and `workspaceRoot` already exist at the top of the file):

```ts
describe('assistant-content extraction (factType: answer)', () => {
  it('preserves factType "answer" instead of coercing it to general', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          {
            fact: 'The assistant recommended Roscioli for a romantic Italian dinner in Rome.',
            subject: 'rome-restaurants',
            factType: 'answer',
            confidence: 0.9,
          },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.fm['factType']).toBe('answer');
    expect(files[0]?.fm['summary']).toContain('Roscioli');
  });

  it('still coerces a genuinely unknown factType to general', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          { fact: 'A fact.', subject: 's', factType: 'wat', confidence: 0.9 },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files[0]?.fm['factType']).toBe('general');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: FAIL on the first test — `expected 'general' to be 'answer'` (the allowlist coerces it today). The second test passes already; it's the guard that Step 3 doesn't widen the allowlist to *everything*.

- [ ] **Step 3: Add `answer` to the type union and the parse allowlist**

In `packages/memory-strata/src/types.ts`, replace the `Observation.factType` line:

```ts
  factType: 'entity' | 'preference' | 'decision' | 'episode' | 'answer' | 'general';
```

and extend the `MemoryFrontmatter.factType` doc comment:

```ts
  /**
   * Loose category — entity / preference / decision / episode / answer / general.
   *
   * `answer` (2026-07-29) marks durable content the ASSISTANT provided —
   * recommendations, named entities, specific values, enumerated lists — as
   * opposed to something the user asserted. It is a first-class factType but NOT
   * a doc category: `cluster.ts` maps it onto `general` so an assistant fact
   * lands in the SAME doc as the user-side facts on that subject, which is what
   * lets BM25 find it from the question's topic terms.
   */
  factType?: string;
```

In `packages/memory-strata/src/observer.ts`, replace the allowlist inside `parseObservations`:

```ts
    const factType = (
      ['entity', 'preference', 'decision', 'episode', 'answer', 'general'].includes(factTypeRaw)
        ? factTypeRaw
        : 'general'
    ) as Observation['factType'];
```

- [ ] **Step 4: Run to verify both observer tests pass**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing cluster test**

Add to `packages/memory-strata/src/__tests__/cluster.test.ts`. Use the file's existing inbox-file helper if one is present; otherwise this literal shape works (`clusterBySubject` reads only `frontmatter.subject` and `frontmatter.factType`):

```ts
describe('answer factType routing (2026-07-29)', () => {
  it('routes an answer observation to the general doc category', () => {
    const clusters = clusterBySubject([
      {
        path: 'permanent/memory/inbox/a.md',
        body: 'The assistant recommended Roscioli.',
        frontmatter: {
          id: 'a',
          type: 'inbox/observation',
          created: '2026-07-29T00:00:00.000Z',
          confidence: 0.9,
          pinned: false,
          summary: 'The assistant recommended Roscioli.',
          subject: 'rome-restaurants',
          factType: 'answer',
        },
      },
    ] as never);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.category).toBe('general');
    expect(clusters[0]?.slug).toBe('rome-restaurants');
  });

  it('lets a majority user factType win over a single answer fact', () => {
    const mk = (id: string, factType: string) => ({
      path: `permanent/memory/inbox/${id}.md`,
      body: 'b',
      frontmatter: {
        id,
        type: 'inbox/observation',
        created: '2026-07-29T00:00:00.000Z',
        confidence: 0.9,
        pinned: false,
        summary: 's',
        subject: 'rome-restaurants',
        factType,
      },
    });
    const clusters = clusterBySubject([
      mk('a', 'answer'),
      mk('b', 'entity'),
      mk('c', 'entity'),
    ] as never);
    expect(clusters[0]?.category).toBe('entity');
  });
});
```

- [ ] **Step 6: Run to verify it fails for the right reason**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/cluster.test.ts`
Expected: **PASS** — because `normalizeCategory`'s unknown-value fallback already yields `'general'`.

This is deliberate. The tests lock in the routing so Step 7's *explicit* mapping is a
refactor with a safety net, not a behavior change. Record in the commit that these
passed before the mapping was made explicit.

- [ ] **Step 7: Make the mapping explicit in `cluster.ts`**

Relying on the unknown-value fallback would mean the routing decision is invisible at the call site and a future taxonomy edit could silently reroute it. Replace `normalizeCategory`:

```ts
/**
 * factTypes that are NOT doc categories, mapped to the category they live in.
 *
 * `answer` (2026-07-29, assistant-content extraction) is a first-class factType —
 * it marks content the ASSISTANT provided — but it deliberately has NO doc
 * category of its own. It shares `general` with the user-side facts on the same
 * subject, so both land in ONE doc: splitting them would break the co-location
 * that lets BM25 match an assistant fact from the question's topic terms.
 *
 * Explicit rather than leaning on the unknown-value fallback below (which yields
 * the same `general` today) so the routing is legible here and a future taxonomy
 * edit can't silently reroute it. This is the case cluster.ts's header
 * anticipated: "a new inbox factType that maps to an existing doc category".
 */
const FACT_TYPE_TO_CATEGORY: ReadonlyMap<string, ClusterCategory> = new Map([
  ['answer', 'general'],
]);

function normalizeCategory(raw: string | undefined): ClusterCategory {
  const candidate = raw ?? 'general';
  const mapped = FACT_TYPE_TO_CATEGORY.get(candidate);
  if (mapped !== undefined) return mapped;
  return KNOWN_CATEGORIES.has(candidate as ClusterCategory)
    ? (candidate as ClusterCategory)
    : 'general';
}
```

- [ ] **Step 8: Run the cluster tests again**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/cluster.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 9: Write the co-location + recent.md tests**

These prove the two assumptions the design leans on. Add to `packages/memory-strata/src/__tests__/consolidator.test.ts`, following that file's existing fixture helpers for writing inbox files (reuse whatever `writeInboxObservation`-style helper the file already defines rather than inventing one):

```ts
it('promotes an answer fact into the SAME general doc as the user fact on that subject', async () => {
  // Co-location is the retrieval assumption: BM25 must find the assistant's
  // content from the question's topic terms, which live on the user-side fact.
  await writeObs({ summary: 'User is planning a trip to Rome.', subject: 'rome', factType: 'general', confidence: 0.9 });
  await writeObs({
    summary: 'The assistant recommended Roscioli for a romantic Italian dinner in Rome.',
    subject: 'rome',
    factType: 'answer',
    confidence: 0.9,
  });

  const result = await runConsolidation({ workspaceRoot, now: new Date('2026-07-29T12:00:00.000Z') });

  expect(result.promoted).toBe(2);
  const doc = await readFile(join(workspaceRoot, 'permanent/memory/docs/general/rome.md'), 'utf8');
  expect(doc).toContain('Roscioli');
  expect(doc).toContain('planning a trip to Rome');
});
```

Add to `packages/memory-strata/src/__tests__/recent.test.ts`:

```ts
it('keeps answer observations out of Open Threads', async () => {
  // recent.md is ALWAYS injected; assistant content must not crowd the hot tier.
  await writeObs({ summary: 'The assistant listed 10 work-from-home jobs.', subject: 'jobs', factType: 'answer', confidence: 0.9 });

  await regenerateRecent({ workspaceRoot, now: new Date('2026-07-29T12:00:00.000Z') });

  const recent = await readFile(join(workspaceRoot, 'permanent/memory/system/recent.md'), 'utf8');
  expect(recent).not.toContain('work-from-home');
});
```

- [ ] **Step 10: Run both, then the full suite**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/consolidator.test.ts src/__tests__/recent.test.ts`
Expected: PASS (both assert existing behavior holds for the new factType).

Run: `pnpm --filter @ax/memory-strata test`
Expected: PASS, no regressions.

- [ ] **Step 11: Commit**

```bash
git add packages/memory-strata/src/types.ts \
        packages/memory-strata/src/observer.ts \
        packages/memory-strata/src/cluster.ts \
        packages/memory-strata/src/__tests__/observer.test.ts \
        packages/memory-strata/src/__tests__/cluster.test.ts \
        packages/memory-strata/src/__tests__/consolidator.test.ts \
        packages/memory-strata/src/__tests__/recent.test.ts
git commit -m "feat(memory-strata): 'answer' factType for assistant-provided content

Adds a first-class factType marking content the ASSISTANT provided, mapped to the
EXISTING docs/general category rather than a new one — an assistant fact must land
in the SAME doc as the user-side facts on that subject, or BM25 can't match it from
the question's topic terms.

The cluster.ts mapping is explicit rather than leaning on the unknown-value
fallback (same result today) so the routing is legible and a future taxonomy edit
can't silently reroute it. The cluster tests passed before the mapping was made
explicit — they lock the routing in so the refactor has a safety net.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The extraction prompt

The actual lever. Everything before this was scaffolding.

**Files:**
- Modify: `packages/memory-strata/src/observer.ts` (`EXTRACTION_PROMPT_SYSTEM`, ~line 66)
- Modify: `packages/memory-strata/src/__tests__/observer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EXTRACTION_PROMPT_SYSTEM` is exported (it is currently a module-private `const`; export it so the contract test can assert against it without duplicating the string).

- [ ] **Step 1: Write the failing prompt-contract test**

A weak but honest guard: it can't prove Haiku complies (Task 2's repro does that), but it stops a future edit from silently reverting the lever. Add to `packages/memory-strata/src/__tests__/observer.test.ts`:

```ts
describe('EXTRACTION_PROMPT_SYSTEM — assistant-content contract', () => {
  it('instructs capture of assistant-provided content with attribution', () => {
    // Guard against a future prompt edit silently reverting the lever. The
    // BEHAVIORAL proof is test/bench/repro-extract.ts (real Haiku, a few cents).
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/assistant/i);
    expect(EXTRACTION_PROMPT_SYSTEM).toContain('answer');
    expect(EXTRACTION_PROMPT_SYSTEM).toContain('The assistant');
  });

  it('bars speculation and preserves list order', () => {
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/speculat|hedge|guess/i);
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/order|numbered/i);
  });
});
```

Add `EXTRACTION_PROMPT_SYSTEM` to the existing import at the top of the test file:

```ts
import { runObserver, EXTRACTION_PROMPT_SYSTEM } from '../observer.js';
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: FAIL — `EXTRACTION_PROMPT_SYSTEM` is not exported (TS/import error).

- [ ] **Step 3: Rewrite the prompt**

In `packages/memory-strata/src/observer.ts`, replace the whole `EXTRACTION_PROMPT_SYSTEM` declaration (note the added `export`):

```ts
// Exported so a test can assert the assistant-content contract survives future
// edits. The BEHAVIORAL check — does Haiku actually comply? — is
// test/bench/repro-extract.ts against real transcripts; a stub can't prove it.
export const EXTRACTION_PROMPT_SYSTEM = `\
You extract durable, atomic facts from chat transcripts for a memory system. \
A "durable" fact is one likely to still matter a week from now. Skip small talk, \
greetings, and ephemeral acknowledgments. Each fact must be a single sentence. \
Assign a subject (the entity the fact is about, or "general"), a factType, and a \
confidence between 0 and 1.

Extract TWO kinds of fact.

1. USER facts — what the user told you: preferences, decisions, deadlines, \
identities, project state. factType: entity, preference, decision, episode, or general.

2. ASSISTANT facts — substantive content YOU (the assistant) provided that the user \
may later ask you to recall: recommendations, named places/titles/products, specific \
values and numbers, and lists you gave them. factType: answer.

Rules for ASSISTANT facts:
- Attribute them. Write from the assistant's side, starting with "The assistant" \
(recommended / listed / stated / explained). Never merge what the assistant said \
with what the user said — recording the wrong speaker is worse than recording nothing.
- Keep a list whole and in order. Store a numbered or bulleted list the assistant \
gave as ONE fact that preserves the original order and item count, e.g. "The \
assistant listed 10 work-from-home jobs for seniors: 1. Virtual assistant, 2. \
Bookkeeper, ... 7. Transcriptionist, ...". Do NOT split it into one fact per item — \
the user may ask which item was 7th. If a list runs longer than 10 items, record the \
first 10 and state the total count.
- Keep the specifics. The point is the detail — the name, the number, the color, the \
process — not the topic. "The assistant discussed dinosaur illustrations" is useless; \
"The assistant said the Plesiosaur in the image had a blue scaly body" is the fact.
- No speculation. Skip anything the assistant hedged, guessed at, or flagged as \
uncertain ("might be", "possibly", "I'm not sure"). Memory must not turn a guess into \
a fact.
- No echoes. If the assistant merely repeated something the user said, record it once, \
as a USER fact.
- Be selective: at most 5 assistant facts per transcript, each under 400 characters. \
Skip generic advice, pleasantries, and anything the user could trivially re-derive.

Give an assistant fact the SAME subject as the related user fact (the topic they were \
talking about), so both are stored together.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{ "fact": string, "subject": string, "factType": string, "confidence": number }]

If nothing durable is in the transcript, respond with [].`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + build**

Run: `pnpm --filter @ax/memory-strata test`
Expected: PASS.

Run: `pnpm build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/src/observer.ts \
        packages/memory-strata/src/__tests__/observer.test.ts
git commit -m "feat(memory-strata): extract assistant-provided content

The extraction prompt was wholly user-centric, so the model read the assistant's
answer and dutifully wrote 'User is writing a children's book about dinosaurs',
discarding 'the Plesiosaur had a blue scaly body'. That is 35 of 40 failures on
LongMemEval-S single-session-assistant (25.9%) and 49% of ALL false refusals.

Four rules, each from an observed failure: attribute assistant facts explicitly
(misattribution is worse than silence); keep enumerated lists whole and ordered
(gold answers ask for 'the 7th job'); keep the specific value, not the topic; and
skip anything the assistant hedged — memory must not launder a guess into a fact.
Volume is capped at 5 facts/transcript, 400 chars each.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Truncation safety net

**A risk this change creates, not one it inherits.** `MAX_EXTRACTION_TOKENS` is 1024, shared by every fact in a session. When output hits the cap the JSON array is cut mid-object, `parseObservations` returns `null`, and **every fact from that session is lost — user facts included**. Assistant content is far more verbose, so Task 4 pushes sessions toward that cliff. Left alone it is a silent regression channel for the five question types this lever isn't even targeting.

**Files:**
- Modify: `packages/memory-strata/src/observer.ts` (`MAX_EXTRACTION_TOKENS` ~line 80; `RunObserverResult` ~line 56; `parseObservations` ~line 151; `runObserver` ~line 117)
- Modify: `packages/memory-strata/src/plugin.ts` (the observer audit log, ~line 573)
- Modify: `packages/memory-strata/src/__tests__/observer.test.ts`

**Interfaces:**
- Consumes: `RunObserverResult` from `src/observer.ts`.
- Produces: `parseObservations` returns `{ observations: Observation[]; salvaged: boolean } | null` (was `Observation[] | null`). The `written` variant of `RunObserverResult` gains an optional `salvagedFromTruncation?: true`. `parseObservations` is module-private — only `runObserver` calls it — so the signature change is contained.

- [ ] **Step 1: Write the failing salvage tests**

Add to `packages/memory-strata/src/__tests__/observer.test.ts`:

```ts
describe('truncated-extraction salvage', () => {
  // A cut-off array currently loses EVERY fact in the session, including user
  // facts — assistant content just makes hitting the cap likelier.
  const TRUNCATED = `[
    {"fact":"User prefers React over Vue.","subject":"frontend","factType":"preference","confidence":0.9},
    {"fact":"The project ships next Friday.","subject":"project","factType":"episode","confidence":0.85},
    {"fact":"The assistant listed 10 work-from-home jobs for seniors: 1. Virtual assis`;

  it('keeps the complete objects when the array is cut mid-object', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(TRUNCATED),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.written).toHaveLength(2);
    expect(result.salvagedFromTruncation).toBe(true);
    const files = await readInboxFiles(workspaceRoot);
    expect(files.map((f) => f.fm['summary'])).toEqual([
      'User prefers React over Vue.',
      'The project ships next Friday.',
    ]);
  });

  it('does not flag a well-formed response as salvaged', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          { fact: 'User prefers React.', subject: 'frontend', factType: 'preference', confidence: 0.9 },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.salvagedFromTruncation).toBeUndefined();
  });

  it('still reports parse-error when nothing can be salvaged', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning('I am afraid I cannot help with that.'),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('parse-error');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: FAIL — first test gets `parse-error`, not `written` (today a truncated array returns `null`). The third test passes already and must keep passing.

- [ ] **Step 3: Raise the token cap**

In `packages/memory-strata/src/observer.ts`:

```ts
// Raised 1024 → 2048 (2026-07-29) alongside assistant-content extraction. A
// session now emits both user facts and assistant facts — and an assistant fact
// can be a whole enumerated list in one sentence — so 1024 puts real sessions on
// the truncation cliff, where a cut-off array used to lose EVERY fact in the
// session. Cost is only actually-emitted output tokens (Haiku, $5/M out).
const MAX_EXTRACTION_TOKENS = 2048;
```

- [ ] **Step 4: Implement the salvage parser**

In `packages/memory-strata/src/observer.ts`, add `salvagedFromTruncation` to the `written` variant of `RunObserverResult`:

```ts
  | {
      kind: 'written';
      written: ObservationWritten[];
      rejected: RejectedObservation[];
      /**
       * Set when the model's JSON array was truncated (max_tokens) and we kept
       * the complete objects instead of losing the whole batch. Surfaced so a
       * production truncation shows up as a log line rather than as a silent
       * quality drop — see plugin.ts's observer audit log.
       */
      salvagedFromTruncation?: true;
    };
```

Replace `parseObservations` and add the salvage helper:

```ts
interface ParsedObservations {
  observations: Observation[];
  /** True when the input was a truncated array and complete objects were recovered. */
  salvaged: boolean;
}

function parseObservations(text: string): ParsedObservations | null {
  // The LLM should return raw JSON. Be defensive, in three escalating steps:
  //   1. strict JSON.parse
  //   2. hunt for a top-level array (model wrapped it in prose)
  //   3. salvage complete objects from a TRUNCATED array (max_tokens cut it
  //      mid-object) — otherwise one over-long extraction loses every fact in
  //      the session, user facts included.
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      const salvaged = salvageTruncatedArray(trimmed);
      if (salvaged === null) return null;
      const observations = coerceObservations(salvaged);
      return observations.length > 0 ? { observations, salvaged: true } : null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return { observations: coerceObservations(parsed), salvaged: false };
}

/**
 * Recover the complete top-level objects from a JSON array cut off mid-object.
 *
 * Scans for balanced `{…}` spans, tracking string state so a brace inside a fact
 * string (or an escaped quote) doesn't throw off the depth count. The trailing
 * partial object is simply never closed, so it's dropped. Returns null when no
 * complete object survives.
 */
function salvageTruncatedArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objStart !== -1) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {
          // A malformed complete-looking span: skip it, keep scanning.
        }
        objStart = -1;
      }
    }
  }
  return out.length > 0 ? out : null;
}

/** Coerce a parsed array into Observations, defensively (unchanged semantics). */
function coerceObservations(parsed: unknown[]): Observation[] {
  const out: Observation[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const fact = typeof r['fact'] === 'string' ? (r['fact'] as string).trim() : '';
    if (fact === '') continue;
    const subject = typeof r['subject'] === 'string' ? (r['subject'] as string) : 'general';
    const factTypeRaw = typeof r['factType'] === 'string' ? (r['factType'] as string) : 'general';
    const factType = (
      ['entity', 'preference', 'decision', 'episode', 'answer', 'general'].includes(factTypeRaw)
        ? factTypeRaw
        : 'general'
    ) as Observation['factType'];
    const confRaw = r['confidence'];
    const confidence =
      typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? Math.max(0, Math.min(1, confRaw))
        : 0.5;
    out.push({ fact, subject, factType, confidence });
  }
  return out;
}
```

Update the two call sites in `runObserver`:

```ts
  const parsed = parseObservations(raced.text);
  if (parsed === null) {
    return { kind: 'parse-error', rawLength: raced.text.length };
  }
  const candidates = parsed.observations;
```

and the return statement:

```ts
  return {
    kind: 'written',
    written,
    rejected,
    ...(parsed.salvaged ? { salvagedFromTruncation: true as const } : {}),
  };
```

- [ ] **Step 5: Run to verify the salvage tests pass**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts`
Expected: PASS (all three, plus the earlier suites).

- [ ] **Step 6: Surface it in the plugin's audit log**

No silent truncation: if this fires in production we learn it from a log line, not a score drop. In `packages/memory-strata/src/plugin.ts`, extend the existing `memory_strata_observer_run` log (~line 575):

```ts
        ctx.logger.info('memory_strata_observer_run', {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          written: result.written.length,
          rejected: result.rejected.length,
          rejectedKinds: result.rejected.flatMap((r) => r.kinds),
          // Truncated extraction: complete facts were kept, the tail was lost.
          // Never silent — a persistent signal here means MAX_EXTRACTION_TOKENS
          // needs another raise.
          ...(result.salvagedFromTruncation === true ? { salvagedFromTruncation: true } : {}),
        });
```

- [ ] **Step 7: Run the full suite + build**

Run: `pnpm --filter @ax/memory-strata test`
Expected: PASS.

Run: `pnpm build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/memory-strata/src/observer.ts \
        packages/memory-strata/src/plugin.ts \
        packages/memory-strata/src/__tests__/observer.test.ts
git commit -m "fix(memory-strata): salvage truncated extractions instead of losing the batch

MAX_EXTRACTION_TOKENS is shared by every fact in a session. On truncation the
JSON array is cut mid-object, parseObservations returned null, and EVERY fact
from that session was lost — user facts included. Assistant-content extraction
makes hitting the cap likelier, so this would have been a silent regression
channel for the five question types that lever isn't even targeting.

Raise 1024 -> 2048 and recover the complete objects from a cut-off array
(brace-depth scan that tracks string state, so a brace inside a fact string
doesn't corrupt the count). Still parse-error when nothing survives. The plugin
logs salvagedFromTruncation so a production truncation is a log line, not a
silent quality drop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Security gates + PR-B

Assistant output is model output = **untrusted content**. Storing more of it in `docs/` means more untrusted text re-injected into a system prompt each turn — the exfiltration channel invariant 5 exists to close. Both gates are factType-agnostic and already cover the new path; these tests make that a *guarantee* rather than an accident, so a future refactor can't route assistant content around them.

**Files:**
- Modify: `packages/memory-strata/src/__tests__/observer.test.ts` (I7, write-time)
- Modify: `packages/memory-strata/src/__tests__/promotion.test.ts` (I11, promote-time)

**Interfaces:**
- Consumes: `runObserver` (Task 3/4/5), `decidePromotion` from `src/promotion.js`, `filterSensitive` from `src/sensitive-gate.js`.
- Produces: nothing importable.

- [ ] **Step 1: Invoke the security-checklist skill**

Required by CLAUDE.md for changes touching untrusted content. Walk all three threat models and keep the output — it becomes the PR security note in Step 6.

Expected shape of the answers:
- **Sandbox escape:** N/A — no new filesystem paths, no process spawn, no network reach. Every edit is in-process inside an existing plugin.
- **Prompt injection:** the real one. More assistant-authored text is stored and re-injected. Mitigations: unchanged I7/I11 gates (tested below), plus the prompt's attribution rule storing facts as third-person *descriptions* ("The assistant listed …") rather than standalone imperative text, and the 400-char/5-fact caps bounding how much can land per session. State plainly that this is a **reduction, not an elimination**.
- **Supply chain:** N/A — no new dependencies.

- [ ] **Step 2: Write the failing I7 write-time test**

Add to `packages/memory-strata/src/__tests__/observer.test.ts`:

```ts
describe('sensitive gate covers assistant-authored facts (I7)', () => {
  it('rejects an answer fact carrying a credential before it reaches the inbox', async () => {
    // Invariant 5: assistant output is untrusted model output. The write-time
    // gate is factType-agnostic and MUST stay that way — assistant content is
    // exactly the path where an echoed secret could otherwise be persisted.
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          {
            fact: 'The assistant said the API key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.',
            subject: 'setup',
            factType: 'answer',
            confidence: 0.95,
          },
          {
            fact: 'The assistant recommended Roscioli for dinner in Rome.',
            subject: 'rome',
            factType: 'answer',
            confidence: 0.9,
          },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.rejected).toHaveLength(1);
    expect(result.written).toHaveLength(1);
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.fm['summary']).toContain('Roscioli');
  });
});
```

**Before running:** confirm the credential literal actually trips `filterSensitive` — check the patterns in `src/sensitive-gate.ts` and use one its regexes match (the `sk-ant-` shape above is the expected match; if the gate keys on a different pattern, use that one instead). A test that passes because *nothing* was extracted would be worthless.

- [ ] **Step 3: Write the failing I11 promote-time test**

Add to `packages/memory-strata/src/__tests__/promotion.test.ts`, following that file's existing `InboxFile` fixture helper:

```ts
it('quarantines an assistant-authored fact that carries a credential (I11)', () => {
  // Defense-in-depth: even if the write-time gate is bypassed (a direct inbox
  // write, or a future code path that forgets to gate), assistant content must
  // not graduate to docs/, where it is re-injected into the system prompt.
  const decision = decidePromotion(
    mkInboxFile({
      summary: 'The assistant said the API key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.',
      factType: 'answer',
      confidence: 0.95,
    }),
  );

  expect(decision.promote).toBe(false);
  if (decision.promote) throw new Error('unreachable');
  expect(decision.reason).toBe('sensitive');
});
```

- [ ] **Step 4: Run both to verify they pass**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/observer.test.ts src/__tests__/promotion.test.ts`
Expected: PASS — both gates are already factType-agnostic, so these lock in existing behavior rather than driving new code. **If either fails, stop** — that means assistant content bypasses a gate and is a blocker, not a test-tuning problem.

- [ ] **Step 5: Full gate**

Run: `pnpm --filter @ax/memory-strata test`
Run: `pnpm build`
Run: `pnpm lint` (scope to changed files if stale `.worktrees/` copies produce unrelated noise)
Expected: all clean.

- [ ] **Step 6: Commit and open PR-B**

```bash
git add packages/memory-strata/src/__tests__/observer.test.ts \
        packages/memory-strata/src/__tests__/promotion.test.ts
git commit -m "test(memory-strata): assistant facts stay behind both sensitive gates

Invariant 5: assistant output is untrusted model output, and this change stores
more of it in docs/ — which is re-injected into the system prompt each turn.
Both gates (I7 write-time, I11 promote-time) are factType-agnostic and already
cover the new path; these tests make that a guarantee instead of an accident.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

PR description must include: the boundary-review note (**not required** — no hook signature changes, no new hooks, no IPC surface; all edits internal to `@ax/memory-strata`), the security note from Step 1, and the measurement plan with the **≥35/54** gate stated up front so the result can't be quietly reframed after the fact.

---

### Task 7: Targeted measurement (54 assistant questions, ~$15)

The gate. Everything so far is unvalidated until this runs.

**Files:** none modified. This task produces evidence.

- [ ] **Step 1: Re-run the live extraction repro (the cheap check first)**

```bash
git checkout fix/bench-final-session-inbox-stranding
pnpm --filter @ax/memory-strata build   # bench imports via dist/ — stale dist = wrong result
set -a; source .env.walk; set +a
pnpm --filter @ax/memory-strata exec tsx test/bench/repro-extract.ts \
  2>&1 | tee /tmp/repro-extract-after.txt
diff /tmp/repro-extract-before.txt /tmp/repro-extract-after.txt
```

Expected: `[answer]` facts now appear, containing **blue** (Plesiosaur), an **ordered job list including a 7th item**, and the **Lake Charles process list**.

**Gate:** if the specific details are still missing, do NOT proceed to the $15 run — iterate on the prompt (Task 4) at ~$0.05/attempt. This is the whole reason the repro exists.

- [ ] **Step 2: Run the 54 assistant questions**

```bash
unset XAI_API_KEY   # BM25 path — the default/winning path. Set = orchestrator.
pnpm --filter @ax/memory-strata bench --mode e2e \
  --types single-session-assistant --full --cap 200 \
  --resume assistant-extraction-v1
```

Expected: ~40min, ~$15, 54 rows in `~/.cache/ax-memory-bench/longmemeval-s-e2e/assistant-extraction-v1.jsonl`.

Copy the report aside immediately — the date-stamped path clobbers same-day:

```bash
cp docs/plans/$(date +%F)-memory-strata-e2e-report.md \
   /tmp/assistant-extraction-v1-report.md
```

- [ ] **Step 3: Score against the baseline**

```bash
cd ~/.cache/ax-memory-bench/longmemeval-s-e2e && python3 -c "
import json
from collections import Counter
def load(p): return [json.loads(l) for l in open(p)]
base = [r for r in load('bm25-full-fixed.jsonl') if r['questionType']=='single-session-assistant']
new  = load('assistant-extraction-v1.jsonl')
for label, rows in (('BEFORE', base), ('AFTER', new)):
    c = Counter(r['verdict'] for r in rows)
    ok = c['correct'] + c['abstained-correctly']
    print(f\"{label}: {ok}/{len(rows)} = {100*ok/len(rows):.1f}%  {dict(c)}\")
bydict = {r['questionId']: r for r in base}
flips = [(r['questionId'], bydict[r['questionId']]['verdict'], r['verdict'])
         for r in new if r['questionId'] in bydict
         and bydict[r['questionId']]['verdict'] != r['verdict']]
print(f'\nflips: {len(flips)}')
for qid, b, a in flips: print(f'  {qid}: {b} -> {a}')
"
```

**Gate: ≥35/54 (≈65%).** Baseline is 14/54 (25.9%).

- [ ] **Step 4: Branch on the result**

- **Pass (≥35/54)** → proceed to Task 8.
- **Miss** → do **not** spend the $143. Read the `agentAnswer` text of the still-failing rows and classify: (a) content absent from memory → prompt problem, iterate Task 4 and re-run Step 2 at $15; (b) content present but the agent abstained → pull the reserve lever (`memory_search` descriptor wording, design § "Iteration levers held in reserve"); (c) content present and answered but judged wrong → answer-side, out of scope for this lever — record and stop.
- **Any regression in `abstained-correctly` rows** (an unanswerable question now answered) is a correct-refusal warning even at this sample size — note it, since Task 8 measures it properly.

- [ ] **Step 5: Record the result**

Append a dated section to `docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md` with the before/after table, the flip list, and the spend. **Record a miss just as fully as a win** — a negative result here is what routes the next session.

---

### Task 8: Full n=500 confirmation (~$143) — gated on Task 7

Only runs if Task 7 cleared ≥35/54. This measures what the brief actually cares about: that the lever lifts *overall* without regressing the other five types or correct-refusal.

**Files:** none modified until Step 4.

- [ ] **Step 1: Run the full corpus**

```bash
git checkout fix/bench-final-session-inbox-stranding
pnpm --filter @ax/memory-strata build
set -a; source .env.walk; set +a
unset XAI_API_KEY
pnpm --filter @ax/memory-strata bench --mode e2e --full --cap 200 \
  --resume bm25-full-assistant
```

Expected: ~6h, ~$143. Resumable — re-run the identical command after an interruption and it skips scored rows.

- [ ] **Step 2: Compare per-type and check the guardrails**

```bash
cd ~/.cache/ax-memory-bench/longmemeval-s-e2e && python3 -c "
import json
from collections import defaultdict
def load(p): return [json.loads(l) for l in open(p)]
def table(rows):
    agg = defaultdict(lambda: [0,0]); ref = [0,0]
    for r in rows:
        ok = r['verdict'] in ('correct','abstained-correctly')
        t = agg[r['questionType']]; t[0] += ok; t[1] += 1
        if r['unanswerable']: ref[0] += ok; ref[1] += 1
    return agg, ref
b, bref = table(load('bm25-full-fixed.jsonl'))
a, aref = table(load('bm25-full-assistant.jsonl'))
print(f\"{'type':32} {'before':>14} {'after':>14} {'delta':>8}\")
for t in sorted(set(b) | set(a)):
    bo, bn = b.get(t,[0,0]); ao, an = a.get(t,[0,0])
    bp = 100*bo/bn if bn else 0; ap = 100*ao/an if an else 0
    print(f'{t:32} {bo:3}/{bn:3} {bp:5.1f}% {ao:3}/{an:3} {ap:5.1f}% {ap-bp:+7.1f}')
for label,(o,n) in (('BEFORE',(sum(v[0] for v in b.values()), sum(v[1] for v in b.values()))),
                    ('AFTER', (sum(v[0] for v in a.values()), sum(v[1] for v in a.values())))):
    print(f'{label} overall: {o}/{n} = {100*o/n:.1f}%')
print(f'correct-refusal: {bref[0]}/{bref[1]} -> {aref[0]}/{aref[1]}  (gate >=83%)')
"
```

**Guardrails (from the brief):**
- **correct-refusal ≥83%** (before: 88.0%, 22/25). More stored content = more chances to answer an unanswerable question.
- **multi-session ≥65%** (before: 67.7%) — the standing gate.
- **No per-type regression** beyond noise. At n≈50+, ±1 question ≈ 2pt; do not call a 1-question move a regression, and do not call a 1-question gain a win.

- [ ] **Step 3: If a guardrail trips**

Pull the matching reserve lever from the design (§ "Iteration levers held in reserve") rather than reverting wholesale:
- correct-refusal down → raise the promotion threshold for `answer` (`promotion.ts`), tightening what gets stored.
- another type down + `rollup/*` noise in the failures → exclude `answer`-dominated docs from `ENUMERABLE_CATEGORIES`.
- Re-measure the affected type with `--types` at $15, not a second full run.

- [ ] **Step 4: Write up the result and update memory**

Append the full per-type table, the overall delta, the correct-refusal number, and the spend to `docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md`.

Update `.claude/memory/` (project-local, git-tracked — commit it, per CLAUDE.md):
- `context.md` — the new per-type baseline and which JSONL is now the reference run.
- `decisions.md` — `answer` factType maps to `docs/general` and *why* (co-location for BM25); reserve levers left unbuilt.
- `mistakes.md` — the measurement trap (type-block ordering makes `--sample 100` blind to assistant questions) and the truncation cliff, if it fired.

Update the user-level memory index at `/Users/vpulim/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/` with a `project_*` note for the lever's outcome, linked from `MEMORY.md`.

```bash
git add .claude/memory docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md
git commit -m "docs(memory-strata): assistant-content extraction results (n=500)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage** — every design section maps to a task: Component 1 → Task 1; Component 2 → Task 4 (+ Task 2's live check); Component 3 → Task 3; Component 4 → Task 5; Component 5 → Task 6; Testing → Tasks 3–6 (unit) + Task 2 (behavioral); Validation plan → Tasks 7–8; delivery order → Task order (PR-A = Task 1, PR-B = Tasks 3–6).

**Type consistency** — `selectSamples` / `parseCsvFlag` are named identically in Tasks 1 and 2. `parseObservations`'s changed return type (`ParsedObservations | null`) is consumed only inside `runObserver`, both call sites updated in Task 5 Step 4. `salvagedFromTruncation` is spelled identically in `observer.ts`, `plugin.ts`, and the tests. `EXTRACTION_PROMPT_SYSTEM` becomes exported in Task 4 Step 3, which is the import the Task 4 Step 1 test needs.

**Known soft spots, called out rather than papered over:**
- Task 3 Steps 5–6 and Task 6 Step 4 write tests that **pass before the implementation**. That's honest — they lock in existing behavior (the unknown-value fallback; the factType-agnostic gates) so a later refactor can't break it. Each says so explicitly, and Task 6 Step 4 says a failure there is a blocker, not a test to tune.
- The exact fixture-helper names in `cluster.test.ts`, `consolidator.test.ts`, `recent.test.ts`, and `promotion.test.ts` (`writeObs`, `mkInboxFile`) are placeholders for whatever those files already define — reuse the existing helper rather than adding a parallel one.
- Task 6 Step 2's credential literal must be verified against `src/sensitive-gate.ts`'s actual patterns before the test is trusted.
