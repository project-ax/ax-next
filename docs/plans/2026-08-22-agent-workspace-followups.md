# agent-workspace epic — follow-ups plan (handoff)

**Written:** 2026-08-22, at the end of the auto-ship run that drained the epic.
**Repo state at handoff:** `main` @ `ceba2f2a`, CI green, 0 open PRs, To Do lane empty.

This document is a **session handoff**. Hand it to a fresh session and it can resume
without the original context.

---

## 1. What shipped

All 14 code cards of the agent-workspace epic merged (PRs #426–#439), 14/14 clean
`main` backstops, **0 parked**. The approvals substrate and the workspace surface are
both on `main`:

| Card | What landed |
|---|---|
| TASK-222 | Inventory of the enforced policy conditions (docs) |
| TASK-223 | `hold` — a third pre-call verdict that stops the turn |
| TASK-224 | `@ax/tool-policy` — rules that carry their own sentence |
| TASK-225 | `@ax/decisions` — the row, the store, the `tool:pre-call` subscriber |
| TASK-226 | Execute-on-approve — host replay, idempotency, expiry |
| TASK-227 | Attendance + the `decision-resolved` delivery |
| TASK-228 | The freshness guard + two real predicate producers |
| TASK-229 | `activityPhrase` / `countable` + the Right Now line |
| TASK-230 | The agent-centric shell on real data |
| TASK-231 | One Activity feed over one collection |
| TASK-232 | The Today queue on real decisions |
| TASK-233 | The Files and What-it-did tabs |
| TASK-234 | A human-owned memory tier the rollup may not touch |
| TASK-235 | The rail on real policy, counters and activity |

Both half-wired windows are **closed** (`tool-policy:list-capabilities`,
`agent-activity:get`), so CLAUDE.md invariant #3 holds for the epic.

### What "done" does NOT mean

- **Not acceptance-complete.** TASK-236 **failed** its cluster walk (fixes below);
  TASK-237 never ran.
- **The workspace surface is flag-gated.** `AX_AGENT_WORKSPACE_PREVIEW` (default OFF),
  read via `GET /api/features`; `/workspace` routes do not mount when off. It was left
  **ON** on the kind host deployment (`host.env`) for TASK-237.

---

## 2. How to resume

Everything below is already on the board as cards in **Backlog** (org `project-ax`,
project #1). Nothing needs re-filing.

```
/auto-ship
```

…drains **To Do**, not Backlog. So pick a wave from §4, drag those cards
Backlog → **To Do**, and auto-ship takes them. Or just say "drain wave 1".

**Before dispatching anything, read §5 (traps).** Several of these bugs exist
*because* of the traps in that list.

---

## 3. Two decisions needed from a human first

### 3.1 The spawn-budget hold

The auto-ship skill halts at **10 auto-spawned cards per run**. That run filed **21**.
It was not a runaway — every card is a distinct finding from a *successful* merge or
the walk, all depth-1, nothing spawned from a spawned card, 0 parked, 12 dispatches
against a 42 budget. But it is over the stated limit, so **all follow-ups were left in
Backlog and nothing auto-dispatches from them.** That hold is deliberate and is
waiting on a human. Either raise the cap for the next run or promote waves by hand.

### 3.2 TASK-247 is a process bug, not a feature bug — do it first

`ax-code-reviewer` **hung and never returned on 6 of 6 large cards** (TASK-225, 227,
231, 232, 233, 228). On three of them the missing review was hiding a **real blocking
bug** that would otherwise have auto-merged:

1. unfenced agent-authored text on a user-facing surface (bidi / Trojan source),
2. a control labeled "Pick another time" wired to **dismiss** — a user asking for
   details would have discarded their own held decision,
3. a permissions rail asserting reach a restricted agent does not have (false ALLOW
   on the blast-radius surface).

**The lead, corrected:** it is *not* diff size and *not* the agent type. The
orchestrator's own independently-dispatched `ax-code-reviewer` agents reviewed the
**same** large diffs (#432, #435, #436, #437) and all returned in 13–17 min. The
difference is that the hanging ones were **spawned by a builder deep into a long
yolo-ship session**. Look at nesting depth / parent-session state / accumulated
context. Whatever the cause, **make it fail loudly instead of hanging** — a silent
review gate is worse than no gate, because the merge is automated.

Until it is fixed, the mitigation that worked is: builders report `reviewer: hung`
honestly, and the orchestrator orders an independent pass before merging.

---

## 4. The waves

32 cards. Grouped so each wave is coherent and mostly parallel-safe.

### Wave 1 — unblock the epic's own acceptance (do first)

These are the walk-fail findings. Until they land, the epic is code-complete but
unverified, and **TASK-236 cannot re-run** (it is dep-gated on all three).

| Card | Why it matters |
|---|---|
| **TASK-261** | **No in-thread approval card on the default `/` chat surface.** `ApprovalCard` renders only inside flag-gated `/workspace`. On the shipping surface a held call gives the user a tool-error-looking message, an instruction to approve, and nowhere to approve it. Most user-visible bug of the set. |
| **TASK-260** | claude-sdk renders a hold as `mcp__ax-host-tools__request_capability failed` + an error blob containing the hold note and the `dec_…` id. Nothing failed — the agent is waiting on a human — but it reads as "it broke" and leaks internal ids. |
| **TASK-259** | Undo stays on screen ~7 s after the call already ran. Measured: resolved `05:29:43.108`, consumed `05:29:46.852`, button still "Undo · 6s" at `05:29:48`. The server is right (`undoable` flips on `consumedAt`); the client holds the approve response and never refetches. |

Then: **TASK-236** re-walk, then **TASK-237** (never ran).

Walks are **not** yolo-shippable — they run via `k8s-acceptance-loop` against
`kind-ax-next-dev`, one at a time, and do not consume a code slot. Gate is cluster
reachability only. Rebuild the agent image first (`--no-cache`, or grep the compiled
`main.js` in the image) — Docker layer caching has hidden runner fixes here before.

### Wave 2 — correctness on the approvals path

| Card | Why it matters |
|---|---|
| **TASK-253** | A replay stranded by a host crash mid-flight keeps its unique-index slot, so **re-approving the same call silently no-ops**. User clicks approve, nothing happens, no error. |
| **TASK-254** | Duplicate pending holds of the same call; approving the second absorbs a unique violation instead of being prevented at the gate. |
| **TASK-265** | Two rail counters have **no producer**. "Handled on its own" needs a `tool:pre-call` rollup (nothing counts tool calls). "You overruled it" is *uncountable by construction* — `decisions:undo` restores to `pending` and clears `resolved_at`, leaving no trace. On this surface a zero is a CLAIM: "you have never overruled me" is currently unfalsifiable rather than true. Either give them producers or do not render them. |
| **TASK-267** | A `when`-predicate rule **understates** on the rail — `catalogPermissions` evaluates against empty input. Understating is the survivable direction (overstating was TASK-235's blocking bug) but it is still a wrong claim on the blast-radius surface. |
| **TASK-264** | `readGrants` returns `ok`+`incomplete` instead of `failed` when `host-grants:list` throws and the wall has no subjects — a failed read sits under the "nothing granted" headline. |

### Wave 3 — silent failures and honesty (the repo's signature defect)

| Card | Why it matters |
|---|---|
| **TASK-239** | Pre-call fail-closed deny leaks raw `Error.message` to the model **as policy prose**. |
| **TASK-240** | Workspace-veto reasons reach stderr only, while the path always forces `git reset --hard` — user sees work discarded with no explanation. |
| **TASK-238** | `DISABLED_BUILTINS` denials collapse four distinct causes into one string. |
| **TASK-252** | `doneToday` undercounts — computed from the first fetched page only (default 50). Violates the surface's own "render a count only when positive **and true**" rule. |
| **TASK-256** | The inbox-loop "unknown delivery" branch is **dead on the real wire** (strict `z.discriminatedUnion` rejects upstream in `parseSuccessBody`), and its two tests only pass because the mock bypasses schema validation. Pick one: make the schema tolerant so the branch is reachable, or relabel it defence-in-depth and drop the forward-compat framing. |

### Wave 4 — infrastructure that blocks the pipeline

| Card | Why it matters |
|---|---|
| **TASK-255** | Suite fragility under concurrent containers. `onboarding`'s `model-route.test.ts:365` has a `5_000` budget that includes a full HTTP stack boot; `@ax/auth-better` independently hit testcontainers 10 s hook timeouts. **A red `main` halts the merge queue**, so this blocks unrelated work. Do not just widen the budget until a real hang would pass. |
| **TASK-246** | `decisions:list` runs the expiry sweep inline on every read. |
| **TASK-266** | The rail counter walks 7 statuses → **7 expiry sweeps per render**. Compounds with TASK-246. Wants a `decisions:count` with a window. |
| **TASK-248** | N+1 fan-out on `GET /api/workspace/state` (`conversations:list` per agent, then `session:is-alive` per conversation). |

### Wave 5 — one-source-of-truth and boundary hygiene

| Card | Why it matters |
|---|---|
| **TASK-245** | `DISABLED_BUILTINS` is **hand-copied** into `@ax/tool-policy` (with a drift-guard test) because it lives in `@ax/agent-claude-sdk-runner` whose package `main` IS the runner binary — importing it would violate invariant #2 and run top-level side effects. Two sources of truth for one concept (invariant #4). |
| **TASK-251** | `routines:recent-fires-for-agent` carries `FireRow.id` (BIGSERIAL) on the bus payload — storage vocabulary on a hook surface (invariant #1). Firewalled at HTTP, but the new hook propagates the pre-existing leak. |
| **TASK-241** | `skills:approved-caps-list` has no production caller — wire it or delete it (Half-Wired Code Policy). |
| **TASK-243** | Stale comment at `workspace-commit-notify.ts:289-290` claims a single pre-apply rejecter; there are three. |
| **TASK-262** | `request_capability` freshness digests the catalog entry, not resolved connector reach. **Judged non-blocking**: the executor builds a fresh permission card from live `connectors:resolve` at replay, so a changed reach is re-gated there. Document or fold in. |

### Wave 6 — gates the preview flag

**All of these must land before `AX_AGENT_WORKSPACE_PREVIEW` is defaulted ON.**

| Card | Why it matters |
|---|---|
| **TASK-249** | **No create-agent entry point from `/workspace`.** The nav row was removed rather than left dead, so the surface has no way to create an agent. Route the shipped conversational-identity flow in. |
| **TASK-250** | Day-one empty state for a user with one fresh agent and no history. |
| **TASK-258** | `local` workspace backend ignores ctx → Files listing is **deployment-wide** there. Pre-existing and shared with the identity editor and routines list; production uses the sharded `git-protocol` backend where reads are per-`sha256(userId/agentId)`. Acceptable only while the flag is off. |
| **TASK-257** | Workspace ctx uses the **caller's** `userId`, not the agent's `ownerId`. **Fails closed** (a non-owner reads their own empty shard — no leak), but a team agent's Files/Memory shows empty. TASK-234 has the identical property — **fix both together**. |

### Wave 7 — deferred design questions (need a human decision, not code)

| Card | The question |
|---|---|
| **TASK-242** | Connector manifests have no per-operation capability field, and neither `Capabilities` zod mirror is `.strict()`, so an added key is **silently stripped** — data loss, not a gate. Design §4.3.3 assumed otherwise. Add the field, or amend the design. |
| **TASK-263** | "Unguarded by default" has never been tested against the case it would be wrong for — no held tool currently spends money or sends outward. Becomes load-bearing the moment one does. |
| **TASK-244** | Tool progress-reporting channel so `countable` can pair with a real `{done,total}`. TASK-229 shipped the contract; nothing emits. |

---

## 5. Traps — read before building any of these

Hard-won during the epic. Several of the bugs above exist *because* of these.

**Testing**
- `pnpm build` catches what `pnpm test` cannot — it found three cross-package/cross-card
  shape drifts this run. `tsc` excludes `__tests__` in most packages, **but
  `channel-web` DOES typecheck its tests** (so lib-dependent APIs like
  `String.isWellFormed` fail there).
- `pnpm --filter @ax/<pkg> test` — `--filter` **before** the script name, or the whole
  repo suite runs silently.
- **A test whose setup cannot occur in production tests nothing.** Shipped a silent
  strand once (`parkForAgent` with an impossible precondition) and two
  production-unreachable tests (TASK-256) exactly this way.
- **Vacuity-check every regression test** by reverting the fix and watching it go red.
- `@ax/http-server` **lowercases every query key**, so a handler reading
  `req.query.agentId` gets `undefined` forever — and handler-level tests cannot catch
  it because they build the query object themselves. Any route with a query param needs
  **one round trip through the booted server**.
- `channel-web` has component tests in **two** directories (`src/__tests__/` and
  `src/components/workspace/__tests__/`).

**Hook bus / silent failure**
- `HookBus.fire` swallows a subscriber throw as a **clean pass**. On `tool:pre-call`
  that is a silent **ALLOW**. Do vetoes before `bus.call`.
- A `tool:pre-call` subscriber has **three** silent-failure shapes: throw → silent
  allow; any non-`undefined`/non-`Rejection` return → silent **call rewrite**; the bus
  stops at the first rejection so a `Hold` ahead of a deny pre-empts it.
- **Fail-closed is not uniform.** "Couldn't check for an approval" should fall through
  and hold again; "couldn't get a verdict" or "couldn't record the call" must reject.
- **A consumer cannot cap a hook it did not register.** `HookBus` default timeout is
  120 s; `tool.pre-call`'s IPC ceiling is 10 s — a producer that *hangs* takes the gate
  down as a **DENY** without ever throwing. Needs `timeoutMs` at registration **plus** a
  settle-then-race budget in the consumer.
- Soft-coupled hooks go in manifest **`optionalCalls`** (with a `degradation` note),
  never `calls` — `calls` fails the kernel's `verifyCalls` in canaries that drop the
  producer, and presents as unrelated routes 404ing. **Pair every `optionalCalls` entry
  with a preset test asserting the producer IS loaded**, or silent degradation is
  uncatchable forever.

**Untrusted content**
- Routine names, tool args, filenames and error strings are **agent-authored**
  (`validator-routine` only checks non-empty). Anything rendered must be fenced: strip
  C0/C1, zero-width, bidi overrides/isolates; cap by **CODE POINTS** (a UTF-16 slice
  splits surrogate pairs). Use `fenceLine` / `fenceBody` in `routes-workspace.ts`;
  **mirror it locally, never import across a plugin boundary** (invariant #2).
- Fence **server-side**, at the trust boundary — it bounds what goes on the wire, so a
  second renderer cannot reintroduce the hole.
- `/\s+$/` on user-typed text is CodeQL `js/polynomial-redos` (high). Use `trimEnd()`.

**Surfaces**
- On these surfaces **an empty array is a CLAIM**. Distinguish genuinely-empty from
  read-failed from hook-not-registered.
- **A control that does something other than what it says is worse than no control.**
- Never render a count you cannot substantiate.
- Render the rail from `provenance` + `verdict`, never by parsing `source`.
- When filtering a permissions list: **keep the denies**, drop out-of-scope allow/hold.
  And **only subtract what you proved** — sandbox built-ins are registered by the
  runner, not the host catalog, so their absence proves nothing. Overstating reach is
  the survivable direction; guessing a real capability away is not.
- Never send display strings (a server-computed `day`/`time` is a timezone bug that
  always *looks* right). Send an ISO instant; bucket and format at render.
- A feed that drops rows server-side must paginate on the last row **CONSIDERED**, not
  rendered, or an all-filtered page dead-ends silently.

**Process / git**
- **Never `git checkout`, `git switch`, or commit in the primary checkout**
  `/Users/vpulim/dev/ai/ax-next` while agents are running — the orchestrator holds it
  on `main` for the merge queue. A reviewer broke this once. Read other refs with
  `git show <ref>:<path>` or `git diff main...<ref>`, or use your own worktree.
- Every rebase conflict this run was in **`.claude/memory/*`**, always append-vs-append:
  keep **both** dated sections. Append a **new dated `###` section**, never extend an
  existing table.
- **The shared-`/**` doc-comment trap:** two additive sides of a `routes-workspace.ts`
  conflict can share one comment opener and one closing brace. The keep-both resolution
  then leaves the *next* function syntactically broken — **away from the conflict
  site**. Only `pnpm build` catches it.
- After a rebase, **verify the reviewed artifacts survived** — a resolution silently
  reverting a sibling card's security fix is invisible otherwise.
- Do not write raw NUL bytes into source (typing the char instead of the escape). The
  file becomes `data` to `file(1)` and **grep matches nothing in it**. Write `\uXXXX`;
  verify with `perl -ne 'exit 1 if /\x00/'`.
- CI runs on `pull_request` — a **CONFLICTING** PR gets **no CI at all**, so a stale
  "green" can be meaningless. Check `mergeStateStatus`, not just checks.
- The scratchpad root is **shared** across sibling agents (one overwrote another's
  `PR-BODY.md`). Use a per-task subdirectory.
- After each merge, check the **push-to-`main` full suite** — PR CI runs only affected
  packages, so cross-package breakage only shows there. Never merge onto a red `main`.

---

## 6. Board mechanics

- Board: org `project-ax`, project **#1** ("TO DO"). Lanes: Backlog · To Do ·
  Needs Input · In Progress · In Review · Done · Parked.
- Deps live in the **"Depends on"** text field. Empty = *not yet analyzed*;
  `none` = *analyzed, no deps*.
- Every follow-up card body carries `epic: agent-workspace` and a `parent:` line, so
  the provenance of each is recoverable from the card itself.
- **TASK-236** has `Depends on = TASK-259 TASK-260 TASK-261` (re-walk after fixes).
- Journal: `.claude/auto-ship-log.md` (gitignored, append-only) has the full timeline
  including every finding, correction and incident from the run.
