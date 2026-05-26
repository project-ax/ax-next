# `@ax/memory-strata` Phase 2A implementation plan (Consolidator + `recent.md`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **first** half of Phase 2 — the **Consolidator** and `system/recent.md` regeneration. Inbox observations get clustered by subject, deduplicated, promoted to canonical `docs/<type>/<slug>.md` pages when confidence is at least 0.7, and `system/recent.md` is rebuilt at the end of each pass. **No retrieval, no BM25 index, no agent-facing tools** — those land in Phase 2B (PR-B).

**Architecture:** Adds the Consolidator (`consolidator.ts`) inside the existing `@ax/memory-strata` plugin. Subscribes to `chat:end` (in addition to the existing Observer subscription). Runs after the Observer with a per-agent debounce so a flurry of chats batches one consolidation pass. Pure host-side; no new IPC actions, no new database tables (Phase 2B will add the FTS index — for 2A everything lives on disk).

**Tech Stack:** TypeScript, pnpm monorepo, Node 22+, the existing `frontmatter.ts`/`paths.ts`/`sensitive-gate.ts` helpers from Phase 1, plus a small `slugify.ts`. No new external deps. Spec: `docs/plans/memory-strata-design.md` § "3. Consolidator" + § "system/recent.md Regeneration".

---

## Source of truth

