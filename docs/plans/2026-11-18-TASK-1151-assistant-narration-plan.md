# TASK-1151: The Assistant's Own Narration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The memory observer stops storing two kinds of `assistant` fact: narration of the agent's own tool actions (`created_artifact`, `ran_tests`, …) and statements about its own limits (`stated_limitation`, …). It keeps the agent's identity and standing rules, and the content the agent supplied. A one-off script deletes the rows already saved. It runs dry by default and prints counts only.

**Architecture:** The rule extends `isAgentContextSelfReport` in `packages/memory/src/self-report.ts`. The observer already calls that function from `toStatements` and counts what it drops as `selfReports`. The extension adds a new `classifyAgentFact` that names each agent-subject fact's class. The cleanup, `packages/memory/scripts/clean-assistant-narration.mjs`, uses only Node built-ins. It is piped into the host pod right after `self-report.ts` and run with `node --input-type=module-typescript -`, so it deletes with the very function the observer uses. It edits the SQLite facts file the deployed `memory` preset uses: `memory_facts_v1`, plus its FTS5 and vec0 shadow tables, all in one transaction.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:sqlite`, sqlite-vec 0.1.9 (loadable extension), vitest, and `@ax/memory-facts-sqlite` (already a devDependency of `@ax/memory`, used only in tests).

**Spec:** the TASK-1151 card, plus `.claude/memory/decisions/2026-11-18-TASK-1151.md`. Read every row of that file, especially "Trap for the re-plan", "Scope answered: option B" and the seven re-plan rows after it. Scope (Vinay, option B): keep identity and standing rules, AND the content the agent supplied (`recommended`, `listed_*`, `provided_*`, `stated`, …). Drop only action narration and capability statements.

## Global Constraints

- **Pinned files.** Do not edit `packages/memory/src/observer.ts`, `packages/memory/src/plugin.ts`, `packages/memory/src/capture.ts` or `packages/channel-slack/src/router.ts`, not even a comment. TASK-1146's shard quotes them by blob sha, and `scripts/__tests__/memory-quoted-blob-shas.test.js` fails on any change. Nobody on a card may fix that row.
- **How to cite mutation runs.** When you record a mutation run in the shard, cite files as `` `path` as of commit `<sha>` ``, never as `` `path` blob `<sha>` ``. The blob form pins the file for every later card.
- **`self-report.ts` stays import-free** and uses only erasable TypeScript: type annotations, `as`, `readonly`. No `enum`, no `namespace`, no parameter properties. The cleanup pipes this file into `node --input-type=module-typescript`.
- **No new public exports.** `packages/memory/src/index.ts` re-exports nothing new.
- **The extraction prompt doesn't change** (`extraction-prompt.ts`, fingerprint `e7466bf4`).
- **No surface changes.** No hook, payload, IPC action, plugin manifest or `package.json` change.
- **Never run the cleanup on a real cluster.** The builder runs it only through its test, against a temp database, and never against kind or prod. The orchestrator runs it after deploy.
- **The cleanup prints counts only.** Never a fact's value, predicate, subject, id or agent key, on stdout or stderr.
- **Every `kubectl` line names `--context "$KCTX"`.** The default context on our machines is GKE prod. Never write a real prod context name (`scripts/__tests__/no-deployment-specifics-committed.test.js`).
- **Memory rules.**
  - Append rows only to `.claude/memory/decisions/2026-11-18-TASK-1151.md`.
  - Never change an existing line, and never touch a root archive.
  - No `Memory-Rewrite` trailer.
- **Commands.**
  - One file: `pnpm --filter @ax/memory exec vitest run <file>`.
  - The gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  - `pnpm test:scripts` is the suite that catches a pinned-file edit.
- **The changeset follows CLAUDE.md's voice.**

## Review Focus

1. **Model spellings.** `Assistant | Published Artifact` and `the assistant | ran-tests` (any case, spaces or hyphens) classify like the snake_case form, in the filter and in the cleanup. Tested by Task 1's spelling rows and Task 2's seeded `Assistant`/`the_assistant` rows.
2. **The host's connection stays open during the cleanup.** Its next recall returns the rows that were kept and never a deleted one, through both full-text and vector search. Tested by Task 2, "an engine that stayed open across the cleanup …".
3. **Vectors exist but `--vec-extension` is missing or wrong.** A dry run reports `vecRows: null`, and apply refuses and changes nothing. Tested by Task 2's refusal test.
4. **A kept row was closed by a row the cleanup would delete.** Apply refuses, rather than leave a kept row closed by a row that no longer exists. Tested by Task 2's `closed_by` test.
5. **A huge, repetitive, untrusted predicate or object stays fast.** For example, 20k repeats of `created_artifact_`, or a megabyte of spaces before "of". Tested by Task 1's timing test.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `packages/memory/src/self-report.ts` | 1 | The one rule: `classifyAgentFact`, and `isAgentContextSelfReport` on top of it |
| `packages/memory/src/__tests__/self-report.test.ts` | 1 | Both-sides tables: what is dropped, and what is kept |
| `packages/memory/src/__tests__/observer.test.ts` | 1 | One end-to-end batch through the real observer |
| `.changeset/memory-assistant-narration.md` | 1, 2 | Release note |
| `packages/memory/scripts/clean-assistant-narration.mjs` | 2 | One-off cleanup; its header is the runbook |
| `packages/memory/src/__tests__/narration-cleanup.test.ts` | 2 | Runs the documented pipeline against a real engine database |

