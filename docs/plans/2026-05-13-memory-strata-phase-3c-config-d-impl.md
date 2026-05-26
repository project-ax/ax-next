# Phase 3C — Config D (Retrieval Orchestrator) + abstention metric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise the c137-style structured-retrieval configuration (D) on LongMemEval-S with an abstention-aware judge, and (optionally) a BM25 fallback variant (E), against the same 100-sample slice used in PR #66. Produce a dated report and annotate the design doc with the binding outcome.

**Architecture:**
- **Map generator** (`bench/map.ts`): walks `corpus.memoryTree`, groups by `doc.category`, emits one line per doc using the existing `doc.summary`. Cached on disk so re-runs are free. (No LLM rewrite at first — the LongMemEval-S loader already extracts a first-sentence summary; if results are borderline, an LLM-rewrite is the obvious follow-up.)
- **Retrieval Orchestrator** (`bench/orchestrator.ts`): per question, a cheap Haiku call receives `(map, query)` and emits XML ops (`<load doc="…"/>`, `<fts query="…"/>`, `<followup needed="true"/>`). A regex-based parser converts ops to typed objects; a runner resolves loads (against `corpus.memoryTree`) and FTS ops (against the BM25 plugin from Config A) into `RetrievedDoc[]`.
- **Config D** (`configs/d-map.ts`): build = generate map; retrieve = orchestrate → resolve → return retrieved docs. Records but does not act on `followupNeeded`.
- **Config E** (`configs/e-map-fts.ts`): D plus an automatic BM25 fallback when orchestrator emits `followup needed="true"` OR returns zero ops.
- **Abstention scoring**: LongMemEval-S loader flags questions with `_abs` suffix in `question_id` as `metadata.unanswerable = true`. `Verdict` expands to 5-way (`correct`, `incorrect`, `abstained-correctly`, `abstained-incorrectly`, `uncertain`). The judge prompt gets a new "Unanswerable" line. The report adds a dedicated abstention table.

**Tech Stack:** Existing bench harness — TypeScript, vitest, Anthropic SDK (Haiku-class for orchestrator), `@ax/memory-strata-index-sqlite` BM25 plugin. No new runtime deps.