- **Design spec:** `docs/plans/memory-strata-design.md` — the Consolidator pseudocode in § "3. Consolidator" (lines ~810–891), the confidence-threshold + decay rules in § "Confidence Threshold" (~893–901), the sensitive-content gate in § "Sensitive-Content Gate" (~903–911), the `recent.md` shape in § "system/recent.md Regeneration" (~913–921). Phase 2A implements exactly that subset; the LLM-driven `regenerate_summary`, contradiction LLM-resolver, and `compress_old_episodes` stay out (called out in YAGNI below).
- **Phase 1 plan & code:** `docs/plans/2026-05-10-memory-strata-phase-1-impl.md` — defines the on-disk substrate the Consolidator reads/writes. Existing helpers we reuse: `frontmatter.ts`, `paths.ts`, `sensitive-gate.ts`, `types.ts`. **Don't break the I9 ship-list test** — Phase 2A relaxes the forbidden-strings list (allows `Consolidator` now; still forbids `FTS5`/`RRF`/`vector` until 2B).
- **Project conventions:** `CLAUDE.md` — six invariants, half-wired-window policy, bug-fix policy, voice & tone for any user-facing strings.
- **Workspace contract:** `packages/workspace-protocol/src/types.ts` — memory writes go through the existing per-agent workspace fs that Phase 1 already uses (`<workspace>/permanent/memory/`).
- **Hook surface to subscribe to:** `chat:end` (already used by Phase 1's Observer). The Consolidator piggybacks on this same payload — no new event needed.
- **Memory:** `feedback_half_wired_window_pattern.md` (every new-plugin phase loads in CLI + k8s preset same PR; for Phase 2A the plugin is *already* loaded — the half-wired check becomes "Consolidator runs end-to-end against the kind cluster"), `feedback_yagni_check_in_plans.md` (the "load-bearing at MVP" filter ran on this plan — see YAGNI section below), `feedback_no_oauth_credentials.md` (sensitive-gate re-runs at promotion time as defense-in-depth — I7 extension).

## Invariants (audit trail per project pattern)

Numbered for cross-reference in PR review. Continues the I-numbering from Phase 1 (Phase 1 ended at I9).

- **I10 — Consolidator is async and bounded.** Same posture as Phase 1's Observer: `chat:end` returns to the bus immediately; consolidation runs in the background with a per-agent debounce window (default 5 s) so a back-to-back chat doesn't trigger overlapping passes. A pass that exceeds its hard timeout (default 60 s) is abandoned cleanly — partial state never lands on disk because every doc write is atomic (write-to-temp + rename).
- **I11 — Inbox→docs promotion re-runs the sensitive-gate.** Phase 1's sensitive-gate (I7) runs at *write-time*. Phase 2A re-runs it at *promotion-time* as defense-in-depth: an inbox file that somehow contains a credential (gate regression, manual edit, future Phase 1 bug) does NOT graduate to `docs/`. A test asserts that a tampered inbox file with an embedded fake key fails promotion and gets quarantined.
- **I12 — Single source of truth: `docs/` is canonical.** A fact lives in `docs/<type>/<slug>.md` exactly once. Multiple inbox observations about the same subject merge into a single doc; the inbox files are deleted (not copied) after promotion. The audit trail is git history (per design § "Tombstoning is `git rm`"). No parallel "consolidated" log exists.
- **I13 — `system/recent.md` is rebuildable, not canonical.** `recent.md` is regenerated end-to-end on every consolidation pass from `inbox/` + `docs/` + their frontmatter. It's a cached view, not a write target. A test asserts that deleting `recent.md` then running the Consolidator produces an identical file (modulo whitespace).
- **I14 — Inbox decay is bounded and visible.** Observations older than the decay window (default 14 d) without corroboration are removed. Each removal emits a structured log line (`memory_strata_inbox_decayed`) with the inbox file's id (NOT its body) so an operator can audit retention without reading content.
- **I15 — Phase 2A ship-list.** No retrieval, no BM25, no FTS5, no vector code, no agent-facing tools, no chat:start system-prompt augmentation. Test: `grep -r "FTS5\|RRF\|vector\|memory_search\|memory_read_section\|memory_note" packages/memory-strata/src/` returns zero matches in Phase 2A. (Phase 2B's plan removes those forbidden strings.)
- **I16 — No new hooks added (no boundary review needed).** Phase 2A reuses the existing `chat:end` subscription. If a Consolidator config knob ever needs to come *out* via a hook (e.g. for a tools admin panel to display retention policy), that's deferred — see YAGNI.

---

## Open decisions (resolve in Task 2A.0)

These three decisions block scaffolding. Resolve at the start of Phase 2A — preferably with a short `AskUserQuestion` if implementing autonomously.

### Decision A: Dedup similarity metric

| Option | Pros | Cons |
|---|---|---|
| **A1: Token-set Jaccard at or above 0.6** *(recommended)* | Pure heuristic, no LLM round-trip, deterministic, fast (<1 ms per pair). Good enough for the "we already wrote 'user prefers React' yesterday" case. | Misses semantic-equivalent rewrites ("user likes React" vs "user prefers React" — Jaccard ~0.5). Phase 2B's eval harness will tell us if this matters. |
| A2: LLM-judged equivalence | Catches paraphrases. | Doubles Consolidator cost; introduces latency variability; needs prompt design. Premature optimization for Phase 2A. |
| A3: Embedding cosine similarity | Catches semantic dupes; reusable for Phase 2B retrieval. | Pulls Phase 3's embedding-model decision forward; design doc explicitly defers vectors. |

**Recommendation: A1.** Cheapest thing that could work. If the soak data shows duplicate-fact bloat in `docs/`, Phase 2B's eval harness lets us decide whether to swap in A2 or A3 with measured ground truth.

### Decision B: Subject clustering strategy

| Option | Pros | Cons |
|---|---|---|
| **B1: Slugified `subject` field** *(recommended)* | The Observer already emits a `subject` field on every observation (Phase 1). Slugify (lowercase, replace non-alphanumeric runs with `-`, trim `-`), then group by exact-match slug. Zero LLM cost, deterministic. | A noisy Observer that emits `react` once and `react.js` next will make two clusters. We accept that tax for Phase 2A; the Consolidator's dedup catches the overlap when both clusters land in the same doc later. |
| B2: LLM cluster-by-subject pass | Robust to Observer noise. | LLM cost per consolidation pass. Defer until soak data shows B1 is actually causing problems. |

**Recommendation: B1.** Matches the design doc's "cluster by subject" pseudocode without inventing a new LLM call.

### Decision C: Consolidator trigger

| Option | Pros | Cons |
|---|---|---|
| **C1: `chat:end` with per-agent 5 s debounce** *(recommended)* | Reuses the existing subscription; no new scheduler. Debounce coalesces a back-to-back chat barrage into one pass. | Long-idle agents never run consolidation until their next chat; that's fine because nobody's reading their memory either. |
| C2: Cron-style separate scheduler | Decouples consolidation from chat lifetime; can run nightly. | New plugin surface (timer-driven hook), new config knob, new test surface. Not load-bearing at MVP. |

**Recommendation: C1.** Phase 5+ can add C2 if a soak test surfaces an idle-agent staleness problem.

---

## YAGNI audit (per `feedback_yagni_check_in_plans.md`)

Each line below is a feature in the design doc's Consolidator that I considered for Phase 2A and explicitly cut. Re-trigger conditions stated so we don't re-litigate.

- **`compress_old_episodes(older_than_days=30)`** — re-summarizing old episodes via LLM. Defer until episode docs actually exist in the wild and we can measure context bloat. Not load-bearing for the inbox→docs promotion path.
- **`update_folder_summaries()`** — Hermes-style `_summary.md` per folder. Defer until docs/ is large enough that listing a folder is meaningfully more expensive than reading its files. Probably Phase 4 or beyond.
- **LLM-driven `regenerate_summary` per doc** — when a doc grows from N facts to N+1, the summary should ideally be re-tightened. Phase 2A appends to the body but leaves the existing frontmatter `summary` field unchanged on append; the design doc's "summary-first injection" is a Phase 2B concern, so an out-of-date summary doesn't break anything in 2A. Re-trigger: when 2B's retrieval starts returning stale summaries, swap in an LLM rewrite.
- **LLM-driven contradiction resolver** — if two facts disagree, the design says "newer wins, with note". Phase 2A implements this naively (newer fact appended; old fact gets `superseded_by` link populated); no LLM judge. Re-trigger: when an evaluator complains about silent overwrites.
- **`memory_note` (manual save tool)** — Phase 2B owns the agent-facing tools.
- **Auto-inject summaries at chat:start** — Phase 2B owns context assembly.
- **Per-agent `confidence_threshold` config knob** — design says "configurable per agent". Phase 2A hardcodes 0.7. Re-trigger: when a real agent needs a different threshold and we have a place to store per-agent config (today: nowhere clean).
- **Manual force-promotion** — design lists this as inbox exit #3. No UI exists to trigger it; defer to credentials-admin-style admin route in a later phase.
- **Cross-reference / `[[wiki-links]]` extraction** — design § "6. Update cross-references". Defer until something actually consumes links (Phase 4's promoter, or Phase 2B's retrieval).

---

## File structure

### New files

```
packages/memory-strata/src/
  slugify.ts                  — pure helper: subject -> URL-safe slug
  doc-store.ts                — read/write docs/<type>/<slug>.md atomically; load list
  inbox-store.ts              — list/parse/delete inbox/*.md; rolls Phase 1's writeInboxObservation back into a typed read path
  cluster.ts                  — group inbox observations by slug(subject)
  dedup.ts                    — token-set Jaccard similarity (Decision A1)
  promotion.ts                — promotion gate: confidence >= 0.7 AND sensitive-gate clear
  recent.ts                   — regenerate system/recent.md from inbox + recent docs
  consolidator.ts             — orchestrates the pass: cluster -> dedup -> promote -> decay -> recent
  debounce.ts                 — per-agent debouncer wrapped around runConsolidation
  __tests__/
    slugify.test.ts
    doc-store.test.ts
    inbox-store.test.ts
    cluster.test.ts
    dedup.test.ts
    promotion.test.ts         — covers I11 (re-run sensitive-gate at promotion)
    recent.test.ts            — covers I13 (recent.md is rebuildable)
    consolidator.test.ts      — end-to-end pass on a synthetic inbox
    consolidator-decay.test.ts — covers I14 (inbox aging)
    consolidator-debounce.test.ts — covers I10 (back-to-back chats coalesce)
```

### Modified files

```
packages/memory-strata/src/types.ts        — add `DocFrontmatter`, `DocFile`, `ConsolidationResult` types; widen MemoryFileType to include `system/recent` and `docs/<category>`
packages/memory-strata/src/paths.ts        — add `docFile(category, slug)`, `categoryDir`, `recentFile()`
packages/memory-strata/src/plugin.ts       — register a SECOND chat:end subscriber for the Consolidator (debounced)
packages/memory-strata/src/__tests__/ship-list.test.ts — drop `Consolidator` from the forbidden-strings list; tighten remaining list (FTS5, RRF, vector, hnswlib, embeddings, memory_search, memory_read_section, memory_note still forbidden — see I15)
```

### Files deliberately NOT touched

- `packages/cli/src/main.ts`, `packages/preset-k8s/src/main.ts` — `@ax/memory-strata` is already loaded in both presets from Phase 1. No new plugin to wire up. The half-wired window for Phase 2A closes when the Consolidator runs end-to-end against the kind cluster (Task 2A.14 acceptance).
- `packages/llm-anthropic/*`, `packages/agents/*`, `packages/workspace-*`, `packages/conversations/*` — no new cross-plugin coordination.
- `packages/memory-strata/src/observer.ts` — Observer stays exactly as Phase 1 left it. The Consolidator runs *after* the Observer, never inside it.

---

## Phase 2A — Consolidator + `recent.md`

### Task 2A.0 — Resolve open decisions

- [ ] **Step 1: Read `docs/plans/memory-strata-design.md` § "3. Consolidator", § "Confidence Threshold", § "Sensitive-Content Gate", § "system/recent.md Regeneration"** (lines ~810–921). The Phase 2A contract is exactly that subset minus the YAGNI cuts above.
- [ ] **Step 2: Confirm Decisions A, B, C above.** If running autonomously, present them via `AskUserQuestion`. Deviations get recorded as `D5`/`D6`/`D7` in PR notes (continues the D-numbering from Phase 1's D4).
- [ ] **Step 3: Confirm sensitive-gate signature is reusable.** Open `packages/memory-strata/src/sensitive-gate.ts`; confirm `filterSensitive(text: string): FilterResult` is the API used by Task 2A.7 (it is, but verify it hasn't drifted).

### Task 2A.1 — `slugify` helper

**Files:**
- Create: `packages/memory-strata/src/slugify.ts`
- Test:   `packages/memory-strata/src/__tests__/slugify.test.ts`

- [ ] **Step 1: Write the failing test** — fixtures: `'React'` -> `'react'`, `'Project Alpha'` -> `'project-alpha'`, `'  spaces  '` -> `'spaces'`, `'foo/bar'` -> `'foo-bar'`, `'general'` -> `'general'`, empty/whitespace -> `'general'` (the Observer's default subject). Reject path-traversal: `'../../etc/passwd'` -> `'etc-passwd'` (no leading `-`, no `..`).

```typescript
import { describe, expect, it } from 'vitest';
import { slugify } from '../slugify.js';

describe('slugify', () => {
  it('lowercases and dasherizes', () => {
    expect(slugify('React')).toBe('react');
    expect(slugify('Project Alpha')).toBe('project-alpha');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('foo/bar baz')).toBe('foo-bar-baz');
    expect(slugify('  spaces  ')).toBe('spaces');
  });

  it('refuses path traversal', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
  });

  it('falls back to "general" on empty input', () => {
    expect(slugify('')).toBe('general');
    expect(slugify('   ')).toBe('general');
    expect(slugify('---')).toBe('general');
  });
});
```

- [ ] **Step 2: Run the test** — `pnpm --filter @ax/memory-strata test slugify` — expect FAIL with "module not found".
- [ ] **Step 3: Implement `slugify.ts`:**

```typescript
// Subject -> URL-safe slug. Used as the directory/file name for canonical
// docs (docs/<category>/<slug>.md). Defensive: an Observer that returns
// path-traversal characters in `subject` cannot cause us to write outside
// the memory tree.

const FALLBACK = 'general';

export function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const dasherized = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = dasherized.replace(/^-+|-+$/g, '');
  return trimmed.length === 0 ? FALLBACK : trimmed;
}
```

- [ ] **Step 4: Run test, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): slugify helper for doc filenames`.

### Task 2A.2 — Path conventions for `docs/` and `recent.md`

**Files:**
- Modify: `packages/memory-strata/src/paths.ts`, `packages/memory-strata/src/types.ts`
- Test:   covered by Task 2A.3's `doc-store.test.ts` end-to-end.

- [ ] **Step 1: Extend `paths.ts`.**

```typescript
// (Existing: MEMORY_ROOT, SYSTEM_DIR, INBOX_DIR, workspaceMemoryRoot,
//  systemFile, inboxFile.)

export const DOCS_DIR = `${MEMORY_ROOT}/docs`;

export type DocCategory =
  | 'entity'
  | 'preference'
  | 'decision'
  | 'episode'
  | 'general';

/**
 * `docs/<category>/<slug>.md`. Caller is responsible for slugifying the
 * subject; `slugify()` enforces no path traversal so a malformed slug
 * here is a programming error, not a security one.
 */
export function docFile(category: DocCategory, slug: string): string {
  return `${DOCS_DIR}/${category}/${slug}.md`;
}

export function categoryDir(category: DocCategory): string {
  return `${DOCS_DIR}/${category}`;
}

/** Cached view; regenerated end-to-end on every consolidation pass. */
export function recentFile(): string {
  return `${SYSTEM_DIR}/recent.md`;
}
```

- [ ] **Step 2: Widen `MemoryFileType` in `types.ts`** to include `'system/recent'` and the five `'docs/<category>'` shapes. Also add the `DocFrontmatter` and `DocFile` shapes (used by Task 2A.3). Body of the change:

```typescript
export type MemoryFileType =
  | 'system/agent'
  | 'system/user'
  | 'system/session'
  | 'system/recent'
  | 'inbox/observation'
  | 'docs/entity'
  | 'docs/preference'
  | 'docs/decision'
  | 'docs/episode'
  | 'docs/general';

export interface DocFrontmatter {
  /** `<category>/<slug>` — globally addressable across the agent's docs tree. */
  id: string;
  type:
    | 'docs/entity'
    | 'docs/preference'
    | 'docs/decision'
    | 'docs/episode'
    | 'docs/general';
  created: string;
  updated: string;
  /** Running max of merged observations' confidence. */
  confidence: number;
  /** Phase 2A never auto-pins docs; see YAGNI ('Promoter' is Phase 4). */
  pinned: false;
  /** Initial value: first observation's `summary`; not LLM-rewritten in 2A. */
  summary: string;
  subject: string;
  factType: string;
  /** Inbox observation ids merged into this doc, in order. */
  source_observations: string[];
  supersedes?: string[];
  superseded_by?: string;
}

export interface DocFile {
  /** workspace-relative path */
  path: string;
  frontmatter: DocFrontmatter;
  /** raw body text (everything after the closing `---` line). */
  body: string;
}
```

- [ ] **Step 3: Confirm by `pnpm --filter @ax/memory-strata build`** — types compile; nothing else changes yet.
- [ ] **Step 4: Commit:** `feat(memory-strata): docs/ + recent.md path helpers + doc types`.

### Task 2A.3 — `doc-store`: read/write canonical docs atomically

**Files:**
- Create: `packages/memory-strata/src/doc-store.ts`
- Test:   `packages/memory-strata/src/__tests__/doc-store.test.ts`

- [ ] **Step 1: Write the failing test.** Cover:
  - (a) `writeNewDoc` creates `permanent/memory/docs/preference/react.md` with canonical frontmatter (`id`, `type`, `summary`, `confidence`, `source_observations`).
  - (b) `readDoc` round-trips the same frontmatter + body.
  - (c) `appendFact` adds a bullet under `## Facts`, bumps `updated`, takes the running max of confidence, appends the new observation id to `source_observations`.
  - (d) Atomic write: simulate a failure of the temp-then-rename rename step and assert the final path does NOT exist.
  - (e) `listDocs` returns every doc under `docs/<category>/` across all categories.

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeNewDoc, appendFact, readDoc, listDocs,
} from '../doc-store.js';

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-doc-'));
});
afterEach(() => vi.restoreAllMocks());

describe('doc-store', () => {
  it('writes a new doc with canonical frontmatter', async () => {
    const result = await writeNewDoc({
      workspaceRoot,
      category: 'preference',
      slug: 'react',
      summary: 'User prefers React over Vue',
      subject: 'react',
      factType: 'preference',
      confidence: 0.85,
      sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: ['User prefers React over Vue'],
    });
    expect(result.path).toBe('permanent/memory/docs/preference/react.md');
    const text = await readFile(join(workspaceRoot, result.path), 'utf8');
    expect(text).toContain('id: preference/react');
    expect(text).toContain('type: docs/preference');
    expect(text).toContain('confidence: 0.85');
    expect(text).toContain('## Facts');
    expect(text).toContain('- User prefers React over Vue');
  });

  it('appends a fact and bumps `updated` + running-max confidence', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'preference', slug: 'react',
      summary: 'User prefers React', subject: 'react', factType: 'preference',
      confidence: 0.8, sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: ['User prefers React'],
    });
    await appendFact({
      workspaceRoot, category: 'preference', slug: 'react',
      newFact: 'User has used React for 5+ years',
      observationId: 'obs-2',
      confidence: 0.9,
      now: new Date('2026-05-10T13:00:00Z'),
    });
    const doc = await readDoc({
      workspaceRoot, category: 'preference', slug: 'react',
    });
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.confidence).toBe(0.9);
    expect(doc!.frontmatter.updated).toBe('2026-05-10T13:00:00.000Z');
    expect(doc!.frontmatter.source_observations).toEqual(['obs-1', 'obs-2']);
    expect(doc!.body).toContain('- User has used React for 5+ years');
  });

  it('atomic write: rename failure leaves no partial doc', async () => {
    await mkdir(join(workspaceRoot, 'permanent/memory/docs/preference'), {
      recursive: true,
    });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      writeNewDoc({
        workspaceRoot, category: 'preference', slug: 'react',
        summary: 's', subject: 'react', factType: 'preference',
        confidence: 0.8, sourceObservationIds: ['obs-1'],
        now: new Date('2026-05-10T12:00:00Z'),
        facts: ['f'],
      }),
    ).rejects.toThrow('disk full');
    await expect(
      readFile(join(workspaceRoot, 'permanent/memory/docs/preference/react.md')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('listDocs returns every doc under docs/', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'preference', slug: 'react',
      summary: 's', subject: 'react', factType: 'preference',
      confidence: 0.8, sourceObservationIds: ['o'],
      now: new Date('2026-05-10T12:00:00Z'), facts: ['f'],
    });
    await writeNewDoc({
      workspaceRoot, category: 'entity', slug: 'john',
      summary: 's', subject: 'john', factType: 'entity',
      confidence: 0.8, sourceObservationIds: ['o'],
      now: new Date('2026-05-10T12:00:00Z'), facts: ['f'],
    });
    const docs = await listDocs({ workspaceRoot });
    expect(docs.map((d) => d.frontmatter.id).sort())
      .toEqual(['entity/john', 'preference/react']);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL.**
- [ ] **Step 3: Implement `doc-store.ts`:**

```typescript
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { buildMarkdownFile } from './frontmatter.js';
import { categoryDir, docFile, type DocCategory } from './paths.js';
import type { DocFile, DocFrontmatter } from './types.js';

export interface WriteNewDocInput {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
  summary: string;
  subject: string;
  factType: string;
  confidence: number;
  sourceObservationIds: string[];
  now: Date;
  facts: string[];
}

export interface AppendFactInput {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
  newFact: string;
  observationId: string;
  confidence: number;
  now: Date;
}

export async function writeNewDoc(input: WriteNewDocInput): Promise<{ path: string }> {
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  const fm: DocFrontmatter = {
    id: `${input.category}/${input.slug}`,
    type: `docs/${input.category}` as DocFrontmatter['type'],
    created: input.now.toISOString(),
    updated: input.now.toISOString(),
    confidence: input.confidence,
    pinned: false,
    summary: input.summary,
    subject: input.subject,
    factType: input.factType,
    source_observations: input.sourceObservationIds,
  };
  const body = buildBody(input.facts);
  await mkdir(dirname(abs), { recursive: true });
  await atomicWriteUtf8(abs, buildMarkdownFile(fm, body));
  return { path: rel };
}

export async function appendFact(input: AppendFactInput): Promise<DocFile> {
  const existing = await readDoc({
    workspaceRoot: input.workspaceRoot,
    category: input.category,
    slug: input.slug,
  });
  if (existing === null) {
    throw new Error(`docNotFound: ${input.category}/${input.slug}`);
  }
  const fm: DocFrontmatter = {
    ...existing.frontmatter,
    updated: input.now.toISOString(),
    confidence: Math.max(existing.frontmatter.confidence, input.confidence),
    source_observations: [
      ...existing.frontmatter.source_observations,
      input.observationId,
    ],
  };
  const body = appendFactToBody(existing.body, input.newFact);
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  await atomicWriteUtf8(abs, buildMarkdownFile(fm, body));
  return { path: rel, frontmatter: fm, body };
}

export async function readDoc(input: {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
}): Promise<DocFile | null> {
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseDoc(rel, raw);
}

export async function listDocs(input: { workspaceRoot: string }): Promise<DocFile[]> {
  const out: DocFile[] = [];
  for (const cat of CATEGORIES) {
    const dirAbs = join(input.workspaceRoot, categoryDir(cat));
    let names: string[];
    try {
      names = await readdir(dirAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -'.md'.length);
      const doc = await readDoc({ workspaceRoot: input.workspaceRoot, category: cat, slug });
      if (doc !== null) out.push(doc);
    }
  }
  return out;
}

const CATEGORIES: DocCategory[] = ['entity', 'preference', 'decision', 'episode', 'general'];

function buildBody(facts: string[]): string {
  return ['# Doc', '', '## Facts', ...facts.map((f) => `- ${f}`), ''].join('\n');
}

function appendFactToBody(body: string, fact: string): string {
  // Append `- <fact>` under the `## Facts` section. If somehow no Facts
  // section exists (hand-edited), we add one.
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) {
    return [...lines, '', '## Facts', `- ${fact}`, ''].join('\n');
  }
  let insertAt = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) { insertAt = i; break; }
  }
  while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt--;
  const next = [...lines];
  next.splice(insertAt, 0, `- ${fact}`);
  return next.join('\n');
}