---

### Task 1: Classify the assistant's own narration in `self-report.ts`  [tier: sensitive] — needs security-checklist

**Files:**
- Modify: `packages/memory/src/self-report.ts`
- Modify: `packages/memory/src/__tests__/self-report.test.ts`
- Modify: `packages/memory/src/__tests__/observer.test.ts`
- Create: `.changeset/memory-assistant-narration.md`

**Interfaces:**
- Consumes: nothing new. Reuses the module-private `AGENT_SUBJECTS`, `ASSISTANT_SUBJECTS`, `normalizeSubject`, `normalizePredicate`, `isOwnNarration`, `CONTEXT_PREDICATE`, `CONTEXT_PATTERNS` and `MAX_SCANNED_CHARS`.
- Produces: module exports of `self-report.ts`. Task 2 calls `classifyAgentFact` by name and writes the class strings into its JSON.

```ts
export type AgentFactClass =
  | 'context'          // TASK-612: its own rules/instructions/memory   (dropped)
  | 'own-narration'    // TASK-1136: its memory operations, tool failures (dropped)
  | 'action-narration' // TASK-1151: what it did with its tools         (dropped)
  | 'capability'       // TASK-1151: what it says it can't do           (dropped)
  | 'identity'         // kept: name, persona, standing rules
  | 'other';           // kept: everything else, incl. what it supplied
export function classifyAgentFact(fact: { subject: string; predicate: string; object: string }): AgentFactClass | null;
export function isAgentContextSelfReport(fact: { subject: string; predicate: string; object: string }): boolean; // unchanged signature
```

It returns `null` for a subject outside `AGENT_SUBJECTS`. For `agent`/`the_agent` it returns only `'context'` or `null`. `isAgentContextSelfReport` is true exactly when the class is one of the four dropped classes.

- [ ] **Step 1: Write the failing tests.** In `self-report.test.ts`, import `classifyAgentFact` next to `isAgentContextSelfReport`. Add a describe block, "the assistant's narration of its own actions, and what it says it can't do (TASK-1151)". Each table below is an `it.each`. Unless noted, each row asserts both `classifyAgentFact(row)` (the class shown) and `isAgentContextSelfReport(row)` (true for a dropped class, false otherwise).

Action narration (`'action-narration'`, dropped):
```ts
['assistant', 'created_artifact', 'the Q3 revenue dashboard'],    // card: x5 on prod
['assistant', 'published_artifact', 'the Q3 revenue dashboard'],  // card: x5
['assistant', 'ran_tests', 'all 42 passed'],                      // card
['assistant', 'fixed_bug', 'in the date parser'],                 // card
['assistant', 'built_dashboard', 'for weekly sign-ups'],
['assistant', 'deployed', 'the staging build'],
['assistant', 'committed_changes', 'to the main branch'],
['assistant', 'opened_pr', '#43 to fix the login redirect'],
['assistant', 'merged_pr', '#42'],
['assistant', 'installed_package', 'pandas 2.2'],
['assistant', 'executed_command', 'npm ci'],
['assistant', 'tested_endpoint', '/api/health returned 200'],
['assistant', 'configured_connector', 'Gmail'],
['assistant', 'uploaded_file', 'report.pdf'],
['assistant', 'deleted_file', 'old.csv'],
['assistant', 'sent_email', 'to Bob about the launch'],
['assistant', 'saved', 'the Q3 report draft to the shared drive'],  // was a TASK-1136 keep row
['assistant', 'saved_to_memory_card', 'the photos from the shoot'], // was a TASK-1136 keep row
['assistant', 'created_file', 'notes.md'],
['assistant', 'generated_image', 'a watercolor fox'],
['assistant', 'wrote_file', 'src/index.ts'],
['assistant', 'updated_routine', 'the daily digest now runs at 9am'],
['assistant', 'added_connector', 'Slack'],
['assistant', 'scheduled_routine', 'a weekly report on Mondays'],
['assistant', 'set_up_routine', 'a weekly digest'],
['assistant', 'edited_document', 'the onboarding doc'],
['assistant', 'created_artifact_for_q3_sales_review', 'x'],      // a noun anywhere after the verb
['Assistant', 'Published Artifact', 'the dashboard'],
['the_assistant', 'ran-tests', 'all passed'],
['AI assistant', 'Created Artifact', 'the dashboard'],
```
Delete the two `saved…` rows from TASK-1136's keep table. Give the `saved` row this comment: "TASK-1136 kept success narration as a real action; Vinay's 2026-11-17 scope (TASK-1151) drops it: the drive holds the draft." Give the `saved_to_memory_card` row this one: "still pins TASK-1136's memory-card exclusion: its class is action-narration, not own-narration."