**Scope guardrails (from issue #67):**
- We do NOT wire the Retrieval Orchestrator into any production plugin in this PR — this is still a spike. If D wins, a separate phase wires it into a real plugin.
- We do NOT add cross-corpus runs (LoCoMo / internal). That's blocked on per-question concurrency in the bench loop, tracked separately.
- Config E is optional but cheap to add once D exists; build it.

---

## File Structure

**Create:**
- `packages/memory-strata/test/bench/map.ts` — map generator + cache wrapper
- `packages/memory-strata/test/bench/orchestrator.ts` — XML emitter (LLM call), parser, runner
- `packages/memory-strata/test/bench/configs/d-map.ts` — Config D driver
- `packages/memory-strata/test/bench/configs/e-map-fts.ts` — Config E driver
- `packages/memory-strata/test/bench/__tests__/map.test.ts`
- `packages/memory-strata/test/bench/__tests__/orchestrator.test.ts`
- `packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts`

**Modify:**
- `packages/memory-strata/test/bench/types.ts` — extend `ConfigName`, `Verdict`, add `orchestratorTokens` / `followupNeeded` to `RetrievalResult`
- `packages/memory-strata/test/bench/corpora/longmemeval-s.ts` — flag `_abs` questions
- `packages/memory-strata/test/bench/judge.ts` — abstention-aware judge prompt + parser
- `packages/memory-strata/test/bench/report.ts` — abstention table + Config D/E labels
- `packages/memory-strata/test/bench/cli.ts` — wire D/E factories + cost meter for Haiku
- `packages/memory-strata/test/bench/__tests__/corpora.test.ts` — abstention metadata test
- `packages/memory-strata/test/bench/__tests__/judge.test.ts` — abstention verdict cases
- `packages/memory-strata/test/bench/__tests__/report.test.ts` — abstention table coverage
- `docs/plans/memory-strata-design.md` — Decision Records entry; Level 3 line annotation
- `docs/plans/2026-05-DD-memory-strata-phase-3c-config-d-report.md` — new dated report (written from the bench run)

---

## Task 1: Tag LongMemEval-S abstention questions

**Files:**
- Modify: `packages/memory-strata/test/bench/corpora/longmemeval-s.ts`
- Test: `packages/memory-strata/test/bench/__tests__/corpora.test.ts`

LongMemEval-S marks unanswerable questions by suffixing `question_id` with `_abs`. Their gold answer starts with `"You did not mention this information."`. We surface this as `metadata.unanswerable: true` so downstream code (judge, report) can branch.

- [ ] **Step 1: Write the failing test**

Append to `packages/memory-strata/test/bench/__tests__/corpora.test.ts`:

```typescript
it('flags _abs question_id as metadata.unanswerable', () => {
  const sample = {
    question_id: 'abc123_abs',
    question_type: 'single-session-user',
    question: 'What did I name my hamster?',
    answer: 'You did not mention this information. You mentioned your cat Luna but not your hamster.',
    haystack_session_ids: ['s1'],
    haystack_sessions: [[{ role: 'user', content: 'I love my cat Luna' } as const]],
    answer_session_ids: ['s1'],
  };
  const { question } = transformLongMemEvalSample(sample);
  expect(question.metadata?.unanswerable).toBe(true);
});

it('leaves answerable questions without an unanswerable flag', () => {
  const sample = {
    question_id: 'abc123',
    question_type: 'single-session-user',
    question: 'What degree did I graduate with?',
    answer: 'Business Administration',
    haystack_session_ids: ['s1'],
    haystack_sessions: [[{ role: 'user', content: 'I graduated with a BBA' } as const]],
    answer_session_ids: ['s1'],
  };
  const { question } = transformLongMemEvalSample(sample);
  expect(question.metadata?.unanswerable).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/corpora.test.ts -t "_abs"`
Expected: FAIL with `expected undefined to be true`.

- [ ] **Step 3: Implement the flag**

In `packages/memory-strata/test/bench/corpora/longmemeval-s.ts`, replace the existing `metadata` construction inside `transformLongMemEvalSample`:

```typescript
const unanswerable = s.question_id.endsWith('_abs');
const metaParts: Record<string, unknown> = {};
if (s.question_type) metaParts.question_type = s.question_type;
if (unanswerable) metaParts.unanswerable = true;
return {
  docs,
  question: {
    id: s.question_id,
    text: s.question,
    goldAnswer: s.answer,
    goldDocIds: (s.answer_session_ids ?? []).map((id) => `episodes/${id}`),
    metadata: Object.keys(metaParts).length > 0 ? metaParts : undefined,
  },
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/corpora.test.ts`
Expected: PASS (existing tests + 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/corpora/longmemeval-s.ts packages/memory-strata/test/bench/__tests__/corpora.test.ts
git commit -m "feat(memory-strata): flag LongMemEval-S _abs questions as metadata.unanswerable

Phase 3C prep — the abstention-aware judge keys off metadata.unanswerable
to decide whether 'I don't know' is the correct answer."
```

---

## Task 2: Expand Verdict + judge for abstention

**Files:**
- Modify: `packages/memory-strata/test/bench/types.ts`
- Modify: `packages/memory-strata/test/bench/judge.ts`
- Modify: `packages/memory-strata/test/bench/cli.ts`
- Test: `packages/memory-strata/test/bench/__tests__/judge.test.ts`

Verdict gains two new variants. The judge sees a new "Unanswerable" line in its prompt; the parser accepts the new variants and falls back to `uncertain` on malformed output.

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory-strata/test/bench/__tests__/judge.test.ts`:

```typescript
it('returns abstained-correctly when question is unanswerable and answer is "I don\'t know"', async () => {
  const stub: JudgeClient = {
    async complete() {
      return { text: 'VERDICT: abstained-correctly\nREASON: agent abstained on unanswerable q', usage: { in: 5, out: 5 } };
    },
  };
  const r = await judgeAnswer(stub, 'q', 'You did not mention this information.', "I don't know.", { unanswerable: true });
  expect(r.verdict).toBe('abstained-correctly');
});

it('returns abstained-incorrectly when question is answerable but agent abstains', async () => {
  const stub: JudgeClient = {
    async complete() {
      return { text: 'VERDICT: abstained-incorrectly\nREASON: agent declined answerable q', usage: { in: 5, out: 5 } };
    },
  };
  const r = await judgeAnswer(stub, 'q', 'Business Administration', "I don't know.", { unanswerable: false });
  expect(r.verdict).toBe('abstained-incorrectly');
});

it('still parses correct/incorrect/uncertain (back-compat)', async () => {
  const stub: JudgeClient = {
    async complete() {
      return { text: 'VERDICT: correct\nREASON: ok', usage: { in: 5, out: 5 } };
    },
  };
  const r = await judgeAnswer(stub, 'q', 'a', 'a', { unanswerable: false });
  expect(r.verdict).toBe('correct');
});

it('passes unanswerable signal to the judge prompt', async () => {
  let capturedUser: string | null = null;
  const stub: JudgeClient = {
    async complete({ user }) {
      capturedUser = user;
      return { text: 'VERDICT: uncertain\nREASON: x', usage: { in: 1, out: 1 } };
    },
  };
  await judgeAnswer(stub, 'q', 'gold', 'a', { unanswerable: true });
  expect(capturedUser).toContain('Unanswerable: true');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/judge.test.ts`
Expected: FAIL — `judgeAnswer` does not accept the 5th arg yet; verdict parser drops the new variants.

- [ ] **Step 3: Extend types**

In `packages/memory-strata/test/bench/types.ts`, replace the existing `Verdict` line and the `ConfigName` line:

```typescript
export type ConfigName = 'a-bm25' | 'b-rerank' | 'c-rrf' | 'd-map' | 'e-map-fts';

export type Verdict =
  | 'correct'
  | 'incorrect'
  | 'abstained-correctly'
  | 'abstained-incorrectly'
  | 'uncertain';
```

- [ ] **Step 4: Update the judge**

Replace `packages/memory-strata/test/bench/judge.ts`'s `SYSTEM` and `judgeAnswer`:

```typescript
const SYSTEM = `You are an evaluation judge. Score whether an answer matches the gold answer.

Respond in EXACTLY this format on two lines:
VERDICT: <correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain>
REASON: <one short sentence>

Scoring rules:
- "correct": the agent's answer matches the gold answer.
- "incorrect": the agent's answer contradicts the gold or is materially wrong.
- "abstained-correctly": the question is marked Unanswerable (gold is an "I don't know"-style refusal) AND the agent refused to answer (e.g., "I don't know" or "the memory does not contain this").
- "abstained-incorrectly": the agent refused to answer ("I don't know"-style) but the question is answerable (Unanswerable: false) — a missed retrieval.
- "uncertain": you cannot tell from the gold whether the agent is right (partial answers, ambiguous gold).`;

const VERDICT_RE = /VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)/i;

export async function judgeAnswer(
  client: JudgeClient,
  question: string,
  goldAnswer: string,
  agentAnswer: string,
  opts: { unanswerable: boolean } = { unanswerable: false },
): Promise<JudgeResult> {
  const user = `Unanswerable: ${opts.unanswerable}\nQuestion: ${question}\nGold answer: ${goldAnswer}\nAgent answer: ${agentAnswer}`;
  const resp = await client.complete({ system: SYSTEM, user });
  const verdictMatch = resp.text.match(VERDICT_RE);
  const reasonMatch = resp.text.match(/REASON:\s*(.+)/i);
  const verdict: Verdict = verdictMatch ? (verdictMatch[1]!.toLowerCase() as Verdict) : 'uncertain';
  const reason = reasonMatch ? reasonMatch[1]!.trim() : resp.text.trim();
  return { verdict, reason, usage: resp.usage };
}
```

- [ ] **Step 5: Update the CLI call site**

In `packages/memory-strata/test/bench/cli.ts`, replace the existing `judgeAnswer` call (currently around line 168):

```typescript
const verdict = await judgeAnswer(
  judgeClient,
  question.text,
  question.goldAnswer,
  agentResp.text,
  { unanswerable: question.metadata?.unanswerable === true },
);
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/judge.test.ts`
Expected: PASS (all 4 new tests + existing).

Also run typecheck:

Run: `pnpm --filter @ax/memory-strata typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/memory-strata/test/bench/types.ts packages/memory-strata/test/bench/judge.ts packages/memory-strata/test/bench/cli.ts packages/memory-strata/test/bench/__tests__/judge.test.ts
git commit -m "feat(memory-strata): abstention-aware judge with 5-way verdict

Expands Verdict to {correct, incorrect, abstained-correctly,
abstained-incorrectly, uncertain}. Judge prompt receives an
Unanswerable: <bool> line so it can distinguish correct refusal from
missed retrieval. Adds ConfigName slots for d-map and e-map-fts ahead
of their driver implementations."
```

---

## Task 3: Update report with abstention breakdown

**Files:**
- Modify: `packages/memory-strata/test/bench/report.ts`
- Test: `packages/memory-strata/test/bench/__tests__/report.test.ts`

Two changes:
1. Add `d-map` and `e-map-fts` to `CONFIG_LABELS`.
2. Add a per-config abstention table that splits correct-refusal vs incorrect-refusal counts and reports a correct-refusal rate among unanswerable questions.

Also: count `abstained-correctly` toward the headline accuracy column (per c137 — correct refusal IS the right answer).

- [ ] **Step 1: Write the failing tests**

Append to `packages/memory-strata/test/bench/__tests__/report.test.ts`. If `Verdict` / `ConfigName` / `QuestionResult` aren't already imported, add them to the existing import line.

```typescript
it('renders an abstention table with correct-refusal rate', () => {
  const mk = (id: string, verdict: Verdict, unanswerable: boolean): QuestionResult => ({
    corpus: 'longmemeval-s',
    config: 'd-map',
    question: { id, text: 'q', goldAnswer: 'g', metadata: unanswerable ? { unanswerable: true } : undefined },
    retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
    agentAnswer: 'a',
    verdict,
    judgeReason: '',
    agentTokens: { in: 0, out: 0 },
    judgeTokens: { in: 0, out: 0 },
    totalDollars: 0,
  });
  const results: QuestionResult[] = [
    mk('a_abs', 'abstained-correctly', true),
    mk('b_abs', 'abstained-incorrectly', true),
    mk('c_abs', 'incorrect', true),
    mk('d', 'correct', false),
    mk('e', 'abstained-incorrectly', false),
  ];
  const md = renderReport({ results, cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14') });
  expect(md).toContain('## Abstention');
  expect(md).toContain('D: Retrieval Orchestrator');
  // 1 of 3 unanswerable questions correctly refused -> 33.3%
  expect(md).toMatch(/correct-refusal[^\n]*33\.3%/i);
});

it('renders d-map and e-map-fts labels', () => {
  const mk = (config: ConfigName): QuestionResult => ({
    corpus: 'longmemeval-s',
    config,
    question: { id: 'q', text: 'q', goldAnswer: 'g' },
    retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
    agentAnswer: 'a',
    verdict: 'correct',
    judgeReason: '',
    agentTokens: { in: 0, out: 0 },
    judgeTokens: { in: 0, out: 0 },
    totalDollars: 0,
  });
  const md = renderReport({
    results: [mk('d-map'), mk('e-map-fts')],
    cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14'),
  });
  expect(md).toContain('D: Retrieval Orchestrator');
  expect(md).toContain('E: Orchestrator + BM25 fallback');
});

it('counts abstained-correctly toward headline accuracy', () => {
  const mk = (id: string, verdict: Verdict): QuestionResult => ({
    corpus: 'longmemeval-s', config: 'd-map',
    question: { id, text: 'q', goldAnswer: 'g', metadata: { unanswerable: true } },
    retrieval: { retrievedDocs: [], latencyMs: 0, embeddingTokens: 0, rerankTokens: 0 },
    agentAnswer: 'a', verdict, judgeReason: '',
    agentTokens: { in: 0, out: 0 }, judgeTokens: { in: 0, out: 0 }, totalDollars: 0,
  });
  const md = renderReport({
    results: [mk('1', 'correct'), mk('2', 'abstained-correctly')],
    cap: 50, totalSpent: 0, capExceeded: false, runDate: new Date('2026-05-14'),
  });
  // 2 of 2 are "correct" in the headline aggregation
  expect(md).toMatch(/d-map[^\n]*\|\s*2\s*\|\s*100\.0%/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/report.test.ts`
Expected: FAIL (`d-map` / `e-map-fts` not in `CONFIG_LABELS`; no abstention section; abstained-correctly not counted toward accuracy).

- [ ] **Step 3: Update report.ts**

In `packages/memory-strata/test/bench/report.ts`:

(a) Replace `CONFIG_LABELS`:

```typescript
const CONFIG_LABELS: Record<ConfigName, string> = {
  'a-bm25': 'A: BM25-only',
  'b-rerank': 'B: BM25 + zerank-2',
  'c-rrf': 'C: BM25 + zembed-1 + RRF',
  'd-map': 'D: Retrieval Orchestrator (c137-style)',
  'e-map-fts': 'E: Orchestrator + BM25 fallback',
};
```

(b) In `aggregateByConfig`, replace these two lines:

```typescript
    if (r.verdict === 'correct') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
```

with:

```typescript
    if (r.verdict === 'correct' || r.verdict === 'abstained-correctly') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
```

(c) Just before `lines.push(`## Binding decision`);`, insert the abstention table:

```typescript
interface AbsAgg {
  unanswerableTotal: number;
  correctRefusal: number;
  incorrectRefusal: number;
  hallucinatedOnUnanswerable: number;
  falseRefusalOnAnswerable: number;
  answerableTotal: number;
}
const abs = new Map<CorpusName, Map<ConfigName, AbsAgg>>();
for (const r of input.results) {
  if (!abs.has(r.corpus)) abs.set(r.corpus, new Map());
  const cm = abs.get(r.corpus)!;
  if (!cm.has(r.config))
    cm.set(r.config, {
      unanswerableTotal: 0,
      correctRefusal: 0,
      incorrectRefusal: 0,
      hallucinatedOnUnanswerable: 0,
      falseRefusalOnAnswerable: 0,
      answerableTotal: 0,
    });
  const a = cm.get(r.config)!;
  const unanswerable = r.question.metadata?.unanswerable === true;
  if (unanswerable) {
    a.unanswerableTotal += 1;
    if (r.verdict === 'abstained-correctly') a.correctRefusal += 1;
    else if (r.verdict === 'abstained-incorrectly') a.incorrectRefusal += 1;
    else if (r.verdict === 'incorrect' || r.verdict === 'correct') a.hallucinatedOnUnanswerable += 1;
  } else {
    a.answerableTotal += 1;
    if (r.verdict === 'abstained-incorrectly') a.falseRefusalOnAnswerable += 1;
  }
}
const hasAbs = [...abs.values()].some((m) =>
  [...m.values()].some((a) => a.unanswerableTotal > 0 || a.falseRefusalOnAnswerable > 0),
);
if (hasAbs) {
  lines.push(`## Abstention`);
  lines.push(``);
  lines.push(`| corpus | Config | unanswerable n | correct-refusal | incorrect-refusal | hallucinated | false-refusal (on answerable) |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const [corpus, cm] of abs) {
    for (const [config, a] of cm) {
      const rate = a.unanswerableTotal > 0
        ? `${((100 * a.correctRefusal) / a.unanswerableTotal).toFixed(1)}%`
        : 'n/a';
      lines.push(
        `| ${corpus} | ${CONFIG_LABELS[config]} | ${a.unanswerableTotal} | ${a.correctRefusal} (${rate}) | ${a.incorrectRefusal} | ${a.hallucinatedOnUnanswerable} | ${a.falseRefusalOnAnswerable} / ${a.answerableTotal} |`,
      );
    }
  }
  lines.push(``);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/report.ts packages/memory-strata/test/bench/__tests__/report.test.ts
git commit -m "feat(memory-strata): report adds abstention table + D/E config labels

Correct-refusal on unanswerable questions counts as 'correct' in the
headline accuracy column (the c137 metric). The new Abstention table
breaks out the four buckets per config so we can see what's actually
happening underneath the rolled-up figure."
```

---

## Task 4: Map generator with on-disk cache

**Files:**
- Create: `packages/memory-strata/test/bench/map.ts`
- Test: `packages/memory-strata/test/bench/__tests__/map.test.ts`

The map generator produces a c137-style `system/map.md`-shaped string from a corpus. Layout:

```
# Memory Map

## episodes/
- <sessionId>: <one-line summary, truncated to ~120 chars>
- <sessionId>: <one-line summary, truncated to ~120 chars>
...
```

LongMemEval-S sessions are already grouped under `episodes/`. The generator just walks `corpus.memoryTree`, groups by `doc.category`, and emits one line per doc using the existing `doc.summary` field (already a first-sentence extract — good enough for the spike). We do NOT call an LLM to re-summarize at first; the issue's ~\$5 build cost from an LLM call per sample is deferred — if results are borderline, an LLM-rewrite is the obvious follow-up.

Cache: keyed on a hash of `(corpus.name, sorted doc paths joined, summaries)`. Stored at `<cacheDir>/<corpus.name>-<hash>.md`.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory-strata/test/bench/__tests__/map.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMap } from '../map.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';

function corpusOf(docs: ReturnType<typeof makeDoc>[]): BenchCorpus {
  const c: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
  for (const d of docs) c.memoryTree.set(d.path, d);
  return c;
}

describe('generateMap', () => {
  it('groups docs by category and emits one line per doc with sessionId + summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-'));
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-001', summary: 'discussed coffee preferences', body: '' }),
      makeDoc({ category: 'episodes', slug: 's-002', summary: 'discussed dog training', body: '' }),
      makeDoc({ category: 'knowledge', slug: 'kw-1', summary: 'caffeine biochem', body: '' }),
    ]);
    const map = await generateMap(corpus, { cacheDir: dir });
    expect(map).toContain('## episodes/');
    expect(map).toContain('## knowledge/');
    expect(map).toContain('- s-001: discussed coffee preferences');
    expect(map).toContain('- s-002: discussed dog training');
    expect(map).toContain('- kw-1: caffeine biochem');
  });

  it('truncates summaries to ~120 chars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-trunc-'));
    const long = 'x'.repeat(500);
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 's-1', summary: long, body: '' }),
    ]);
    const map = await generateMap(corpus, { cacheDir: dir });
    const line = map.split('\n').find((l) => l.startsWith('- s-1:'))!;
    expect(line.length).toBeLessThan(160);
  });

  it('caches the generated map keyed on (corpus.name + doc set hash)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-cache-'));
    const corpus = corpusOf([
      makeDoc({ category: 'episodes', slug: 'x', summary: 'one', body: '' }),
    ]);
    const map1 = await generateMap(corpus, { cacheDir: dir });
    const map2 = await generateMap(corpus, { cacheDir: dir });
    expect(map1).toBe(map2);
  });

  it('returns a map under the ~2k-token soft cap for 50 sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-map-budget-'));
    const docs = Array.from({ length: 50 }, (_, i) =>
      makeDoc({ category: 'episodes', slug: `s-${i.toString().padStart(3, '0')}`, summary: 'a short one-line summary about something memorable', body: '' }),
    );
    const map = await generateMap(corpusOf(docs), { cacheDir: dir });
    expect(map.length).toBeLessThan(8_000); // ~2k tokens upper-bound at ~4 chars/token
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/map.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement map.ts**

