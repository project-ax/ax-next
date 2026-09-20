# HANDOFF — rung 3, the `@ax/memory` product layer

**Written:** 2026-09-20 early, after TASK-434 was built and PR #643 opened. `origin/main` =
`cf08583f`.
**Read first:** `docs/plans/2026-09-20-dem-first-handoff.md` (rung 2's state, and its §3.1 now
carries an as-built note for TASK-434) and `docs/plans/2026-09-18-dem-first-memory-design.md`
(the spec everything implements). `dem-memory/HANDOFF.md` for the bench.

**Status of the design is unchanged:** *"design, not scheduled. A thought experiment that
produced a buildable spec."* Nobody has decided to replace Strata. **Rung 4 is that decision**
— and rung 3 is what unblocks it.

---

## 1. Where rung 2 ended

**Rung 2 is now complete — gate *and* scope.** The previous handoff had to distinguish the two
because the §8 gate passed while retrieval was outstanding. That gap is closed:

| | |
|---|---|
| `@ax/memory-facts-sqlite` | **167 tests** — record/recall/supersede/clear/reindex, plus sparse FTS5 + dense `sqlite-vec` + temporal channels, RRF fusion, optional rerank |
| `@ax/memory-facts-postgres` | **107 tests** — the same five hooks; **no fusion channels** (TASK-457) |
| `@ax/memory-facts-contract` | **9** own tests + the shared suite both engines run |

**TASK-434 is in PR #643, not merged** at the time of writing — it was left for auto-ship's
serialized merge queue with its card in **In Review**. Check it landed before building on it.

**Say this accurately:** rung 2 being done still does **not** unblock rung 4. §8 measures rung 4
through *"an **agent** holding `memory_recall`"*, and `memory_recall` is a **rung-3**
deliverable. Rung 3 is the whole remaining blocker, and it is the largest build in the ladder.

---

## 2. What rung 3 actually is

`@ax/memory` — the product layer, §2.1. **It does not exist. It is not decomposed into cards.**
That decomposition is the first task, and §5 below proposes one.

The deliverables, from §2.2 and §3–§5:

**Hooks it registers**

| Hook | Payload → result | Provenance |
|---|---|---|
| `memory:recall` | `{query?, about?, at?, activeOnly?, limit}` → `{statements, degraded}` | read |
| `memory:remember` | `{about, relation, value, when?}` → `{id}` | **human** — the only external write |
| `memory:forget` | `{ids}` → `{}` | human |
| `memory:rules:read` / `memory:rules:write` | unchanged from Strata | human |
| `system-prompt:augment` | the injected block (§4.1) | — |
| `tool:execute:memory_recall`, `tool:execute:memory_note` | §4.2, §4.3 | agent |

**Subscribes** `chat:end` (the observer). **Calls** `memory:facts:*`, `workspace:*`, `llm:call:*`
(extraction only).

**The components, roughly in dependency order**

1. **Observer** (§3.0) — `chat:end` → dialogue → one structured extraction call → statements.
   Carries DEM's pinned extraction prompt `f4752a79` **verbatim**; the design explicitly does not
   change it. Worth ~57 points on its own. **User and assistant turns only — never tool results,
   never attachment bodies.**
2. **Speaker rewrite** (§3.2) — `about: user` → `about: user:<userId>` from `ctx`, and stamp
   `ownerUserId`. Without it every person talking to a team agent collapses into one subject and
   `lives_in` closes on each of them.
3. **Normalizer / `slot`** (§3.3) — eight single-valued slots, one config constant that is *also*
   the profile whitelist. Deterministic, post-extraction, embedding + nearest-neighbour against
   slot descriptions with a strict threshold and a small synonym table in front. **No LLM.**
4. **Injected block** (§4.1) — Rules ‖ Profile ‖ Recent ‖ Digest, ~300–500 tokens, built at chat
   start from three store queries, with a drop order (digest first, recent second, profile last).
5. **`memory_recall`** (§4.2) — `{query, limit?, history?}`, 15 default / 40 max. Renders the
   evidence table **byte-identical to DEM's**: `Kind | When | Statement`, oldest-first.
6. **`memory_note`** (§4.3) — `provenance: agent`, through the same rewrite and normalizer.
7. **Export materializer** (§5.2) — one-way, debounced, through `workspace:apply`, into
   `permanent/memory/facts/**`, with `rules.md` **structurally** unreachable from the delta
   builder.
8. **UI** (§5.3) — `channel-web`, shadcn, a client of the **product** hooks only.