Capability statements (`'capability'`, dropped):
```ts
['assistant', 'stated_limitation', 'cannot browse the internet'],   // card: x3
['assistant', 'has_limitation', 'no real-time data'],
['assistant', 'acknowledged_limitations', "can't see images in this chat"],
['assistant', 'described_capabilities', 'can browse, run code and make charts'],
['assistant', 'limitation', 'no access to the calendar'],
['assistant', 'stated_its_limitations', 'no web access'],
['assistant', 'has_no_access_to', 'real-time stock prices'],
['assistant', "doesn't_have_access", 'to the internet'],
['assistant', 'lacks_access', 'to the shared drive'],
['the assistant', 'Stated Limitation', 'cannot open PDFs'],
```

Identity (`'identity'`, kept). This is the card's whole keep-set, plus two rows where an identity word beats an action word:
```ts
['assistant', 'has_name', 'Ember'],
['assistant', 'is_named', 'Ember'],
['assistant', 'was_named', 'Ember, by the user'],
['assistant', 'introduced_as', 'Ember, a research assistant'],
['assistant', 'adopted_identity', 'a calm, curious research partner'],
['assistant', 'adopted_signature_emoji', '✨'],
['assistant', 'default_design_style', 'minimal, lots of whitespace'],
['assistant', 'established_rule', 'always cite sources'],
['assistant', 'saved_standing_preference', 'reply in bullet points'],
['assistant', 'was_created_by_user', 'Vinay'],
['assistant', 'published_style_guide', 'brand colors and fonts'],
```

What it supplied (`'other'`, kept):
```ts
['assistant', 'recommended_sealant', 'Mod Podge or another sealant, to seal the newspaper flower vase'],
['assistant', 'recommended', 'the Fenway walking tour'],
['assistant', 'listed', 'the 10 hiking trails near Denver, in order'],
['assistant', 'listed_options', 'three plans: basic, plus, pro'],
['assistant', 'provided_forecast', '72 F and sunny on Tuesday'],    // the card called it narration; scope B keeps it
['assistant', 'provided_solution', 'a composite index on (agent_key, slot)'],
['assistant', 'stated', 'the Roth IRA income limit is $161k'],
['assistant', 'described_architecture', 'three tiers: web, api, db'],
['assistant', 'explained', 'how compound interest works'],
['assistant', 'suggested', 'a vegetarian lasagna'],
['assistant', 'noted', 'the API allows 100 requests a minute'],
['assistant', 'reported_findings', '3 issues, the worst an open redirect'],
['assistant', 'created_meal_plan', 'Mon oatmeal, Tue eggs, Wed yogurt'],  // `created` needs an artifact noun
['assistant', 'created', 'a 5-day Lisbon itinerary: Belem, Sintra, Cascais'],
['assistant', 'generated_list', '10 baby names, starting with Ada'],
['assistant', 'wrote', 'a haiku about autumn'],
['assistant', 'wrote_code', 'def parse(s): return s.split(",")'],      // code it supplied is content
['assistant', 'updated_itinerary', 'Day 2 is now Sintra'],
['assistant', 'added', 'a vegetarian option: lentil curry'],
['assistant', 'compiled', 'a list of 10 trails'],
['assistant', 'drafted_email', 'Subject: Q3 update'],
['assistant', 'explained_limitations', 'of the Roth IRA: an income cap of $161k'],  // a topic
['assistant', 'explained_limitations_of_the_study', 'small sample size'],
['assistant', 'runs', 'a daily digest at 9am'],                  // present tense: a standing behaviour
['assistant', 'publishes', 'the weekly report on Fridays'],
```

Accepted residuals: kept on purpose, because a missed junk row is the cheap direction. Assert only `isAgentContextSelfReport(...) === false`:
```ts
['assistant', 'searched_web', 'for flights to Lisbon'],
['assistant', 'checked', 'the deploy status: green'],
['assistant', 'renamed_file', 'a.txt to b.txt'],   // `renamed` is an identity word
```

Not the assistant (`null`, kept):
```ts
['user', 'created_artifact', 'the Q3 dashboard'],
['sam', 'ran_tests', 'all passed'],
['agent', 'published_artifact', 'x'],               // `agent` is an everyday noun (TASK-1136)
['the_agent', 'published', 'the listing on Zillow'],
['vinay', 'stated_limitation', 'no weekend meetings'],
```

Classes of the older checks:
- `classifyAgentFact(WALK_FACT)` is `'context'`.
- `{ subject: 'assistant', predicate: 'could_not_save_memory', object: 'x' }` is `'own-narration'`.
- `{ subject: 'assistant', predicate: 'saved_to_memory', object: 'the standup time' }` is `'own-narration'`. This pins precedence: its first word `saved` is also an action verb, so TASK-1136's check must run first.