function parseDoc(relPath: string, raw: string): DocFile {
  // Hand-parse the canonical frontmatter (`---\n…\n---\n<body>`). gray-matter
  // would do this but we already have js-yaml in scope from frontmatter.ts.
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (m === null) throw new Error(`malformedDoc: ${relPath}`);
  const fm = yamlLoad(m[1]!) as DocFrontmatter;
  return { path: relPath, frontmatter: fm, body: m[2]! };
}

async function atomicWriteUtf8(absPath: string, contents: string): Promise<void> {
  // Write to a sibling temp file then rename. POSIX rename is atomic on
  // the same filesystem; this prevents a crash mid-write from leaving
  // a partially-written doc that our parser would later choke on.
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, absPath);
}
```

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): doc-store with atomic write + frontmatter round-trip`.

### Task 2A.4 — `inbox-store`: list / parse / delete inbox files

**Files:**
- Create: `packages/memory-strata/src/inbox-store.ts`
- Test:   `packages/memory-strata/src/__tests__/inbox-store.test.ts`

- [ ] **Step 1: Write the failing test.** Cover: (a) `listInbox` returns every `inbox/*.md` parsed back into `{path, frontmatter, body}`, (b) parsing recovers the same `MemoryFrontmatter` shape Phase 1's Observer wrote, (c) `deleteInboxFile` removes a single file, (d) graceful empty result when `inbox/` doesn't exist.
- [ ] **Step 2: Run test, expect FAIL.**
- [ ] **Step 3: Implement `inbox-store.ts`:**