Create `packages/memory-strata/test/bench/map.ts`:

```typescript
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchCorpus } from './types.js';

interface MapOptions {
  cacheDir: string;
  summaryMaxChars?: number;
}

const DEFAULT_SUMMARY_MAX = 120;

export async function generateMap(corpus: BenchCorpus, opts: MapOptions): Promise<string> {
  mkdirSync(opts.cacheDir, { recursive: true });
  const summaryMax = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX;

  const hash = computeCorpusHash(corpus);
  const cachePath = join(opts.cacheDir, `${corpus.name}-${hash}.md`);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');

  const byCategory = new Map<string, Array<{ slug: string; summary: string }>>();
  for (const doc of corpus.memoryTree.values()) {
    if (!byCategory.has(doc.category)) byCategory.set(doc.category, []);
    byCategory.get(doc.category)!.push({
      slug: doc.slug,
      summary: truncate(doc.summary, summaryMax),
    });
  }
  for (const arr of byCategory.values()) arr.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines: string[] = ['# Memory Map', ''];
  for (const cat of [...byCategory.keys()].sort()) {
    lines.push(`## ${cat}/`);
    for (const { slug, summary } of byCategory.get(cat)!) {
      lines.push(`- ${slug}: ${summary}`);
    }
    lines.push('');
  }
  const out = lines.join('\n');
  writeFileSync(cachePath, out);
  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function computeCorpusHash(corpus: BenchCorpus): string {
  const h = createHash('sha256');
  const paths = [...corpus.memoryTree.keys()].sort();
  h.update(corpus.name);
  for (const p of paths) {
    const d = corpus.memoryTree.get(p)!;
    h.update(p);
    h.update(d.summary);
  }
  return h.digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/map.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/map.ts packages/memory-strata/test/bench/__tests__/map.test.ts
git commit -m "feat(memory-strata): bench map generator (c137-style system/map.md)

Generates a per-corpus structured map grouped by category, one line
per doc, summaries truncated to ~120 chars. Cached on disk keyed by
corpus name + sha256 of (path + summary). Reuses the existing
firstSentence-derived summary from the LongMemEval-S loader."
```

---

## Task 5: Retrieval Orchestrator (LLM call + XML parser + runner)

**Files:**
- Create: `packages/memory-strata/test/bench/orchestrator.ts`
- Test: `packages/memory-strata/test/bench/__tests__/orchestrator.test.ts`

Pieces:
1. `OrchestratorClient` interface so tests can stub it. Anthropic Haiku-class impl provided.
2. `parseOrchestratorXml` — regex-based, accepts loose XML, strips code fences, decodes entities.
3. `runOrchestrator` — calls the client, parses, returns `{ ops, followupNeeded, usage, rawXml }`.
4. `runOps` — resolves `load` ops against `corpus.memoryTree` and `fts` ops against a passed-in BM25 search fn. Dedups by path; caps at topK.

Regex parser rather than full XML lib — c137 reports XML parsing reliability is fine at this scale; adding `fast-xml-parser` is more risk than it's worth for a spike.

- [ ] **Step 1: Write the failing tests**

Create `packages/memory-strata/test/bench/__tests__/orchestrator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrchestratorXml, runOrchestrator, runOps } from '../orchestrator.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';
import type { OrchestratorClient } from '../orchestrator.js';