---

## 3. What rung 3 inherits from TASK-434 — read this before designing the embedder

**The read-path embedder seam is already chosen, and it was chosen to be the one you need.**
The previous handoff's §1 warned that §3.3 puts the normalizer's *write-path* embedder in
`@ax/memory` while TASK-434 needed a *read-path* one, and that picking a shape in isolation
would force a rework. TASK-434 resolved it by picking a shape that **collapses the two into one
seam**:

- The engine takes `embedder?: { hook: string; model?: string }` and `reranker?: { … }` —
  a **hook name plus an optional model**, not an injected function — declared under
  `optionalCalls` with a `degradation` string.
- Payloads are vendor-neutral: `{ texts, task: 'document' | 'query', model? }` → `{ vectors }`,
  and `{ query, documents, model? }` → `{ scores }`.
- `bootstrap.ts`'s `verifyCalls` **deliberately skips `optionalCalls`**, so an unregistered
  producer is non-fatal at boot — and does *not* drag the plugin into the preset canaries'
  `PLUGINS_TO_DROP` (the trap TASK-423 hit with `database:get-instance`).

**So rung 3 should name the same hook.** One provider plugin, one credential, one egress host,
serving both the normalizer's write-path embedding and the engine's read-path embedding. Do not
invent a second seam.

> **Note the deviation, because the card said otherwise.** TASK-434's acceptance text asked for
> "an `EmbeddingFn`-shaped function injected via plugin config". It shipped a hook name instead,
> flagged in PR #643. If a reviewer overturns that, rung 3's normalizer config changes with it —
> so confirm #643's final shape before building on it.

**Nothing registers those hooks yet.** There is no embeddings provider plugin. Until one exists
every deployment reports `degraded: ['semantic']` and the dense channel is absent — §4.4's
designed state, not a bug. **The provider plugin is a rung-3-adjacent prerequisite**, because
§3.3's normalizer *cannot work at all* without an embedder: slot mapping is embedding +
nearest-neighbour. Sparse recall degrades gracefully; slot derivation does not. It only has the
`pending` path, which is "store it and drain later", not "work without one".

That makes the provider plugin **the first thing on the critical path**, ahead of the observer.

---

## 4. Decisions rung 3 must make that nobody has made

1. **The embeddings provider plugin.** §6.5 says: fixed hosts over HTTPS, credentials from the
   credential store, routed through the existing **egress lock**, never a raw `fetch` with an env
   var — and drop `google-auth-library` for a bearer token plus `fetch`. §6.2 calls this "a new
   capability carrying user memory off-cluster", two destinations (every statement + every query
   to the embedder; top-40 candidates per recall to the reranker). **A local-only mode is
   required** for installs that can't egress, with the accuracy cost stated: n=30 smoke, 80.0%
   production vs 56.7% without the reranker. This needs its own `security-checklist` pass.
2. **Slot threshold.** §3.3 says the initial value is set at rung 0 from the precision sample and
   "loosens only on `closed_by` evidence". Confirm the rung-0 number exists
   (`dem-memory/bench/normalizer-eval.ts`) rather than re-deriving it.
3. **Coexistence with Strata.** §8: one memory plugin per preset — `memory-strata` *or* this,
   **never both for an agent** (Invariant 4) — with `memory:rules:*` as the shared contract so
   the Rules UI works either way. `memory-strata` is **8,558 LOC non-test** and is loaded in
   `presets/k8s` behind its `hostLlmTools` gate. Nobody has designed the switch, the migration,
   or what the admin surface for it looks like.
4. **Import is declined (§5.4)** — and the design calls it *"the one thing the greenfield framing
   hides, because real adoption would need it"*, since every existing agent has docs. If rung 4
   passes, this is the adoption blocker. Decide whether it stays declined.
5. **`rules.md` writability from the sandbox is UNVERIFIED** (§6.3, §9). If the runner can commit
   it through the git tier, injected content becomes a permanent top-of-prompt instruction. It is
   a Strata hole too if it's real. Cheap to check, and it is rung 5's walk item — but worth
   knowing before building the human tier.
6. **`kind` (§9)** — in the 87.4% prompt, no measured consumer. Ablate or keep as passthrough.

---

## 5. A proposed card decomposition

Not yet on the board. Ordered so each has a testable gate; the first two are the critical path.