```typescript
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { INBOX_DIR } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

export interface InboxFile {
  /** workspace-relative */
  path: string;
  frontmatter: MemoryFrontmatter;
  body: string;
}

export async function listInbox(workspaceRoot: string): Promise<InboxFile[]> {
  const dir = join(workspaceRoot, INBOX_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: InboxFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const rel = `${INBOX_DIR}/${name}`;
    const raw = await readFile(join(workspaceRoot, rel), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (m === null) continue; // malformed; skip rather than crash the pass.
    const frontmatter = yamlLoad(m[1]!) as MemoryFrontmatter;
    out.push({ path: rel, frontmatter, body: m[2]! });
  }
  return out;
}

export async function deleteInboxFile(
  workspaceRoot: string,
  inboxPath: string,
): Promise<void> {
  await unlink(join(workspaceRoot, inboxPath));
}
```

- [ ] **Step 4: Run test, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): inbox-store reads + deletes inbox files`.

### Task 2A.5 — `cluster`: group by `slug(subject)`

**Files:**
- Create: `packages/memory-strata/src/cluster.ts`
- Test:   `packages/memory-strata/src/__tests__/cluster.test.ts`

- [ ] **Step 1: Write the failing test.** Inputs: 5 inbox files — three about `'react'`, two about `'project alpha'`. Output: 2 clusters. A cluster missing `subject` falls into `'general'`. The cluster's `category` is the most common `factType` across its observations.
- [ ] **Step 2: Implement `cluster.ts`:**

```typescript
import type { InboxFile } from './inbox-store.js';
import { slugify } from './slugify.js';