describe('parseOrchestratorXml', () => {
  it('extracts load ops with doc + optional section', () => {
    const xml = `<retrieve><load doc="episodes/s-1"/><load doc="episodes/s-2" section="## response"/></retrieve>`;
    const { ops, followupNeeded } = parseOrchestratorXml(xml);
    expect(followupNeeded).toBe(false);
    expect(ops).toEqual([
      { kind: 'load', doc: 'episodes/s-1' },
      { kind: 'load', doc: 'episodes/s-2', section: '## response' },
    ]);
  });

  it('extracts fts ops and trims whitespace', () => {
    const { ops } = parseOrchestratorXml(`<fts query="  refund window  "/>`);
    expect(ops).toEqual([{ kind: 'fts', query: 'refund window' }]);
  });

  it('detects followup=true marker', () => {
    const { followupNeeded } = parseOrchestratorXml(`<followup needed="true"/>`);
    expect(followupNeeded).toBe(true);
  });

  it('strips markdown code fences if the model wraps output', () => {
    const xml = '```xml\n<load doc="x"/>\n```';
    const { ops } = parseOrchestratorXml(xml);
    expect(ops).toEqual([{ kind: 'load', doc: 'x' }]);
  });

  it('returns empty ops + followup=false on unparseable input', () => {
    const r = parseOrchestratorXml('this is not xml');
    expect(r.ops).toEqual([]);
    expect(r.followupNeeded).toBe(false);
  });

  it('handles single-quoted attributes', () => {
    const { ops } = parseOrchestratorXml(`<load doc='episodes/s-1'/>`);
    expect(ops).toEqual([{ kind: 'load', doc: 'episodes/s-1' }]);
  });

  it('decodes XML entities in attribute values', () => {
    const { ops } = parseOrchestratorXml(`<fts query="cats &amp; dogs"/>`);
    expect(ops).toEqual([{ kind: 'fts', query: 'cats & dogs' }]);
  });
});

describe('runOrchestrator', () => {
  it('sends map + query to the client and parses the response', async () => {
    let capturedUser: string | null = null;
    const stub: OrchestratorClient = {
      async complete({ user }) {
        capturedUser = user;
        return { text: `<load doc="episodes/s-1"/>`, usage: { in: 10, out: 5 } };
      },
    };
    const r = await runOrchestrator(stub, 'MAP HERE', 'What did I name my hamster?');
    expect(capturedUser).toContain('MAP HERE');
    expect(capturedUser).toContain('What did I name my hamster?');
    expect(r.ops).toEqual([{ kind: 'load', doc: 'episodes/s-1' }]);
    expect(r.usage).toEqual({ in: 10, out: 5 });
  });
});