| # | Card | Depends on | Note |
|---|---|---|---|
| A | **Embeddings/rerank provider plugin** registering the hooks TASK-434 declared | #643 | credential store + egress lock + `PROVIDER_ENDPOINTS`; local-only mode; own security-checklist. **Unblocks the normalizer.** |
| B | `@ax/memory` skeleton + `memory:recall/remember/forget` over `memory:facts:*` | #643 | provenance by hook, never by payload; speaker rewrite + `ownerUserId` (§3.2) |
| C | Normalizer + `slot` (§3.3) | A, B | eight slots, one constant shared with the profile whitelist; threshold from rung 0 |
| D | Observer on `chat:end` (§3.0) | B | pinned prompt `f4752a79` **verbatim**; user+assistant turns only; fire-and-forget; failures are events |
| E | `system-prompt:augment` block (§4.1) | B | four parts, drop order, ~800-token soft cap; "(noted …)" never "since" |
| F | `tool:execute:memory_recall` (§4.2) | B | evidence table byte-identical to DEM's; `history` decided-not-built |
| G | `tool:execute:memory_note` (§4.3) | B, C | `provenance: agent` |
| H | Export materializer (§5.2) | B | slugify `[a-z0-9_-]{1,64}`, hash fallback; delta builder rooted at `facts/` **by type** |
| I | Memory UI (§5.3) | B | client of product hooks only; statements as **plain text, never markdown** |
| J | Preset wiring + canary (Invariant 3) | B–I | one memory plugin per preset; `memory:rules:*` shared |
| K | **Rung 4 measurement** | A–J | the gate: accuracy ≥ 76.0% replicated across two answer arms |

Cards B–I are individually shippable; **J is where Invariant 3 bites** — no half-wired plugin
merges, so whatever lands must be reachable from the canary acceptance test.

---

## 6. Things that will bite you

**`vitest` is a runtime `dependencies` entry of `@ax/memory-facts-contract`, and eslint blocks
`@ax/*` value imports from plugin code.** `eslint.config.mjs`'s `crossPluginImports` allows only
a named list, and the contract package is not on it; `allowTypeImports: true` is why today's
`import type` works. So **you cannot share a value** (a constant, a helper) from the contract
package into a plugin. TASK-434 wanted to and could not — each engine keeps a local copy pinned
by a parity test, the precedent `PENDING_SLOT` already set. **TASK-457 hits this too.**

**`sqlite-vec` is pinned exact at `0.1.9`** in `memory-facts-sqlite` per §6.5. Audited: no
`scripts` key at all (so no install-time execution), a 42-line loader with no network, five
integrity-hashed per-platform binaries. Verified separately: `allowExtension: true` enables only
the C API — the SQL `load_extension()` function stays `not authorized` — so it does not hand a
future injection bug a code-execution primitive. `packages/memory-strata` still declares
`^0.1.6`; a follow-up to re-pin it is filed.

**The workspace moved to vitest 5** (`990e8f49`) — if your branch predates it, rebase and
re-run rather than trusting a green CI on the old base. TASK-434 hit exactly this: GitHub
reported the PR mergeable (no *textual* conflict) while the branch still pinned vitest 4 and had
never executed against 5.

**A degraded flag must not fire when nothing is wrong.** `'ranking'` is deliberately **not**
raised on an empty answer — with no candidates the reranker is never invoked, and firing there
would report degradation on every recall against a day-one empty store. Note the resulting
asymmetry, which is intentional: on an empty store with no providers a fusion backend raises
`'semantic'` but not `'ranking'`, because embedding is store-independent (the *query* is
embedded) while reranking is pool-dependent. Pinned by a contract case.

**Producer responses cross a trust boundary inward.** `HookBus.call` returns a handler's raw
value when the hook declares no `returns` schema, so a producer resolving to `null` arrives
intact — a `=== undefined` guard is false for it. TASK-434 shipped that bug briefly: because the
embed is awaited *before* the store region, the TypeError escaped the handler and the fact was
never written, turning one misconfigured provider into a deployment-wide write outage. Validate
arity, dimensionality and finiteness, use `== null`, and **degrade rather than throw**.

**Ask every implementing agent to predict which tests each mutation reddens, then run the
mutation and diff.** On TASK-434 a mutation reddened one test where two were predicted; reading
the second showed it asserted collection *shape* where the bug only moved a *score*, and
`reciprocalRankFusion` folds into a Map keyed by id — so the shape was identical either way. The
same pass found that every dense-channel test called `denseChannel()` directly and none covered
its wiring into the fusion path, so the channel could have been disabled in production with the
whole suite green. **When the accumulator dedupes, assert the accumulated value, not the shape.**