Timing guard, "stays fast on huge, repetitive, untrusted input (TASK-1151)":
- For each `word` of `['created artifact ', 'stated limitation ', 'has no access ', 'saved standing preference ', 'set up ']`, call `classifyAgentFact({ subject: 'assistant', predicate: word.replace(/ /g, '_').repeat(20_000) + 'x', object: word.repeat(40_000) + 'x' })`.
- Also call it once with `{ subject: 'assistant', predicate: 'explained_limitations', object: ' '.repeat(1_000_000) + 'of the study' }`.
- Expect the total under 250 ms.

In `observer.test.ts`, add a describe block after the TASK-612 one: "the assistant's narration of its own actions is not a fact (TASK-1151)". Its one test is "drops action narration and limits, keeps its identity and what it supplied":
- Extraction: `fact()`, plus `assistant | created_artifact | the Q3 revenue dashboard`, `assistant | stated_limitation | cannot browse the internet`, `assistant | has_name | Ember` and `assistant | recommended | the Fenway walking tour`.
- After `chatEnd(h)`, `readRows(h.databasePath).map((r) => r.relation).sort()` equals `['has_name', 'lives_in', 'recommended']`.
- The `recorded` run's bindings match `{ recorded: 3, selfReports: 2, unusable: 0 }`.

- [ ] **Step 2: Run the tests to see them fail.**
  - Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/self-report.test.ts src/__tests__/observer.test.ts`
  - Expected: FAIL. `classifyAgentFact` is not exported, and the narration rows are still stored.

- [ ] **Step 3: Implement `classifyAgentFact` in `self-report.ts`.** Re-express `isAgentContextSelfReport` as "the class is one of the four dropped classes". Precedence is part of the design, and the tests don't fully determine it:

```
1. subject = normalizeSubject(fact.subject); if not in AGENT_SUBJECTS -> null
2. TASK-612 checks exactly as today (CONTEXT_PREDICATE, then CONTEXT_PATTERNS) -> 'context'
3. if subject not in ASSISTANT_SUBJECTS -> null
4. normalized = normalizePredicate(fact.predicate); isOwnNarration(normalized, fact.object, text) -> 'own-narration'
5. words = normalized.split('_').filter((w) => w !== '')
6. any word in IDENTITY_WORDS, or CREATED_BY.test(normalized) -> 'identity'
7. LIMITATION_PREDICATE.test(normalized) and the object, cut to MAX_SCANNED_CHARS then trimStart'ed,
   does not start with "of " or "for " (case-insensitive)   -> 'capability'
   NO_ACCESS_PREDICATE.test(normalized)                     -> 'capability'
8. head = words[0]; rest = words.slice(1); if head === 'set' && words[1] === 'up' then head = 'setup', rest = words.slice(2)
   ACTION_VERBS has head                                    -> 'action-narration'
   ARTIFACT_VERBS has head and some word of rest is in ARTIFACT_NOUNS -> 'action-narration'
9. -> 'other'
```

The constants, with their values pinned (`Set`s of whole words, matched against `normalizePredicate` output):

```ts
// Past tense only: a completed action is narration; `runs`/`publishes` is a standing behaviour.
const ACTION_VERBS = new Set(['published', 'unpublished', 'republished', 'deployed', 'redeployed', 'ran', 'reran',
  'executed', 'committed', 'merged', 'pushed', 'installed', 'uninstalled', 'reinstalled', 'fixed', 'debugged',
  'patched', 'refactored', 'built', 'rebuilt', 'tested', 'retested', 'uploaded', 'downloaded', 'deleted',
  'restarted', 'configured', 'reconfigured', 'migrated', 'implemented', 'saved', 'sent', 'posted', 'opened',
  'attached', 'exported', 'imported', 'cloned', 'forked', 'moved', 'invoked', 'triggered']);
// Narration only when an artifact noun follows: "created a meal plan" and "wrote a haiku" are content.
const ARTIFACT_VERBS = new Set(['created', 'generated', 'made', 'wrote', 'rewrote', 'updated', 'modified', 'changed',
  'added', 'removed', 'edited', 'shared', 'scheduled', 'rendered', 'setup']);
const ARTIFACT_NOUNS = new Set(['artifact', 'artifacts', 'file', 'files', 'folder', 'folders', 'directory',
  'directories', 'document', 'documents', 'doc', 'docs', 'page', 'pages', 'webpage', 'webpages', 'site', 'sites',
  'website', 'websites', 'app', 'apps', 'dashboard', 'dashboards', 'visual', 'visuals', 'visualization',
  'visualizations', 'chart', 'charts', 'graph', 'graphs', 'spreadsheet', 'spreadsheets', 'deck', 'decks',
  'presentation', 'presentations', 'image', 'images', 'diagram', 'diagrams', 'repo', 'repos', 'repository',
  'repositories', 'branch', 'branches', 'commit', 'commits', 'pr', 'prs', 'routine', 'routines', 'skill', 'skills',
  'connector', 'connectors', 'workflow', 'workflows', 'automation', 'automations', 'component', 'components',
  'pdf', 'pdfs', 'csv', 'csvs']);