export type ClusterCategory =
  | 'entity'
  | 'preference'
  | 'decision'
  | 'episode'
  | 'general';

export interface Cluster {
  /** Slug of the subject; used as the doc filename. */
  slug: string;
  /** Doc category — the most common factType across the cluster's observations. */
  category: ClusterCategory;
  observations: InboxFile[];
}

export function clusterBySubject(inbox: InboxFile[]): Cluster[] {
  const buckets = new Map<string, InboxFile[]>();
  for (const f of inbox) {
    const slug = slugify(f.frontmatter.subject ?? '');
    const list = buckets.get(slug) ?? [];
    list.push(f);
    buckets.set(slug, list);
  }
  const out: Cluster[] = [];
  for (const [slug, observations] of buckets) {
    out.push({ slug, category: pickCategory(observations), observations });
  }
  return out;
}

function pickCategory(obs: InboxFile[]): ClusterCategory {
  const counts = new Map<ClusterCategory, number>();
  for (const o of obs) {
    const cat = (o.frontmatter.factType ?? 'general') as ClusterCategory;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: ClusterCategory = 'general';
  let bestCount = -1;
  for (const [cat, n] of counts) {
    if (n > bestCount) { best = cat; bestCount = n; }
  }
  return best;
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): cluster inbox observations by subject`.

### Task 2A.6 — `dedup`: token-set Jaccard similarity

**Files:**
- Create: `packages/memory-strata/src/dedup.ts`
- Test:   `packages/memory-strata/src/__tests__/dedup.test.ts`

- [ ] **Step 1: Write the failing test.** Fixtures:
  - `'User prefers React'` vs `'user prefers react'` -> similarity 1.0 (case-insensitive)
  - `'User prefers React'` vs `'User prefers Vue'` -> ~0.66 (2/3 of {prefers,user} after stopwords)
  - `'User prefers React'` vs `'Project ships Friday'` -> ~0.0
  - threshold default 0.6 -> first two are dupes, third is not
- [ ] **Step 2: Implement `dedup.ts`:**

```typescript
// Token-set Jaccard similarity (Decision A1). Pure heuristic; no LLM.
// Tokens are lowercased alphanumeric runs; stopwords stripped to keep
// `the`, `a`, `of` from inflating overlap on short facts.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
  'to', 'was', 'were', 'with',
]);

export interface DedupOptions {
  /** Default 0.6 — two facts at or above this score are considered dupes. */
  threshold?: number;
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0]!;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const tok of a) if (b.has(tok)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function isDupe(
  candidate: string,
  existing: string[],
  options: DedupOptions = {},
): boolean {
  const threshold = options.threshold ?? 0.6;
  const candTokens = tokenize(candidate);
  for (const e of existing) {
    if (jaccard(candTokens, tokenize(e)) >= threshold) return true;
  }
  return false;
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): token-set Jaccard dedup`.

### Task 2A.7 — `promotion`: confidence + sensitive-gate (covers I11)

**Files:**
- Create: `packages/memory-strata/src/promotion.ts`
- Test:   `packages/memory-strata/src/__tests__/promotion.test.ts`

- [ ] **Step 1: Write the failing test (covers I11):**
  - Fixture A — confidence 0.85, body "User prefers React" -> `{ promote: true }`.
  - Fixture B — confidence 0.5 -> `{ promote: false, reason: 'low-confidence' }`.
  - Fixture C — confidence 0.85, body contains a fake API key shaped like `sk-ant-XXXXXXXXXXXXXXXXXXXXX` -> `{ promote: false, reason: 'sensitive', kinds: ['anthropic-api-key'] }`. **This is the I11 regression fixture: even if the inbox somehow has a credential, it does NOT graduate.**
- [ ] **Step 2: Implement `promotion.ts`:**

```typescript
import { filterSensitive, type RejectionKind } from './sensitive-gate.js';
import type { InboxFile } from './inbox-store.js';

export const CONFIDENCE_THRESHOLD = 0.7;

export type PromotionDecision =
  | { promote: true }
  | { promote: false; reason: 'low-confidence' }
  | { promote: false; reason: 'sensitive'; kinds: RejectionKind[] };

export function decidePromotion(file: InboxFile): PromotionDecision {
  if ((file.frontmatter.confidence ?? 0) < CONFIDENCE_THRESHOLD) {
    return { promote: false, reason: 'low-confidence' };
  }
  // Defense-in-depth: sensitive-gate runs at write-time (Phase 1, I7) AND
  // at promotion-time (Phase 2A, I11). If a regression in the Phase 1
  // gate ever lets a credential into inbox/, this catches it before the
  // fact graduates to docs/, where it would be cached and re-loaded into
  // the agent's context next turn.
  const haystack = `${file.frontmatter.summary ?? ''}\n${file.body}`;
  const gate = filterSensitive(haystack);
  if (!gate.kept) {
    return {
      promote: false,
      reason: 'sensitive',
      kinds: gate.rejections.map((r) => r.kind),
    };
  }
  return { promote: true };
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): promotion gate (confidence + sensitive re-run)`.

### Task 2A.8 — `recent.md` regenerator (covers I13)

**Files:**
- Create: `packages/memory-strata/src/recent.ts`
- Test:   `packages/memory-strata/src/__tests__/recent.test.ts`

- [ ] **Step 1: Write the failing test (covers I13):**
  - Fixture: a workspace with 3 inbox observations (one episode w/ open thread, two preferences) and 5 docs (varying `updated` times).
  - Assert: `regenerateRecent({workspaceRoot, now})` writes `permanent/memory/system/recent.md` containing 3 sections — `## Open Threads`, `## Active Projects`, `## Recent Changes`.
  - I13 assertion: delete the file, run again, the new content equals the old (deterministic).

- [ ] **Step 2: Implement `recent.ts`:**

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMarkdownFile } from './frontmatter.js';
import { listInbox } from './inbox-store.js';
import { listDocs } from './doc-store.js';
import { recentFile } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