**`gh api rate_limit` can report a full GraphQL budget while GraphQL hard-refuses.** Measured
2026-09-20 over ~10 minutes: every `gh api graphql` returned `graphql_rate_limit` while
`rate_limit` reported `used: 0, remaining: 5000` with a reset that slid forward on each poll.
That defeats auto-ship's documented poller pre-check, which reads exactly
`.resources.graphql.remaining`. The only reliable probe is a trivial GraphQL query. Work from
the design docs when the board is unreachable; do not loop on it.

**Docker/OrbStack wedges, and presents as a 0-assertion `beforeAll` timeout** (TASK-398/449). The
restart that works:
```bash
osascript -e 'quit app "OrbStack"'; sleep 8; pkill -f OrbStack; sleep 5; open -a OrbStack
# poll `docker ps` until it answers (~10s), then prove it with a real container
```
It affects concurrent sessions, so say so first — though if it is already wedged they are already
broken.

**`.claude/memory/` root files are FROZEN archives; write shards.** `<kind>/<YYYY-MM-DD>-<TASK-ID>.md`.
R1 forbids deleting any line, so **a correction is an appended row beside the wrong one, never an
edit**. Verify with `bash scripts/memory-append-check.sh origin/main` — pass `origin/main`
explicitly, since a worktree's stale local `main` produces false violations.

---

## 7. How to run things

```bash
pnpm --filter @ax/memory-facts-sqlite test      # 167
pnpm --filter @ax/memory-facts-postgres test    # 107 (needs Docker)
pnpm --filter @ax/memory-facts-contract test    # 9
pnpm build && pnpm lint
```