// Checked first: the card's keep-set includes `saved_standing_preference`.
const IDENTITY_WORDS = new Set(['name', 'names', 'named', 'renamed', 'nickname', 'nicknamed', 'identity', 'persona',
  'personality', 'introduced', 'introduction', 'signature', 'emoji', 'avatar', 'style', 'tone', 'voice', 'pronoun',
  'pronouns', 'rule', 'rules', 'preference', 'preferences', 'standing', 'default', 'defaults']);
const CREATED_BY = /(?:^|_)(?:created|made|built|designed)_by(?:_|$)/;
const LIMITATION_PREDICATE =
  /^(?:(?:stated|noted|acknowledged|explained|described|mentioned|clarified|disclosed|admitted|flagged|reported|listed|outlined|summarized|has|had|have)_)?(?:(?:its|own|a|the|some|several|current|known|technical)_){0,2}(?:limitations?|capabilit(?:y|ies)|inabilit(?:y|ies))$/;
const NO_ACCESS_PREDICATE =
  /^(?:has_no|have_no|had_no|lacks?|lacked|does_not_have|doesnt_have|did_not_have|didnt_have)_(?:(?:direct|real_?time|live|internet|web|external)_)?access(?:_|$)/;
```

Every check reads the windowed, normalized predicate. Every quantifier is bounded, and both regexes are anchored at the start.

- [ ] **Step 4: Run the tests to see them pass, then the whole package.**
  - Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/self-report.test.ts src/__tests__/observer.test.ts`, then `pnpm --filter @ax/memory test`, then `pnpm --filter @ax/memory build`.
  - Expected: PASS, with the existing TASK-612 and TASK-1136 tables unchanged apart from the two moved rows.

- [ ] **Step 5: Add a "Its narration of its own actions (TASK-1151)" section to the header of `self-report.ts`.** It must say:
  - The tool's own state is the source of truth (the artifact store, the files, routines, the repo, the test run), so a transcript copy is stale on arrival (invariant 4).
  - Vinay's 2026-11-17 scope supersedes TASK-1136's "success narration is a real action".
  - What the agent supplied stays: it is the pinned prompt's contract (`extraction-prompt.ts:65-75`), measured at 45.5→81.8.
  - Why it is a denylist (keep when unsure), why it uses past tense only, why ambiguous verbs need an artifact noun, why the identity guard runs first, and what capability statements are.
  - The residuals from the residual table, plus `built | a training plan` (dropped).
  - The `classifyAgentFact` doc says the cleanup script pipes this file as text, so it must stay import-free and use only erasable syntax.

- [ ] **Step 6: Create `.changeset/memory-assistant-narration.md`** (`'@ax/memory': patch`), with this text:

> Memory stops saving the agent's play-by-play of its own work. "Created an artifact", "published the dashboard", "ran the tests", "fixed the bug": that's one conversation's busywork, and the artifact, the file or the test run is already the real record. The same goes for the agent saying what it can't do ("can't browse the web"). That's true of one session, not something to remember.
>
> What the agent told you stays: recommendations, lists, numbers, forecasts, explanations. So does who it is: its name, its emoji, its default style and the standing rules you gave it.
>
> The filter is a list of action words, tuned to err toward keeping. Narration with a verb we didn't list still gets through, and a few real answers phrased like an action ("built a training plan") get dropped.

- [ ] **Step 7: Mutation spot-check.** Run each mutant on the committed tree, one at a time, restoring with `git checkout HEAD -- packages/memory/src/self-report.ts` and confirming `git status --short` is empty between mutants. Predict the killing test before each run. Append one row to the shard, citing the file "as of commit". The mutants:
  - Identity guard removed. `saved_standing_preference` and `published_style_guide` die.
  - `published` dropped from `ACTION_VERBS`. The card's row dies.
  - The artifact-noun requirement removed. `created_meal_plan`, `wrote | a haiku` and `updated_itinerary` die.
  - Only the last word checked for a noun. `created_artifact_for_q3_sales_review` dies.
  - `$` removed from `LIMITATION_PREDICATE`. `explained_limitations_of_the_study` dies.
  - The topic exception removed. `explained_limitations | of the Roth IRA` dies.
  - The new checks run for `AGENT_SUBJECTS` instead of `ASSISTANT_SUBJECTS`. `agent` and `the_agent` die.
  - `runs` added to `ACTION_VERBS`. The present-tense row dies.
  - The new checks placed before `isOwnNarration`. The `saved_to_memory` older-class pin dies.
  - The window removed. Expect it to survive; it is not a correctness change.

- [ ] **Step 8: security-checklist walk** (sandbox / prompt injection / supply chain). Append the note as a shard row. Points it must answer:
  - The classifier is a pure function over untrusted model output and runs synchronously on the host.
  - Its cost is bounded by the 1,000-char window and linear work.
  - It can only drop more `extracted` assistant facts. It never touches person subjects, `memory_note` or human edits.
  - There are no new exports from `index.ts`, and no dependency change.

- [ ] **Step 9: Commit.**
```bash
git add packages/memory/src/self-report.ts packages/memory/src/__tests__/self-report.test.ts packages/memory/src/__tests__/observer.test.ts .changeset/memory-assistant-narration.md .claude/memory/decisions/2026-11-18-TASK-1151.md
git commit -m "[TASK-1151] Memory: drop the assistant's narration of its own actions and limits"
```