const RECENT_DOC_LIMIT = 5;
const ACTIVE_PROJECTS_WINDOW_DAYS = 7;

export async function regenerateRecent(input: {
  workspaceRoot: string;
  now: Date;
}): Promise<{ path: string }> {
  const inbox = await listInbox(input.workspaceRoot);
  const docs = await listDocs({ workspaceRoot: input.workspaceRoot });

  // Open Threads: inbox items whose factType is `episode` or `decision`
  // (proxy for "in-progress work" per design § "system/recent.md").
  const openThreads = inbox
    .filter(
      (i) =>
        i.frontmatter.factType === 'episode' ||
        i.frontmatter.factType === 'decision',
    )
    .map((i) => `- [${i.frontmatter.id}] ${i.frontmatter.summary}`)
    .sort();

  // Active Projects: distinct entity-doc subjects updated in the last 7 days.
  const cutoff = new Date(
    input.now.getTime() - ACTIVE_PROJECTS_WINDOW_DAYS * 86_400_000,
  );
  const projects = docs
    .filter((d) => d.frontmatter.type === 'docs/entity')
    .filter((d) => new Date(d.frontmatter.updated) >= cutoff)
    .map((d) => `- ${d.frontmatter.subject} — ${d.frontmatter.summary}`)
    .sort();

  // Recent Changes: 5 most-recently-updated docs.
  const recent = [...docs]
    .sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
    .slice(0, RECENT_DOC_LIMIT)
    .map((d) => `- ${d.frontmatter.id} (${d.frontmatter.updated})`);

  const fm: MemoryFrontmatter = {
    id: 'recent',
    type: 'system/recent',
    created: input.now.toISOString(),
    confidence: 1.0,
    pinned: true,
    summary:
      'Cached view of open threads, active projects, recent changes — regenerated each consolidation pass.',
    event_time: input.now.toISOString(),
    recorded_at: input.now.toISOString(),
  };
  const body = [
    '# Recent',
    '',
    '## Open Threads',
    ...(openThreads.length > 0 ? openThreads : ['_None._']),
    '',
    '## Active Projects',
    ...(projects.length > 0 ? projects : ['_None._']),
    '',
    '## Recent Changes',
    ...(recent.length > 0 ? recent : ['_None._']),
    '',
  ].join('\n');

  const rel = recentFile();
  const abs = join(input.workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return { path: rel };
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): regenerate system/recent.md from inbox + docs`.

### Task 2A.9 — `consolidator`: orchestration

**Files:**
- Create: `packages/memory-strata/src/consolidator.ts`
- Test:   `packages/memory-strata/src/__tests__/consolidator.test.ts`

- [ ] **Step 1: Write the failing end-to-end test.** Fixture: a workspace with 4 inbox observations:
  - 2 about `'react'` (both confidence 0.85, similar text but not identical, factType `preference`)
  - 1 about `'project-alpha'` (confidence 0.5 — too low to promote)
  - 1 about `'fake-credentials'` whose body smuggles `sk-ant-XXXXXXXXXXXXXXXXXXXXX` (confidence 0.9 — should be quarantined by I11)

  Assert after `runConsolidation({workspaceRoot, now})`:
  - `docs/preference/react.md` exists with both react facts merged (`source_observations` length 2).
  - `docs/general/project-alpha.md` does NOT exist; the inbox file remains for the next pass.
  - The credential inbox file is **moved** to `permanent/memory/quarantine/<original-name>` (not deleted; we keep it for forensics) — and a `memory_strata_promotion_quarantined` log line was emitted.
  - The two react inbox files are deleted.
  - `system/recent.md` exists.
  - The result object reports `{ promoted: 2, dupesMerged: 0, quarantined: 1, leftInInbox: 1, decayed: 0 }` (decayed=0 because all observations are fresh).

- [ ] **Step 2: Implement `consolidator.ts`:**

```typescript
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clusterBySubject } from './cluster.js';
import { isDupe } from './dedup.js';
import {
  appendFact, listDocs, readDoc, writeNewDoc,
} from './doc-store.js';
import { deleteInboxFile, listInbox } from './inbox-store.js';
import { decidePromotion } from './promotion.js';
import { regenerateRecent } from './recent.js';
import { MEMORY_ROOT } from './paths.js';

export interface ConsolidationLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface ConsolidationInput {
  workspaceRoot: string;
  now: Date;
  logger?: ConsolidationLogger;
}

export interface ConsolidationResult {
  promoted: number;
  dupesMerged: number;
  quarantined: number;
  leftInInbox: number;
  decayed: number;
}

const QUARANTINE_DIR = `${MEMORY_ROOT}/quarantine`;
const DECAY_DAYS = 14;

export async function runConsolidation(
  input: ConsolidationInput,
): Promise<ConsolidationResult> {
  const log = input.logger ?? noopLogger();
  const { decayed } = await decayInbox(input.workspaceRoot, input.now, log);

  const inbox = await listInbox(input.workspaceRoot);
  const clusters = clusterBySubject(inbox);

  let promoted = 0;
  let dupesMerged = 0;
  let quarantined = 0;
  let leftInInbox = 0;

  for (const cluster of clusters) {
    const existing = await readDoc({
      workspaceRoot: input.workspaceRoot,
      category: cluster.category,
      slug: cluster.slug,
    });
    const existingFacts = existing ? extractFactsFromBody(existing.body) : [];

    let docCreated = existing !== null;
    const factsInDoc = [...existingFacts];

    for (const obs of cluster.observations) {
      const decision = decidePromotion(obs);
      if (!decision.promote) {
        if (decision.reason === 'low-confidence') {
          leftInInbox += 1;
          continue;
        }
        await quarantineFile(input.workspaceRoot, obs.path);
        log.warn('memory_strata_promotion_quarantined', {
          inboxPath: obs.path,
          kinds: decision.kinds,
        });
        quarantined += 1;
        continue;
      }
      if (isDupe(obs.frontmatter.summary ?? '', factsInDoc)) {
        dupesMerged += 1;
        await deleteInboxFile(input.workspaceRoot, obs.path);
        continue;
      }

      if (!docCreated) {
        await writeNewDoc({
          workspaceRoot: input.workspaceRoot,
          category: cluster.category,
          slug: cluster.slug,
          summary: obs.frontmatter.summary ?? '',
          subject: obs.frontmatter.subject ?? cluster.slug,
          factType: obs.frontmatter.factType ?? 'general',
          confidence: obs.frontmatter.confidence ?? 0,
          sourceObservationIds: [obs.frontmatter.id],
          now: input.now,
          facts: [obs.frontmatter.summary ?? ''],
        });
        docCreated = true;
      } else {
        await appendFact({
          workspaceRoot: input.workspaceRoot,
          category: cluster.category,
          slug: cluster.slug,
          newFact: obs.frontmatter.summary ?? '',
          observationId: obs.frontmatter.id,
          confidence: obs.frontmatter.confidence ?? 0,
          now: input.now,
        });
      }
      factsInDoc.push(obs.frontmatter.summary ?? '');
      await deleteInboxFile(input.workspaceRoot, obs.path);
      promoted += 1;
    }
  }

  await regenerateRecent({ workspaceRoot: input.workspaceRoot, now: input.now });

  log.info('memory_strata_consolidation_complete', {
    promoted, dupesMerged, quarantined, leftInInbox, decayed,
  });
  return { promoted, dupesMerged, quarantined, leftInInbox, decayed };
}