The gate from CLAUDE.md, all three parts:
```bash
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
Capture each exit code separately; a `Tests N passed` line can sit above a `Test Files N failed`
line, and grepping only the former reports a red run as green.

CI's `test` job runs **"Test (affected packages + dependents)"** and **skips** the full suite, so
a green ~2-minute job is real — confirm by reading the job's step list, not its duration.

`dem-memory/**` is outside the pnpm workspace and eslint-ignored. The bench there uses npm, not
pnpm, with `--fingerprint f4752a79`.

---

## 8. Board state

| Card | Status | Note |
|---|---|---|
| TASK-420/421/422/423/448 | **Done** | rung 2's gate |
| **TASK-434** | **In Review — PR #643** | RRF recall, sqlite. Rung 2's last card. Merge before building on it |
| TASK-457 | To Do (deps 434) | the same channels on postgres; owns the `tsvector`/pgvector call. **Read TASK-458 first** |
| TASK-458 | To Do | the pgvector bootstrap swallows its own failure — `\|\| echo "pgvector not available…"` makes success and failure identical, and no test lane could check (every `PostgreSqlContainer` in the repo is `postgres:16-alpine`). One `docker run` answers it |
| TASK-459 | To Do | NUL/control chars at the `record` door — the two backends **disagree** until it lands (sqlite accepts, postgres throws `store-unavailable`, SQLSTATE 22021). Reachable in production: `record` defaults to `provenance: extracted` and `about` is free text |
| TASK-438 | To Do | *"The Memory tab is permanently inert on production — no backend is enabled."* Not a rung-3 card, but it is the same surface rung 3's §5.3 UI replaces; scope was narrowed to copy-only |
| **rung 3 (`@ax/memory`)** | **no cards** | §5 above proposes a decomposition. **This is what gates rung 4** |

---

## 10. Decisions settled — 2026-09-20, and one premise this doc got wrong

Recorded at the start of the rung-3 decomposition run. §4 listed six decisions nobody had
made. Two were verifiable and were verified; four were human calls and were made. The
first one below **overturns a claim in §3 of this document.**

### 10.1 ⚠ §4.2 — the slot threshold does not exist, because the mechanism was killed at rung 0

**§3 of this handoff says the normalizer "cannot work at all without an embedder" and that
the provider plugin is therefore "the first thing on the critical path". That is wrong**,
and the evidence predates this document: `bench/normalizer-eval.ts:71` and
`docs/plans/2026-09-18-dem-rung0-report.md` §2 both already said so.

Rung 0 did not choose a threshold. It measured the embedding nearest-neighbour and found
it **structurally unusable**:

- **Calibration on truth needing no hand-labelling** — the rule over the synonym table's
  own canonical keys, where the right answer is known by construction — the nearest slot
  disagrees on **6 of 32**. `first name` → `birthday` at **0.834**, higher than almost
  every true positive in the corpus. These are not a threshold away from working.
- **Hand-checked precision at 0.78:** **13.2%** on a uniform random draw (7/53), **20.9%**
  on the top-by-fact-volume sample (9/43). Synonym rows excluded rather than used to
  inflate it.
- **At ≥0.88 the embedding half maps nothing** — the 22 rows that survive are exactly the
  synonym table.
- **The cause is structural, not wording.** Eight descriptions partition all 84,561
  predicates into eight nearest-neighbour cells; a slot cannot refuse a relation, only be
  further away than another. `birthday` became the cell for anything date- or
  number-shaped (`home_address` 0.811, `annual_gross_income` 0.799); `pronouns` became the
  cell for anything identity-shaped.

**Settled: the normalizer ships as the synonym table alone** — deterministic, ~22
entries, precision 100% by construction and auditable line by line, no embedder, no LLM.
Per-slot user-subject coverage is `lives_in` 175, `role` 118, `works_at` 51, `birthday` 2,
`name` 1, `timezone` 1, and **zero** for `pronouns` and `language`.

**Consequence for §5's DAG: card C does not depend on card A.** Slot derivation has no
embedder in it. Do not re-derive the threshold and do not rebuild the embedding path
"properly" — rung 0 already paid for that answer.

### 10.2 §4.5 — `rules.md` IS writable from the sandbox. It is a live Strata hole.

No longer UNVERIFIED. The static chain has no guard anywhere in it:

1. `rules.md` materializes into the runner's sandbox at `/agent/memory/system/rules.md`.
   `packages/sandbox-k8s/src/pod-spec.ts:844` mounts `agent` as a plain writable
   `emptyDir` — no `readOnly` — and `rules-store.ts` notes "the runner re-materializes
   `/agent` when it spawns".
2. The runner edits it → per-turn bundle diff → commit-notify → `workspace:apply`.
3. `packages/core/src/workspace-policy.ts` makes only `.ax/**`, `.claude/**`, `CLAUDE.md`
   and `CLAUDE.local.md` policy-visible, so **no `workspace:pre-apply` subscriber ever
   sees the change and none can veto it** — and that file's own comment states the apply
   "receives the FULL change set and lands everything."
4. `stripHumanTierChanges` guards only the host-side scratch→`/agent` flush — the
   **opposite** direction. `guardAutomaticWrite` guards host-side writers, also not this.
5. `rules.md` is injected verbatim at the top of every prompt.

So injected content that steers one file write becomes a permanent top-of-prompt
instruction — §6.3's persistence vector, reachable today. **This is filed as its own card
against `memory-strata`, ahead of rung 3**, not folded into the rung-3 human tier: it
benefits Strata now and rung 3 inherits the fix. A runtime walk still owes the confirming
repro (rung 5's item), but no guard exists to find.

### 10.3 §4.1 — the embeddings/rerank provider plugin stays first

Kept on the critical path **despite 10.1 removing its only hard dependent**. The reasoning
is rung 4, not the normalizer: the reranker is **80.0% vs 56.7%** on the n=30 smoke, and
that gap is large enough that measuring rung 4 without it would measure the wrong system.
Built per §6.5 — fixed hosts over HTTPS, credentials from the credential store, routed
through the existing egress lock, never a raw `fetch` with an env var, `google-auth-library`
dropped for a bearer token plus `fetch`. **Local-only mode is required**, with the accuracy
cost stated. Its own `security-checklist` pass. It registers the hook names TASK-434
already declared (`embedder?: { hook, model? }` / `reranker?: { … }`, vendor-neutral
payloads) — **one seam, not a second one**.

### 10.4 §4.3 — coexistence: a new preset, `presets/k8s` untouched

`@ax/memory` lands in its own preset with its own canary. `presets/k8s` keeps
`memory-strata`. Nothing migrates and nothing is at risk, `memory:rules:*` stays the shared
contract so the Rules UI works either way, and rung 4 measures the new preset head-to-head.
Invariant 4 holds trivially — never both for an agent. **Replacing Strata is rung 4's
decision and is not made here.**

### 10.5 §4.4 — import stays declined

Export only, as designed. It remains the honest adoption blocker named in §8; revisit if
rung 4 passes.

### 10.6 §4.6 — `kind` stays a passthrough

No change. The design already answers this: it is in the prompt that scored 87.4%, it has
no measured consumer, and it stays passthrough until ablated. Do not build a consumer for
it and do not strip it.