---

### Task 2: The one-off cleanup script, its runbook and its end-to-end test  [tier: sensitive] — needs security-checklist

**Files:**
- Create: `packages/memory/scripts/clean-assistant-narration.mjs`
- Create: `packages/memory/src/__tests__/narration-cleanup.test.ts`
- Modify: `.changeset/memory-assistant-narration.md` (append one sentence)

**Interfaces:**
- Consumes: `classifyAgentFact` and the `AgentFactClass` strings from Task 1. They arrive by concatenation: the script declares `/* global classifyAgentFact */` and never defines or imports it.
- Produces: this program contract. The test and the runbook both use it.
  - **Run:** `cat packages/memory/src/self-report.ts packages/memory/scripts/clean-assistant-narration.mjs | node --input-type=module-typescript - [--apply] [--vec-extension=<path>]`
  - **Env:** `AX_MEMORY_FACTS_DB_PATH`, required. It is already set in the host container.
  - **stdout:** exactly one JSON line.
    - Normal: `{"mode":"dry-run"|"apply","examined":n,"delete":{"context":n,"own-narration":n,"action-narration":n,"capability":n},"keep":{"identity":n,"other":n},"ftsRows":n,"vecRows":n|null,"keptClosedByDeleted":n,"deleted":n,"refused":null}`
    - On a refusal after reading: the same shape with `"refused":"vectors-need-extension"` or `"kept-rows-closed-by-deleted"`, and `"deleted":0`.
    - On a refusal before reading: just `{"refused":"unknown-argument"|"classifier-missing"|"no-database-path"}`.
  - **Exit codes:**
    - `0`: done.
    - `2`: refused, nothing changed.
    - `1`: error, nothing changed. stderr gets one line: `narration-cleanup: failed: <err.errstr ?? err.code ?? 'unknown error'>`. Never `err.message`.

- [ ] **Step 1: Write the failing test `narration-cleanup.test.ts`.**

Harness:
- `SELF_REPORT` and `SCRIPT` are read as text from `../self-report.ts` and `../../scripts/clean-assistant-narration.mjs`.
- `VEC_EXTENSION` is `createRequire(createRequire(import.meta.url).resolve('@ax/memory-facts-sqlite'))('sqlite-vec').getLoadablePath()`. This resolves sqlite-vec through the engine, so `@ax/memory` adds no dependency.
- `run(args, { classifier = true, env } = {})` is `spawnSync(process.execPath, ['--input-type=module-typescript', '-', ...args], { input: (classifier ? SELF_REPORT + '\n' : '') + SCRIPT, env: { ...process.env, AX_MEMORY_FACTS_DB_PATH: databasePath, ...env }, encoding: 'utf8' })`.
- `beforeEach` starts a real engine:
  - Create a `HookBus`.
  - Register a `test:embed` service that answers `{ vectors: input.texts.map((t) => oneHot(t.length % 384)) }`.
  - Init `createMemoryFactsSqlitePlugin({ databasePath, embedder: { hook: 'test:embed' } })` with `{ bus, config: {} }`.
  - Build `ctxFor(agentId)` as in `packages/memory-facts-sqlite/src/__tests__/agents-deleted.test.ts`.
  - Seed one `memory:facts:record` call per row, all with `when: '2026-11-01T00:00:00.000Z'` and `ownerUserId: 'user-1'`. Every value carries a sentinel `V-<label>`.
- `afterEach` shuts the engine down and removes the temp dir.
- `snapshot()` opens a `better-sqlite3` connection with `VEC_EXTENSION` loaded. It returns the sorted base ids, the sorted FTS ids, and the vec row count.

Seed (agent `agent-1` unless noted; `extracted` unless noted):