async function decayInbox(
  workspaceRoot: string,
  now: Date,
  log: ConsolidationLogger,
): Promise<{ decayed: number }> {
  const inbox = await listInbox(workspaceRoot);
  const cutoffMs = now.getTime() - DECAY_DAYS * 86_400_000;
  let decayed = 0;
  for (const f of inbox) {
    const ts = new Date(f.frontmatter.created).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts > cutoffMs) continue;
    await deleteInboxFile(workspaceRoot, f.path);
    log.info('memory_strata_inbox_decayed', {
      id: f.frontmatter.id,
      ageDays: Math.round((now.getTime() - ts) / 86_400_000),
    });
    decayed += 1;
  }
  return { decayed };
}

async function quarantineFile(workspaceRoot: string, inboxPath: string): Promise<void> {
  const name = inboxPath.split('/').pop()!;
  const dest = `${QUARANTINE_DIR}/${name}`;
  const absSrc = join(workspaceRoot, inboxPath);
  const absDest = join(workspaceRoot, dest);
  await mkdir(dirname(absDest), { recursive: true });
  await rename(absSrc, absDest);
}

function extractFactsFromBody(body: string): string[] {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
  }
  return out;
}

function noopLogger(): ConsolidationLogger {
  return { info: () => {}, warn: () => {} };
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): consolidator orchestration (cluster -> dedup -> promote -> quarantine -> decay -> recent)`.

### Task 2A.10 — Inbox decay regression test (covers I14)

**Files:**
- Test:   `packages/memory-strata/src/__tests__/consolidator-decay.test.ts`

> Note: The decay logic itself ships as part of Task 2A.9. This task adds the dedicated regression test that proves the I14 audit-log line.

- [ ] **Step 1: Write the failing test.** Fixture: 3 inbox files with backdated `created` frontmatter — one 15 days ago (must decay), one 13 days ago (keep), one 1 day ago (keep). Capture log lines via a `ConsolidationLogger` spy. Assert the 15-day-old file is deleted from disk AND a `memory_strata_inbox_decayed` log line fired with the file's id.
- [ ] **Step 2: Run test, expect PASS** (decay code already shipped in 2A.9).
- [ ] **Step 3: Commit:** `test(memory-strata): I14 regression — inbox decay emits audit log`.

### Task 2A.11 — Per-agent debouncer (covers I10)

**Files:**
- Create: `packages/memory-strata/src/debounce.ts`
- Test:   `packages/memory-strata/src/__tests__/consolidator-debounce.test.ts`

- [ ] **Step 1: Write the failing test (covers I10).** Use vitest's fake timers. Schedule three calls in quick succession; advance time past the debounce window; verify exactly one execution; schedule another and advance again; verify a second execution.
- [ ] **Step 2: Implement `debounce.ts`:**

```typescript
// Per-agent debouncer for the Consolidator. Multiple chat:end events for
// the same agent within DEBOUNCE_MS coalesce into a single consolidation
// pass. A fresh event after the window starts a new pass.

export interface Debouncer {
  schedule(agentId: string, run: () => Promise<void>): void;
  /** For tests + shutdown: drain any pending timers. */
  flush(): Promise<void>;
}

interface PendingSlot {
  timer: NodeJS.Timeout;
  /** The latest scheduled runner — replaces any earlier one within the window. */
  run: () => Promise<void>;
}