describe('runOps', () => {
  it('resolves load ops against the corpus and FTS ops against the search fn', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 's-1', summary: 'hamster Luna', body: '' });
    const d2 = makeDoc({ category: 'episodes', slug: 's-2', summary: 'cat training', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const ftsCalls: string[] = [];
    const ftsSearch = async (query: string, _topK: number) => {
      ftsCalls.push(query);
      return [{ path: 'episodes/s-2', score: 0.5, summary: 'cat training' }];
    };

    const docs = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/s-1' }, { kind: 'fts', query: 'cat' }], followupNeeded: false },
      { corpus, ftsSearch, topK: 5 },
    );
    expect(docs.map((d) => d.path)).toEqual(['episodes/s-1', 'episodes/s-2']);
    expect(ftsCalls).toEqual(['cat']);

    const docs2 = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/s-2' }, { kind: 'fts', query: 'cat' }], followupNeeded: false },
      { corpus, ftsSearch, topK: 5 },
    );
    expect(docs2.map((d) => d.path)).toEqual(['episodes/s-2']);
  });

  it('drops load ops that reference unknown docs', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'x', summary: 'x', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    const docs = await runOps(
      { ops: [{ kind: 'load', doc: 'episodes/missing' }, { kind: 'load', doc: 'episodes/x' }], followupNeeded: false },
      { corpus, ftsSearch: async () => [], topK: 5 },
    );
    expect(docs.map((d) => d.path)).toEqual(['episodes/x']);
  });

  it('caps results at topK', async () => {
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    for (let i = 0; i < 10; i++) {
      const d = makeDoc({ category: 'episodes', slug: `s-${i}`, summary: `s${i}`, body: '' });
      corpus.memoryTree.set(d.path, d);
    }
    const docs = await runOps(
      { ops: Array.from({ length: 10 }, (_, i) => ({ kind: 'load' as const, doc: `episodes/s-${i}` })), followupNeeded: false },
      { corpus, ftsSearch: async () => [], topK: 3 },
    );
    expect(docs.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/orchestrator.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement orchestrator.ts**

Create `packages/memory-strata/test/bench/orchestrator.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry.js';
import type { BenchCorpus, RetrievedDoc } from './types.js';

export interface OrchestratorClient {
  complete(args: { system: string; user: string }): Promise<{
    text: string;
    usage: { in: number; out: number };
  }>;
}

export type OrchestratorOp =
  | { kind: 'load'; doc: string; section?: string }
  | { kind: 'fts'; query: string };

export interface OrchestratorPlan {
  ops: OrchestratorOp[];
  followupNeeded: boolean;
}

export interface OrchestratorRunResult extends OrchestratorPlan {
  usage: { in: number; out: number };
  rawXml: string;
}

const SYSTEM = `You are a retrieval planner. You read a memory map (a hierarchical
listing of every document in the agent's memory with one-line summaries) and a
user query, and decide which documents the agent should load before answering.

You output ONLY XML, using these tags:

  <load doc="<docPath>"/>                — load a whole document into context
  <load doc="<docPath>" section="..."/>  — load just one section of a document
  <fts query="..."/>                     — when you genuinely cannot decide from the
                                            map alone, run a BM25 keyword search
                                            (max 1-2 of these per query)
  <followup needed="true"/>              — emit when you suspect one hop won't be
                                            enough (e.g., cross-doc aggregation,
                                            "what was X before we changed it")

Rules:
- Emit between 1 and 5 ops total. Prefer the smallest precise set.
- Doc paths must exactly match entries in the map (e.g. "episodes/s-001").
- Do not output prose, code fences, or explanations. Only the XML ops.`;

export async function runOrchestrator(
  client: OrchestratorClient,
  map: string,
  query: string,
): Promise<OrchestratorRunResult> {
  const user = `## Memory Map\n${map}\n\n## Query\n${query}\n\n## Output\n`;
  const resp = await client.complete({ system: SYSTEM, user });
  const plan = parseOrchestratorXml(resp.text);
  return { ...plan, usage: resp.usage, rawXml: resp.text };
}

const FENCE_RE = /^```[a-z]*\n?|\n?```$/g;
const LOAD_RE = /<load\s+([^/>]*?)\s*\/?>/gi;
const FTS_RE = /<fts\s+([^/>]*?)\s*\/?>/gi;
const FOLLOWUP_RE = /<followup\s+[^/>]*needed=["']?true["']?[^/>]*\/?>/i;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseOrchestratorXml(text: string): OrchestratorPlan {
  const stripped = text.replace(FENCE_RE, '').trim();
  const ops: OrchestratorOp[] = [];

  for (const m of stripped.matchAll(LOAD_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.doc) {
      const op: OrchestratorOp = { kind: 'load', doc: attrs.doc };
      if (attrs.section) op.section = attrs.section;
      ops.push(op);
    }
  }
  for (const m of stripped.matchAll(FTS_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.query) ops.push({ kind: 'fts', query: attrs.query.trim() });
  }
  return { ops, followupNeeded: FOLLOWUP_RE.test(stripped) };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1]!;
    const raw = m[2] ?? m[3] ?? '';
    out[name] = decodeEntities(raw);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface RunOpsContext {
  corpus: BenchCorpus;
  ftsSearch: (query: string, topK: number) => Promise<RetrievedDoc[]>;
  topK: number;
}

export async function runOps(
  plan: OrchestratorPlan,
  ctx: RunOpsContext,
): Promise<RetrievedDoc[]> {
  const seen = new Set<string>();
  const out: RetrievedDoc[] = [];
  for (const op of plan.ops) {
    if (op.kind === 'load') {
      const doc = ctx.corpus.memoryTree.get(op.doc);
      if (!doc || seen.has(doc.path)) continue;
      seen.add(doc.path);
      out.push({ path: doc.path, score: 1, summary: doc.summary });
      if (out.length >= ctx.topK) return out;
    } else if (op.kind === 'fts') {
      const hits = await ctx.ftsSearch(op.query, ctx.topK);
      for (const h of hits) {
        if (seen.has(h.path)) continue;
        seen.add(h.path);
        out.push(h);
        if (out.length >= ctx.topK) return out;
      }
    }
  }
  return out;
}

export function makeAnthropicOrchestratorClient(
  apiKey: string,
  model = 'claude-haiku-4-5-20251001',
): OrchestratorClient {
  const a = new Anthropic({ apiKey });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
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
        { attempts: 4, baseDelayMs: 1000, label: 'anthropic-orchestrator' },
      );
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/orchestrator.test.ts`
Expected: PASS (all parser + runner tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/orchestrator.ts packages/memory-strata/test/bench/__tests__/orchestrator.test.ts
git commit -m "feat(memory-strata): Retrieval Orchestrator (LLM + XML parser + runner)

Cheap LLM (Haiku) reads the map + query, emits XML retrieval ops
(<load doc=…/>, <fts query=…/>, <followup needed=…/>). Regex parser
handles loose XML, code-fenced output, and entity escapes. Runner
resolves load ops against the corpus and FTS ops against an injected
BM25 search fn (Config A's plugin)."
```

---

## Task 6: Config D driver (d-map)

**Files:**
- Modify: `packages/memory-strata/test/bench/types.ts` (extend `RetrievalResult`)
- Create: `packages/memory-strata/test/bench/configs/d-map.ts`
- Test: `packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts`

Config D composes the pieces from Tasks 4 and 5. It builds a BM25 plugin under the hood (via Config A) so that orchestrator-emitted `<fts/>` ops have a place to land. Config D records but does not act on `followupNeeded` — that's Config E's job.

- [ ] **Step 1: Extend RetrievalResult**

In `packages/memory-strata/test/bench/types.ts`, replace the `RetrievalResult` interface:

```typescript
export interface RetrievalResult {
  retrievedDocs: RetrievedDoc[];
  latencyMs: number;
  embeddingTokens: number;
  rerankTokens: number;
  orchestratorTokens?: { in: number; out: number };
  followupNeeded?: boolean;
}
```

Existing A/B/C drivers don't need to set the new optional fields.

- [ ] **Step 2: Write the failing tests**

Create `packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigD } from '../configs/d-map.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus } from '../types.js';
import type { OrchestratorClient } from '../orchestrator.js';

function fixedClient(xml: string): OrchestratorClient {
  return {
    async complete() {
      return { text: xml, usage: { in: 50, out: 30 } };
    },
  };
}

describe('Config D (d-map)', () => {
  it('orchestrates against generated map and returns load-op docs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 's-001', summary: 'discussed hamster', body: 'hamster details' });
    const d2 = makeDoc({ category: 'episodes', slug: 's-002', summary: 'discussed cat', body: 'cat details' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);

    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<load doc="episodes/s-001"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'about hamster', goldAnswer: 'h' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs.map((d) => d.path)).toEqual(['episodes/s-001']);
      expect(r.orchestratorTokens).toEqual({ in: 50, out: 30 });
      expect(r.followupNeeded).toBe(false);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records followupNeeded but does not run a fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-fu-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'x', summary: 'x', body: '' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<followup needed="true"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'x', goldAnswer: 'x' },
        5,
        new AbortController().signal,
      );
      expect(r.followupNeeded).toBe(true);
      expect(r.retrievedDocs.length).toBe(0);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves fts ops against the BM25 plugin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-d-fts-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'coffee', summary: 'coffee', body: 'cortado is espresso with milk' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigD({
      tempDir: dir,
      orchestratorClient: fixedClient(`<fts query="cortado"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'what is a cortado', goldAnswer: 'milk + espresso' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs[0]!.path).toBe('episodes/coffee');
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/configs-d-e.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 4: Implement d-map.ts**

Create `packages/memory-strata/test/bench/configs/d-map.ts`:

```typescript
import { createConfigA } from './a-bm25.js';
import { generateMap } from '../map.js';
import { runOrchestrator, runOps } from '../orchestrator.js';
import type { OrchestratorClient } from '../orchestrator.js';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface ConfigDOptions extends ConfigFactoryOptions {
  orchestratorClient: OrchestratorClient;
  mapCacheDir: string;
}

export function createConfigD(opts: ConfigDOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;
  let map: string | null = null;

  return {
    name: 'd-map',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await bm.build(corpus);
      map = await generateMap(corpus, { cacheDir: opts.mapCacheDir });
    },
    async teardown() {
      corpusRef = null;
      map = null;
      await bm.teardown();
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!corpusRef || !map) throw new Error('Config D: build() not called');
      const t0 = Date.now();
      const plan = await runOrchestrator(opts.orchestratorClient, map, question.text);
      const docs = await runOps(plan, {
        corpus: corpusRef,
        ftsSearch: async (query, k) => {
          const r = await bm.retrieve({ ...question, text: query }, k, signal);
          return r.retrievedDocs;
        },
        topK,
      });
      return {
        retrievedDocs: docs,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
        orchestratorTokens: plan.usage,
        followupNeeded: plan.followupNeeded,
      };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/configs-d-e.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/test/bench/configs/d-map.ts packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts packages/memory-strata/test/bench/types.ts
git commit -m "feat(memory-strata): Config D driver (c137-style retrieval orchestrator)

Composes generateMap + runOrchestrator + runOps. Build phase
generates a map.md-shaped string; retrieve phase asks Haiku for XML
ops and resolves them. <fts/> ops fall through to the same BM25
plugin Config A uses."
```

---

## Task 7: Config E driver (e-map-fts — D + BM25 fallback)

**Files:**
- Create: `packages/memory-strata/test/bench/configs/e-map-fts.ts`
- Test: `packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts` (append)

Config E wraps Config D. When the orchestrator emits `followup needed="true"` OR returns zero ops, E runs a BM25 search on the raw question text against the same plugin Config D builds, and merges those results (dedup'd, appended after the orchestrator's picks).

- [ ] **Step 1: Append failing tests**

Append to `packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts`:

```typescript
import { createConfigE } from '../configs/e-map-fts.js';

describe('Config E (e-map-fts)', () => {
  it('falls back to BM25 when orchestrator emits followup=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-e-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'coffee', summary: 'coffee', body: 'cortado is espresso with milk' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigE({
      tempDir: dir,
      orchestratorClient: fixedClient(`<followup needed="true"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'what is a cortado', goldAnswer: 'x' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs[0]!.path).toBe('episodes/coffee');
      expect(r.followupNeeded).toBe(true);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not run BM25 fallback when orchestrator returned load ops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-e-no-fb-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 's-1', summary: 'a', body: 'cortado here' });
    const d2 = makeDoc({ category: 'episodes', slug: 's-2', summary: 'b', body: 'unrelated' });
    corpus.memoryTree.set(d1.path, d1);
    corpus.memoryTree.set(d2.path, d2);
    const driver = createConfigE({
      tempDir: dir,
      orchestratorClient: fixedClient(`<load doc="episodes/s-2"/>`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'cortado', goldAnswer: 'x' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs.map((d) => d.path)).toEqual(['episodes/s-2']);
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back when orchestrator emits zero ops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-e-zero-'));
    const corpus: BenchCorpus = { name: 'internal', memoryTree: new Map(), questions: [] };
    const d1 = makeDoc({ category: 'episodes', slug: 'coffee', summary: 'coffee', body: 'cortado is espresso with milk' });
    corpus.memoryTree.set(d1.path, d1);
    const driver = createConfigE({
      tempDir: dir,
      orchestratorClient: fixedClient(`(no xml here)`),
      mapCacheDir: dir,
    });
    await driver.build(corpus);
    try {
      const r = await driver.retrieve(
        { id: 'q', text: 'cortado', goldAnswer: 'x' },
        5,
        new AbortController().signal,
      );
      expect(r.retrievedDocs[0]!.path).toBe('episodes/coffee');
    } finally {
      await driver.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/configs-d-e.test.ts`
Expected: FAIL — `createConfigE` doesn't exist.

- [ ] **Step 3: Implement e-map-fts.ts**

Create `packages/memory-strata/test/bench/configs/e-map-fts.ts`:

```typescript
import { createConfigA } from './a-bm25.js';
import { generateMap } from '../map.js';
import { runOrchestrator, runOps } from '../orchestrator.js';
import type { OrchestratorClient } from '../orchestrator.js';
import type {
  BenchCorpus,
  BenchQuestion,
  ConfigDriver,
  RetrievalResult,
  RetrievedDoc,
} from '../types.js';
import type { ConfigFactoryOptions } from './shared.js';

export interface ConfigEOptions extends ConfigFactoryOptions {
  orchestratorClient: OrchestratorClient;
  mapCacheDir: string;
}

export function createConfigE(opts: ConfigEOptions): ConfigDriver {
  const bm = createConfigA(opts);
  let corpusRef: BenchCorpus | null = null;
  let map: string | null = null;

  return {
    name: 'e-map-fts',
    async build(corpus: BenchCorpus) {
      corpusRef = corpus;
      await bm.build(corpus);
      map = await generateMap(corpus, { cacheDir: opts.mapCacheDir });
    },
    async teardown() {
      corpusRef = null;
      map = null;
      await bm.teardown();
    },
    async retrieve(
      question: BenchQuestion,
      topK: number,
      signal: AbortSignal,
    ): Promise<RetrievalResult> {
      if (!corpusRef || !map) throw new Error('Config E: build() not called');
      const t0 = Date.now();
      const plan = await runOrchestrator(opts.orchestratorClient, map, question.text);
      const primary = await runOps(plan, {
        corpus: corpusRef,
        ftsSearch: async (query, k) => {
          const r = await bm.retrieve({ ...question, text: query }, k, signal);
          return r.retrievedDocs;
        },
        topK,
      });

      const seen = new Set(primary.map((d) => d.path));
      const out: RetrievedDoc[] = [...primary];
      const shouldFallback = plan.followupNeeded || primary.length === 0;
      if (shouldFallback && out.length < topK) {
        const r = await bm.retrieve(question, topK, signal);
        for (const d of r.retrievedDocs) {
          if (seen.has(d.path)) continue;
          seen.add(d.path);
          out.push(d);
          if (out.length >= topK) break;
        }
      }

      return {
        retrievedDocs: out,
        latencyMs: Date.now() - t0,
        embeddingTokens: 0,
        rerankTokens: 0,
        orchestratorTokens: plan.usage,
        followupNeeded: plan.followupNeeded,
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/configs-d-e.test.ts`
Expected: PASS (D + E suites both green).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-strata/test/bench/configs/e-map-fts.ts packages/memory-strata/test/bench/__tests__/configs-d-e.test.ts
git commit -m "feat(memory-strata): Config E driver (D + BM25 fallback)

When the orchestrator emits <followup needed=\"true\"/> or returns
zero ops, Config E runs a BM25 search on the raw question and merges
the results (dedup'd, appended after the orchestrator's picks). Lets
us isolate how much the FTS escape valve recovers on top of the
one-hop baseline."
```

---

## Task 8: Wire CLI + cost meter

**Files:**
- Modify: `packages/memory-strata/test/bench/cli.ts`

Three changes:
1. Add Haiku pricing to `PRICING`.
2. Construct an `OrchestratorClient` and a `mapCacheDir` (under the existing `tempDir`).
3. Add `d-map` / `e-map-fts` to the `wantCfg` switch and record orchestrator tokens via the meter.

- [ ] **Step 1: Add Haiku pricing**

In `packages/memory-strata/test/bench/cli.ts`, extend `PRICING`:

```typescript
const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};
```

- [ ] **Step 2: Wire the orchestrator client + map cache**

Add this with the other config imports near the top of `cli.ts`:

```typescript
import { createConfigD } from './configs/d-map.js';
import { createConfigE } from './configs/e-map-fts.js';
import { makeAnthropicOrchestratorClient } from './orchestrator.js';
```

After `const tempDir = mkdtempSync(...)`, add:

```typescript
const mapCacheDir = join(tempDir, 'maps');
const orchestratorClient = makeAnthropicOrchestratorClient(env.ANTHROPIC_API_KEY);
```

Extend the factory list:

```typescript
if (wantCfg('a-bm25')) driverFactories.push(() => createConfigA({ tempDir }));
if (wantCfg('b-rerank')) driverFactories.push(() => createConfigB({ tempDir, rerankClient }));
if (wantCfg('c-rrf')) driverFactories.push(() => createConfigC({ tempDir, embedClient }));
if (wantCfg('d-map')) driverFactories.push(() => createConfigD({ tempDir, orchestratorClient, mapCacheDir }));
if (wantCfg('e-map-fts')) driverFactories.push(() => createConfigE({ tempDir, orchestratorClient, mapCacheDir }));
```

- [ ] **Step 3: Record orchestrator tokens in the meter**

Inside the inner question loop in `cli.ts`, after the existing `if (retrieval.rerankTokens > 0) meter.record('zerank-2', ...)` line, add:

```typescript
if (retrieval.orchestratorTokens) meter.record('claude-haiku-4-5-20251001', retrieval.orchestratorTokens);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @ax/memory-strata typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm --filter @ax/memory-strata test`
Expected: All tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add packages/memory-strata/test/bench/cli.ts
git commit -m "feat(memory-strata): CLI wires Config D + E with Haiku orchestrator

Adds claude-haiku-4-5-20251001 to PRICING, constructs the
orchestrator client + map cache dir, registers d-map and e-map-fts
factories, and records orchestrator tokens via the cost meter so
final \$ figures include the cheap-LLM stage."
```

---

## Task 9: Run the bench against LongMemEval-S, write the report, annotate the design doc

**Files:**
- Generated: `docs/plans/2026-05-DD-memory-strata-vector-spike-report.md` (the bench writes this; rename to `2026-05-DD-memory-strata-phase-3c-config-d-report.md` after each run)
- Modify: `docs/plans/memory-strata-design.md` (Decision Records + Progressive Enhancement Path Level 3 annotation)

- [ ] **Step 1: Smoke-test the new configs with a tiny sample**

Run a 3-question canary first to validate end-to-end wiring before burning real budget:

```bash
ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY .env.bench | cut -d= -f2) \
ZEROENTROPY_API_KEY=$(grep ^ZEROENTROPY_API_KEY .env.bench | cut -d= -f2) \
OPENROUTER_API_KEY=$(grep ^OPENROUTER_API_KEY .env.bench | cut -d= -f2) \
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config d-map --sample 3
```

Expected: Three questions evaluated, report written, well under \$1 spent.

If the orchestrator output is consistently empty across all three, capture an example XML response and revisit the SYSTEM prompt in `orchestrator.ts` before running the full sample.

- [ ] **Step 2: Run the full Config D + E spike (n=100)**

Run D first, then rename the output, then run E:

```bash
ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY .env.bench | cut -d= -f2) \
ZEROENTROPY_API_KEY=$(grep ^ZEROENTROPY_API_KEY .env.bench | cut -d= -f2) \
OPENROUTER_API_KEY=$(grep ^OPENROUTER_API_KEY .env.bench | cut -d= -f2) \
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config d-map --sample 100
```

```bash
# Preserve the D report — the next run will overwrite the fixed-name file.
mv docs/plans/$(date +%Y-%m-%d)-memory-strata-vector-spike-report.md \
   docs/plans/$(date +%Y-%m-%d)-memory-strata-phase-3c-config-d-only-raw.md

# Now run E.
ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY .env.bench | cut -d= -f2) \
ZEROENTROPY_API_KEY=$(grep ^ZEROENTROPY_API_KEY .env.bench | cut -d= -f2) \
OPENROUTER_API_KEY=$(grep ^OPENROUTER_API_KEY .env.bench | cut -d= -f2) \
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config e-map-fts --sample 100

mv docs/plans/$(date +%Y-%m-%d)-memory-strata-vector-spike-report.md \
   docs/plans/$(date +%Y-%m-%d)-memory-strata-phase-3c-config-e-only-raw.md
```

Cost expectation: each run ≈ \$2 (well below the \$50 cap).

- [ ] **Step 3: Hand-author the merged Phase 3C report**

Create `docs/plans/2026-05-DD-memory-strata-phase-3c-config-d-report.md` (replace YYYY-MM-DD with actual date). Required content:

1. **Headline table** with all five configs (A/B/C cited from PR #66; D/E from this run).
2. **Abstention table** for D and E (n_unanswerable + correct-refusal + incorrect-refusal + hallucination + false-refusal). Pull from the raw reports.
3. **Binding interpretation** — does D beat A by ≥5 points? Does E beat D? Cite the exact deltas.
4. **One-hop coverage rate** — % of D questions where the orchestrator returned ≥1 op (i.e., did NOT emit followup=true and did NOT return empty XML). Compute from the per-question results (you may need to add a small script or read the raw report manually).
5. **Caveats** — reuse the PR #66 caveats; add new ones for orchestrator failure modes if observed.

Template:

```markdown
# Strata Phase 3C — Config D (Retrieval Orchestrator) + abstention spike

**Date:** YYYY-MM-DD
**Cap:** $50
**Total spent:** $X (D run: $A — E run: $B)

## Results

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | A: BM25-only (PR #66) | 100 | 22.0% | 25.0% | 1.0% | 71 | 148 | $1.7377 |
| longmemeval-s | B: BM25 + zerank-2 (PR #66) | 97 | 19.6% | 20.6% | 4.1% | 603 | 925 | $1.8787 |
| longmemeval-s | C: BM25 + zembed-1 + RRF (PR #66) | 100 | 13.0% | 16.0% | 3.0% | 600 | 814 | ~$1.93 |
| longmemeval-s | D: Retrieval Orchestrator | 100 | __% | __% | __% | __ | __ | $__ |
| longmemeval-s | E: Orchestrator + BM25 fallback | 100 | __% | __% | __% | __ | __ | $__ |

## Abstention

| corpus | Config | unanswerable n | correct-refusal | incorrect-refusal | hallucinated | false-refusal (on answerable) |
|---|---|---|---|---|---|---|
| longmemeval-s | D | __ | __ (__%) | __ | __ | __ / __ |
| longmemeval-s | E | __ | __ (__%) | __ | __ | __ / __ |

## One-hop coverage (Config D)

- Orchestrator returned ≥1 actionable op: __ / 100
- Orchestrator emitted <followup needed=true/>: __ / 100
- Orchestrator returned zero ops: __ / 100

## Binding interpretation

[D vs A delta. E vs D delta. Cite the ≥5-point threshold.]

## Caveats

- Map summaries are LongMemEval-S `firstSentence` extracts, not LLM-rewritten — if D's
  performance is borderline, an LLM-rewrite pass is the obvious next experiment.
- Single-corpus run (LongMemEval-S only). LoCoMo + internal are gated on per-question
  concurrency, tracked separately.
- LongMemEval-cleaned variant — see PR #66 report for the rationale + the literature gap.
- Judge is Grok 4.3 with abstention rules. We did not cross-judge against a second model.
- Orchestrator model is Haiku 4.5; c137 uses Grok 4.1 Fast. A model swap is an open
  follow-up if D wins on accuracy but loses on \$/correct-answer.
```

- [ ] **Step 4: Annotate the design doc**

In `docs/plans/memory-strata-design.md`:

(a) Add a Decision Record near the c137 prior-art section (around the existing "Phase 3B partial result" note, ~line 1317):

```markdown
### Decision Record — 2026-05-DD — Config D (Retrieval Orchestrator) outcome

- **Spike:** Config D (and E) exercised on n=100 LongMemEval-S sample. See `docs/plans/2026-05-DD-memory-strata-phase-3c-config-d-report.md`.
- **Result:** D scored X% accuracy vs A's 22.0%. Correct-refusal rate on unanswerable Qs: Y%.
- **Decision:** [D wins → adopt c137-style architecture | D loses → keep BM25-only | D ties → revisit with LLM-rewritten map summaries].
- **Next step:** [Wire Retrieval Orchestrator into production plugin in Phase 4 | re-spike with LLM-rewritten map | shelve].
```

(b) Replace the Progressive Enhancement Path's Level 3 line (around line 1342). Current:

```
LEVEL 3: Add Retrieval Orchestrator (one-hop XML planner)
         (Cheap-model LLM call before main agent; c137-style)
```

Replace with:

```
LEVEL 3: Add Retrieval Orchestrator (one-hop XML planner)
         (Cheap-model LLM call before main agent; c137-style)
         Phase 3C spike (2026-05-DD): D scored X% on LongMemEval-S.
         See docs/plans/2026-05-DD-memory-strata-phase-3c-config-d-report.md.
```

- [ ] **Step 5: Commit the report + design-doc annotation**

```bash
git add docs/plans/$(date +%Y-%m-%d)-memory-strata-phase-3c-config-d-report.md docs/plans/$(date +%Y-%m-%d)-memory-strata-phase-3c-config-*-only-raw.md docs/plans/memory-strata-design.md
git commit -m "docs(memory-strata): Phase 3C config-D spike report + design-doc annotation

Five-config table (A/B/C from PR #66 cited; D/E from this run).
Abstention table broken out for D and E. Decision record near the
c137 prior-art section captures the binding outcome and the next
step."
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "spike(memory-strata): Phase 3C — Config D (c137-style orchestrator) + abstention" --body "$(cat <<'EOF'
## Summary
- Implements Config D (c137-style Retrieval Orchestrator + system/map.md) and Config E (D + BM25 fallback) on the Strata bench harness.
- Adds abstention-aware judging (`abstained-correctly`, `abstained-incorrectly`) keyed off LongMemEval-S `_abs` question suffix.
- Re-runs against the 100-Q LongMemEval-S sample used in PR #66; report at `docs/plans/YYYY-MM-DD-memory-strata-phase-3c-config-d-report.md`.

## What changed
- `bench/map.ts` — per-corpus map generator (cached on disk).
- `bench/orchestrator.ts` — XML emitter (Haiku), regex parser, op runner.
- `bench/configs/d-map.ts`, `bench/configs/e-map-fts.ts` — drivers.
- `bench/judge.ts`, `bench/report.ts` — abstention extensions.
- `bench/corpora/longmemeval-s.ts` — `_abs` → `metadata.unanswerable`.
- `bench/cli.ts` — Haiku pricing + config wiring.

## Boundary review
- No new hooks/IPC actions. Bench-only — runs outside the production plugin surface.

## Test plan
- [ ] `pnpm --filter @ax/memory-strata test` — green
- [ ] `pnpm --filter @ax/memory-strata typecheck` — green
- [ ] Bench run completes with both reports generated and merged

Closes #67
EOF
)"
```

---

## Self-Review checklist (already applied; documented for traceability)

- **Spec coverage** — every numbered item in issue #67 is covered:
  - 1 Per-corpus map generator → Task 4
  - 2 Retrieval Orchestrator stage → Task 5
  - 3 Abstention-aware judge → Tasks 1, 2, 3
  - 4 Config D driver → Task 6
  - 5 Config E (optional) → Task 7
  - 6 Re-run + report → Task 9
- **Acceptance criteria** —
  - Config D runs end-to-end against LongMemEval-S, n=100 → Task 9.2
  - Report adds rows for D + E and abstention table → Task 3 + Task 9.3
  - A/B/C numbers from PR #66 reproduced or cited → Task 9.3
  - Level 3 annotated with spike outcome → Task 9.4
  - Decision Records entry if D substantially beats A → Task 9.4
- **No placeholders** — every code block contains real code; no `TBD`, `add appropriate X`, or `similar to Task N` references.
- **Type consistency** — `OrchestratorClient`, `OrchestratorOp`, `OrchestratorPlan`, `ConfigDOptions`, `ConfigEOptions` are defined once in their owning files and referenced by name elsewhere. `Verdict` has the 5 variants used in Tasks 2, 3, and 9. `runOps` is the consistent name in the orchestrator + both configs (not `executeOps`).
- **Out-of-scope, not snuck-in** — no production wire-in, no cross-corpus runs, no reranker re-spike, no map LLM-rewrite (that's an explicit deferral).