| Label | Row | Expected |
|---|---|---|
| D1 | `assistant \| created_artifact` | delete, action |
| D2 | `Assistant \| Published Artifact` | delete, action |
| D3 | `the_assistant \| ran_tests` | delete, action |
| D4 | `assistant \| stated_limitation` | delete, capability |
| D5 | `assistant \| could_not_save_memory` | delete, own-narration |
| D6 | `assistant \| stated \| No rules have been given by the user; the only instructions came from the system bootstrap prompt V-D6` | delete, context |
| D7 | agent `agent-2`: `assistant \| fixed_bug` | delete, action (every agent) |
| K1 | `assistant \| has_name` | keep, identity |
| K2 | `assistant \| saved_standing_preference` | keep, identity |
| K3 | `assistant \| recommended \| the Fenway walking tour V-K3` | keep, other |
| K4 | `assistant \| listed` | keep, other |
| K5 | `user:alice \| lives_in` | untouched (not the agent) |
| K6 | `agent \| published_artifact` | untouched (`agent` is a noun) |
| K7 | provenance `agent`: `assistant \| created_artifact` | untouched (deliberate save) |
| K8 | provenance `human`: `assistant \| ran_tests` | untouched (a person's edit) |

Tests and their key assertions:
1. "a dry run changes nothing and prints counts only".
   - `run(['--vec-extension=' + VEC_EXTENSION])` exits 0, and its stdout parses to exactly `{ mode: 'dry-run', examined: 13, delete: { context: 1, 'own-narration': 1, 'action-narration': 4, capability: 1 }, keep: { identity: 2, other: 2 }, ftsRows: 7, vecRows: 7, keptClosedByDeleted: 0, deleted: 0, refused: null }`.
   - `snapshot()` is unchanged.
   - stdout has no `_`.
   - Neither stdout nor stderr contains `V-` or any row id.
2. "apply deletes exactly the narration rows, with their search rows".
   - With `--apply` added, it exits 0, and the JSON has `deleted: 7` and `refused: null`.
   - The base ids are exactly K1–K8.
   - D1–D7 have no FTS or vec rows left, and K1–K8 keep theirs.
   - The output checks are the same as in test 1.
3. "an engine that stayed open across the cleanup recalls survivors and never a deleted row".
   - Don't shut the engine down before the apply.
   - After it, call `memory:facts:recall` for `agent-1` with `{ query: 'Fenway walking tour artifact tests', limit: 50 }`.
   - Every returned id is in K1–K8, and K3's id is among them.
4. "a second apply deletes nothing". After one apply, another returns `deleted: 0`, and every `delete` count is 0.
5. "apply refuses without the vector extension when vectors exist, and changes nothing".
   - `run(['--apply'])` exits 2 with `refused: 'vectors-need-extension'`, and the snapshot is unchanged.
   - `run([])` exits 0 with `vecRows: null`.
6. "apply refuses when a kept row was closed by a row it would delete".
   - On the test connection, set K1's `closed_by` to D1's id.
   - A dry run reports `keptClosedByDeleted: 1`.
   - The apply exits 2 with `refused: 'kept-rows-closed-by-deleted'`, and the snapshot is unchanged.
7. "refuses an unknown argument, a missing classifier and a missing database path".
   - `run(['--aply'])` prints `{"refused":"unknown-argument"}`.
   - `run([], { classifier: false })` prints `{"refused":"classifier-missing"}`.
   - `run([], { env: { AX_MEMORY_FACTS_DB_PATH: '' } })` prints `{"refused":"no-database-path"}`.
   - All three exit 2, and the snapshot is unchanged.
8. "its runbook pipes it after self-report.ts and names a context on every kubectl line".
   - In `SCRIPT`, every line containing `kubectl` also contains `--context "$KCTX"`.
   - It contains `cat packages/memory/src/self-report.ts packages/memory/scripts/clean-assistant-narration.mjs`, `node --input-type=module-typescript -` and `bash deploy/gke/backups.sh status --context "$KCTX"`.

- [ ] **Step 2: Run the test to see it fail.**
  - Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/narration-cleanup.test.ts`
  - Expected: FAIL, because the script doesn't exist.

- [ ] **Step 3: Write `clean-assistant-narration.mjs`.**
  - Node built-ins only (`node:sqlite`). No repo imports.
  - Top-level names must not collide with any in `self-report.ts`. A collision is a SyntaxError in the concatenated program, and the test catches it.
  - Set `process.exitCode` and let the program end. Don't call `process.exit()`: with stdout piped through the pod, it can cut off the JSON line.

  The algorithm:

```
1. args = process.argv.slice(2); allow only '--apply' and '--vec-extension=<non-empty>'; anything else -> refuse 'unknown-argument'
2. typeof classifyAgentFact !== 'function' -> refuse 'classifier-missing'
3. path = process.env.AX_MEMORY_FACTS_DB_PATH; empty -> refuse 'no-database-path'
4. db = new DatabaseSync(path, { readOnly: !apply, allowExtension: true }); db.exec('PRAGMA busy_timeout = 5000')
5. hasVec = a sqlite_master row named 'memory_facts_v1_vec'; if --vec-extension given, db.loadExtension(it)
6. apply: db.exec('BEGIN IMMEDIATE')   (everything below reads inside the write lock)
7. for each row of SELECT id, about, relation, value FROM memory_facts_v1 WHERE provenance = 'extracted':
     cls = classifyAgentFact({ subject: about, predicate: relation, object: value }); tally; collect doomed ids (the 4 dropped classes)
8. keptClosedByDeleted = rows of SELECT id, closed_by FROM memory_facts_v1 WHERE closed_by IS NOT NULL with closed_by doomed and id not doomed
9. ftsRows = sum of COUNT(*) FROM memory_facts_v1_fts WHERE id = ?; vecRows = !hasVec ? 0 : loaded ? sum of COUNT(*) FROM memory_facts_v1_vec WHERE id = ? : null
10. dry run: print, exit 0
11. apply: refuse 'vectors-need-extension' if hasVec && !loaded && doomed.length > 0; refuse 'kept-rows-closed-by-deleted' if keptClosedByDeleted > 0
    (ROLLBACK, print, exit 2)
12. per doomed id: DELETE FROM memory_facts_v1_fts WHERE id = ?; DELETE FROM memory_facts_v1_vec WHERE id = ? (hasVec); DELETE FROM memory_facts_v1 WHERE id = ?
    sum of base changes !== doomed.length -> throw (ROLLBACK, exit 1); else COMMIT, print with deleted, exit 0
13. any throw: ROLLBACK if a transaction is open; stderr 'narration-cleanup: failed: ' + (err?.errstr ?? err?.code ?? 'unknown error'); exit 1
```

The header comment is the runbook. Write it in CLAUDE.md's voice, with these commands verbatim. Test 8 pins the key strings:

```
// Run from a checkout of the commit the host image was built from: this file
// deletes with that checkout's self-report.ts. Our deploys tag the image with
// the commit's short sha, so it must be the start of `git rev-parse HEAD`.
//   KCTX=kind-ax-next-dev        # or your GKE context, for prod
//   kubectl --context "$KCTX" -n ax-next get deploy ax-next-host -o jsonpath='{.spec.template.spec.containers[*].image}'; echo
//   git rev-parse HEAD
// Prod only: the facts disk must have a recent snapshot (exits 0).
//   bash deploy/gke/backups.sh status --context "$KCTX"
// The vector extension inside the pod (expect exactly one path):
//   VEC0=$(kubectl --context "$KCTX" -n ax-next exec deploy/ax-next-host -c host -- sh -c 'ls /opt/ax-next/host/node_modules/.pnpm/sqlite-vec-linux-*/node_modules/sqlite-vec-linux-*/vec0.so')
// Dry run (changes nothing; one line of counts):
//   cat packages/memory/src/self-report.ts packages/memory/scripts/clean-assistant-narration.mjs | kubectl --context "$KCTX" -n ax-next exec -i deploy/ax-next-host -c host -- node --input-type=module-typescript - --vec-extension="$VEC0"
// Apply: the same line plus --apply. Then dry-run again: every "delete" count must be 0.
```

Test 8 checks every header line that mentions `kubectl`, so the prose avoids the bare word: say "the pod" or "the host container" instead.

The header must also cover:
- The exit codes and the refusals.
- `keep.identity` counts every predicate that has an identity word.
- The agent's `/memory` files keep showing deleted rows until its next memory write.
- Old "Used N memories" chips keep their text.
- The builder never runs this. The orchestrator runs it after deploy: kind first, then prod.

- [ ] **Step 4: Run the test to see it pass, then the whole gate.**
  - Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/narration-cleanup.test.ts`, then `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  - Expected: all green. `test:scripts` stays green because no pinned file changed.

- [ ] **Step 5: Append to the changeset.** "For whoever runs the deployment: `packages/memory/scripts/clean-assistant-narration.mjs` removes the rows saved before this change. It runs dry by default, prints only counts, and its header is the runbook."

- [ ] **Step 6: Mutation spot-check**, run the same way as in Task 1. Append one row, citing the file "as of commit". The mutants:
  - The `provenance = 'extracted'` filter dropped. Test 2 dies (K7 and K8 deleted).
  - The FTS delete skipped. Test 2 dies.
  - The vec delete skipped. Test 2 dies.
  - The dry run opened read-write and deletes. Test 1 dies.
  - The `vectors-need-extension` refusal removed. Test 5 dies.
  - The `closed_by` refusal removed. Test 6 dies.
  - A predicate echoed in the output. Tests 1 and 2 die.
  - Every drop counted as `action-narration`. Test 1's exact JSON dies.
  - Unknown arguments ignored. Test 7 dies.
  - `BEGIN IMMEDIATE` removed. Expect it to survive; say so in the row.

- [ ] **Step 7: security-checklist walk.** Append it as a row. Points it must answer:
  - It deletes prod rows, but only `extracted` ones, in one transaction, refusing whenever it can't finish cleanly.
  - It loads a native extension from a path the operator gives. That grants nothing new, because the operator already has `kubectl exec` in that pod.
  - It reads untrusted fact text only to classify it, and prints counts only.
  - Nothing new is shipped in the image: the script is sent as text.
  - No dependency change: sqlite-vec is resolved through `@ax/memory-facts-sqlite` in the test.

- [ ] **Step 8: Commit.**
```bash
git add packages/memory/scripts/clean-assistant-narration.mjs packages/memory/src/__tests__/narration-cleanup.test.ts .changeset/memory-assistant-narration.md .claude/memory/decisions/2026-11-18-TASK-1151.md
git commit -m "[TASK-1151] Memory: one-off cleanup of the assistant's saved narration (dry run by default)"
```

---

## Not doing (YAGNI)

The shard's "Not done (YAGNI), and accepted residuals" row has the reasons. In short:
- No `deploy/GKE.md` section.
- No renamed function and no new observer counter. Both would need edits to `observer.ts`, which is pinned.
- No filter on `memory_note`.
- Nothing for narration filed under the agent's display name.
- No reopening of rows that narration closed.
- No export flush, and no rewriting of recall receipts.
- No change to the extraction prompt.