export function createDebouncer(windowMs: number): Debouncer {
  const slots = new Map<string, PendingSlot>();
  const inflight = new Map<string, Promise<void>>();

  const fire = (agentId: string): void => {
    const slot = slots.get(agentId);
    if (slot === undefined) return;
    slots.delete(agentId);
    const p = slot.run().catch(() => {
      // Subscriber posture: never throw out of a debounce timer.
    });
    inflight.set(agentId, p);
    void p.finally(() => inflight.delete(agentId));
  };

  return {
    schedule(agentId, run) {
      const existing = slots.get(agentId);
      if (existing !== undefined) clearTimeout(existing.timer);
      const timer = setTimeout(() => fire(agentId), windowMs);
      timer.unref?.();
      slots.set(agentId, { timer, run });
    },
    async flush() {
      // Force-fire any pending timers immediately (preserve coalesced semantics).
      const pendingIds = [...slots.keys()];
      for (const id of pendingIds) {
        const slot = slots.get(id);
        if (slot === undefined) continue;
        clearTimeout(slot.timer);
        fire(id);
      }
      await Promise.all(inflight.values());
    },
  };
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit:** `feat(memory-strata): per-agent debouncer for Consolidator`.

### Task 2A.12 — Wire Consolidator into `chat:end` (close window)

**Files:**
- Modify: `packages/memory-strata/src/plugin.ts`
- Create: `packages/memory-strata/src/timeout.ts` (factored out of `observer.ts`'s existing helper)
- Test:   `packages/memory-strata/src/__tests__/plugin.test.ts` (extend existing)

- [ ] **Step 1: Factor out `raceTimeout` from `observer.ts`** into a new `timeout.ts` so both Observer and Consolidator share it. Re-export from `observer.ts` if any external test imports it (search before editing). Verify all existing tests still pass.
- [ ] **Step 2: Write the failing test.** Extend the existing `plugin.test.ts`: register the plugin with a fake bus, fire `chat:end` twice within the debounce window, call `debouncer.flush()`, assert the Consolidator's underlying functions ran exactly once (use a spy on `runConsolidation` or assert the on-disk side effects).
- [ ] **Step 3: Modify `plugin.ts`** — add a SECOND `chat:end` subscriber for the Consolidator, debounced + bounded. Sketch:

```typescript
// Add to MemoryStrataConfig:
export interface MemoryStrataConfig {
  llmCallHook?: string;
  observerTimeoutMs?: number;
  /** Default 5_000 ms (I10). */
  consolidatorDebounceMs?: number;
  /** Default 60_000 ms. Hard ceiling on a consolidation pass. */
  consolidatorTimeoutMs?: number;
}

// In createMemoryStrataPlugin (after the existing Observer wiring):
const debouncer = createDebouncer(cfg.consolidatorDebounceMs ?? 5_000);

bus.subscribe<ChatEndPayload>('chat:end', PLUGIN_NAME, async (ctx) => {
  debouncer.schedule(ctx.agentId, async () => {
    try {
      await raceTimeout(
        runConsolidation({
          workspaceRoot: ctx.workspace.rootPath,
          now: new Date(),
          logger: {
            info: (event, fields) => ctx.logger.info(event, fields),
            warn: (event, fields) => ctx.logger.warn(event, fields),
          },
        }),
        cfg.consolidatorTimeoutMs ?? 60_000,
      );
    } catch (err) {
      ctx.logger.warn('memory_strata_consolidator_failed', {
        err: err instanceof Error ? err : new Error(String(err)),
        agentId: ctx.agentId,
      });
    }
  });
  return undefined;
});

// In Plugin.shutdown (NEW — add to the returned Plugin object):
async shutdown() {
  await debouncer.flush();
},
```

> The existing `chat:end` subscriber for the Observer stays unchanged. The bus dispatches to both subscribers; their independent fire-and-forget posture means the Consolidator doesn't wait on the Observer's LLM call (good — they're on different cadences).

- [ ] **Step 4: Run all memory-strata tests, expect PASS.**
- [ ] **Step 5: Commit:** `feat(memory-strata): wire Consolidator to chat:end (debounced, bounded)`.

### Task 2A.13 — Update ship-list invariant test

**Files:**
- Modify: `packages/memory-strata/src/__tests__/ship-list.test.ts`

- [ ] **Step 1:** Drop `Consolidator` and `Retriever` from the forbidden-strings list — `Consolidator` ships in this PR; `Retriever` lands in 2B (the 2B plan will retire it next). Keep forbidden in 2A:

```
FTS5, RRF, vector, hnswlib, embeddings,
memory_search, memory_read_section, memory_note,
tool:register
```

- [ ] **Step 2:** Run `pnpm --filter @ax/memory-strata test ship-list`, expect PASS.
- [ ] **Step 3: Commit:** `test(memory-strata): update ship-list for Phase 2A scope`.

### Task 2A.14 — Manual acceptance against kind cluster

- [ ] **Step 1: Run `pnpm build && pnpm test`** at the workspace root. All green.
- [ ] **Step 2: `make dev-fast`** to push the host plugin to the kind cluster (per `project_kind_fast_loop_spa_only.md`, host code changes need a full image rebuild — use `make dev` if dist-web-only is insufficient).
- [ ] **Step 3: Walk the acceptance criteria** (see "Acceptance criteria" section below) end-to-end. Use the `k8s-acceptance-loop` skill if needed.
- [ ] **Step 4: Bug-fix policy check** — every bug found gets a regression test before the fix lands (per CLAUDE.md §"Bug Fix Policy").

### Task 2A.15 — PR notes + open

- [ ] **Step 1:** Run full suite and lint: `pnpm build && pnpm test && pnpm lint`. All green.
- [ ] **Step 2: Boundary review** — Phase 2A adds **no new hooks**, so no boundary-review form needed (per CLAUDE.md: "Patches that only change a plugin's internal implementation … don't need boundary review"). State this explicitly in PR notes.
- [ ] **Step 3: PR notes prep:**

```markdown
## Phase 2A — `@ax/memory-strata` Consolidator + recent.md

### What ships
- Consolidator: clusters inbox observations by subject, dedupes via Jaccard, promotes >=0.7 confidence facts to `docs/<category>/<slug>.md`, deletes consumed inbox files
- Sensitive-gate runs again at promotion-time (defense-in-depth, I11)
- Inbox decay: items older than 14 d without corroboration are removed (logged with id, NOT body)
- `system/recent.md` regenerated end-to-end on every pass
- Quarantine: sensitive promotions are MOVED to `permanent/memory/quarantine/` (not deleted) for forensics
- Wired into `chat:end` with a 5 s per-agent debounce + 60 s hard timeout

### What does NOT ship (Phase 2B / 2C+)
- BM25/FTS5 indexer (Phase 2B)
- `memory_search` / `memory_read_section` / `memory_note` agent tools (Phase 2B)
- Auto-injection of summaries into the system prompt (Phase 2B)
- LLM-driven summary regeneration on doc append (deferred — see YAGNI)
- LLM-driven contradiction resolution (deferred — see YAGNI)
- Vector / hybrid retrieval (Phase 3 spike)
- Folder summaries (Hermes-style) (deferred)

### Invariants audit (continues from Phase 1's I9)
- I10 (async + bounded): VERIFIED by `consolidator-debounce.test.ts`
- I11 (sensitive-gate at promotion): VERIFIED by `promotion.test.ts` Fixture C + `consolidator.test.ts` quarantine assertion
- I12 (single source of truth: docs/): VERIFIED by `consolidator.test.ts` (inbox files deleted; one doc per subject)
- I13 (recent.md rebuildable): VERIFIED by `recent.test.ts`
- I14 (inbox decay visible): VERIFIED by `consolidator-decay.test.ts`
- I15 (Phase 2A ship-list): VERIFIED by `ship-list.test.ts`
- I16 (no new hooks): VERIFIED — boundary-review N/A

### Half-wired window: CLOSED in this PR
The plugin was already loaded in CLI + k8s presets from Phase 1; this PR closes the window for Phase 2A by demonstrating Consolidator runs end-to-end against the kind cluster (manual acceptance step).

### Deviations from plan
[list any D5..Dn from open decisions]
```

- [ ] **Step 4: Open the PR.** Title: `feat: @ax/memory-strata Phase 2A (Consolidator + recent.md)`.

---

## Acceptance criteria for Phase 2A

A user (or `k8s-acceptance-loop`) running ax-next against a kind cluster:

1. Creates a new agent. Sends 3 messages, all referencing **the same preference** ("I prefer React"). After Observer + Consolidator (wait ~6 s for debounce + LLM round-trip), `<workspace>/permanent/memory/docs/preference/react.md` exists with **one** doc whose `source_observations` list has at least 2 entries (the Observer may produce 1 obs per chat -> 3 obs -> all merge).
2. The original `inbox/<ISO>.md` files for those react observations no longer exist (they were consumed).
3. `<workspace>/permanent/memory/system/recent.md` exists and lists the react doc under "Recent Changes".
4. Sends a message containing a fake API key. Wait for consolidation. The credential ends up under `permanent/memory/quarantine/`, NOT under `docs/`. A `grep -r "sk-ant-" permanent/memory/docs/` returns zero matches.
5. Manually backdate an inbox file to 15 days ago (edit its `created:` frontmatter directly). Trigger a consolidation pass (send any chat). The backdated file is deleted; the operator log shows `memory_strata_inbox_decayed`.
6. Sends two chats back-to-back (less than 5 s apart). Operator log shows ONE `memory_strata_consolidation_complete` line, not two — debounce coalesced.
7. Restarts the agent. All `docs/` and `system/recent.md` survive (workspace-permanent semantics).
8. Creates a second agent in the same workspace. Their `docs/` trees are disjoint (extends Phase 1's I8 to the new tier).

If all eight pass, Phase 2A is done. Phase 2B picks up retrieval + tools.

## Verification

```bash
pnpm --filter @ax/memory-strata build
pnpm --filter @ax/memory-strata test
pnpm test
pnpm lint
make dev-fast    # or `make dev` if host code changed
# then walk the 8-step acceptance criteria above
```

If any acceptance step fails, fix-and-add-a-test per CLAUDE.md §"Bug Fix Policy" before marking Phase 2A done.
