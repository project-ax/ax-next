# AX Platform — North Star and Decomposition

**Status:** Design. Decomposition only — no implementation plan yet.
**Date:** 2026-09-07
**Baseline:** verified against `origin/main` @ `05e6f2d3`
**Companions:** `2026-05-24-current-architecture.md` (as-built state) · `2026-04-22-plugin-architecture-design.md` (founding design)

---

## Why this doc exists

A set of platform requirements landed describing AX as a shared company platform for
every employee: simple enough for non-technical people, with visible spend in money and
tokens, a shared filesystem with per-folder access, a private brain per agent plus shared
knowledge, MCP connectors with OAuth, a credential proxy for non-MCP secrets, repo
checkout with sidecar services, and an optional terminal UI.

Most of it is already built. This doc separates what exists from what doesn't, splits the
remainder into sub-projects that can each be specced and shipped independently, names the
places where they collide, and commits to an order.

It is **not** an implementation plan. Each sub-project gets its own design doc and its own
plan.

> **A warning about shelf life.** An earlier draft of this analysis was written against a
> two-month-old checkout and confidently described the retrieval orchestrator as unbuilt
> when it had already shipped. Everything below was re-verified against `origin/main` on
> 2026-09-07. This repo moves fast. Check the tree before acting on any claim here.

---

## The north star

> An employee who has never opened a terminal can create an agent, give it files,
> knowledge and tools, and see exactly what it costs — without a colleague walking them
> through it.

**Definition of done is a walkable script, not a feature list.** A new employee, given
only a URL:

1. signs in
2. creates an agent
3. attaches a shared folder and connects one tool
4. runs a task that uses both
5. sees the tokens and dollars that task spent

When that runs end to end with nobody helping, the north star is met.

---

## Rules that bind every sub-project

1. **One ownership grain.** Everything — files, knowledge, agents, cost — attributes to a
   *user* or a *team*. Agents are already owned by one or the other. No sub-project
   invents a second identity model (invariant #4). This is the constraint that lets
   sharing and metering share a vocabulary instead of drifting apart.

2. **Agents are never grantees.** You share with a person or a team; an agent resolves its
   owner's grants. See Decision 3 for the cost of this.

3. **Metering never blocks.** Report-only. It observes, and is never in a position to fail
   a user's turn.

4. **Shared knowledge is single-writer.** Exactly one curator writes any shared corpus.
   Multi-writer shared memory is a persistent cross-agent influence channel and is out.

5. **Autopilot is the target.** Cold start is a known live failure, not a theoretical one.
   Anything assuming pod-spec freedom gets checked against Autopilot's constraints first.

6. **The six invariants and boundary review apply throughout.** Every new hook here is
   cross-plugin by nature, so each needs its alternate-impl answer and a leak check on
   payload field names.

---

## What already exists

Verified against `origin/main` @ `05e6f2d3`.

| Requirement | Status | Where |
|---|---|---|
| Shared NFS filesystem, per-agent isolation | **Built** | `@ax/workspace-filestore` — one export, `subPath = agentId` |
| Private per-agent brain | **Built** | `@ax/memory-strata` — Observer → inbox → Consolidator → docs |
| Tiered wiki retrieval (map + planner) | **Built** | `map.ts`, `orchestrator.ts`; `retrievalMode` defaults to `'orchestrator'` |
| Write-time rollups / reflect | **Built** | `rollup.ts` (TASK-199→201) |
| Human-owned memory tier rollup can't touch | **Built** | TASK-234 |
| Sensitive-content gate on extracted facts | **Built** | `sensitive-gate.ts`, hardened for LLM-written surfaces (TASK-217/221) |
| Distinct-source recurrence counting | **Built** | `recurrence.ts` — counts conversations |
| HTTP MCP connectors: bearer, API key, OAuth | **Built** | `@ax/connectors`, `@ax/mcp-client`, `@ax/mcp-oauth` |
| Credential proxy for non-MCP secrets | **Built** | `@ax/credential-proxy` — MITM, `ax-cred:` placeholders |
| GitHub **and** GitLab checkout | **Built** | `sandbox-protocol/git-credentials.ts` — host-generic |
| Sidecar services (Kafka, Mongo, …) | **Built** | `ServiceDescriptor` + k8s native sidecars |
| gVisor sandboxing, warm idle pods, reaping | **Built** | `@ax/sandbox-k8s` |
| Human approval queue (attendance, replay, expiry) | **Built** | `@ax/decisions` |
| Multi-provider model routing | **Built** | `@ax/agent-runner-core`, `@ax/llm-openrouter`, `PROVIDER_ENDPOINTS` |
| **Usage and cost metering** | **Absent** | zero runtime hits for cost/USD across the repo |
| **Folder sharing / ACLs** | **Absent** | resolver emits exactly one mount, own subtree only |
| **Shared knowledge corpus** | **Absent** | the wiki is per-agent; nothing shared |
| **External RAG as a retrieval tier** | **Absent** | the `<fts>` fallback hits our own index |
| **Sandbox pools / suspend / resume** | **Absent** | warm idle pods exist; no pooling, no checkpointing |
| **Terminal UI (ttyd)** | **Absent** | no references anywhere |

### How good the memory actually is

End-to-end LongMemEval-S against the shipped runtime — ingest through answer, ~48 haystack
sessions per question, real spend:

| Run | Retrieval | n | Accuracy | Correct refusal | False refusal |
|---|---|---|---|---|---|
| 2026-08-02 | BM25 only | 500 | **76.0%** | 83.3% | 8.1% |
| 2026-07-06 | Orchestrator | 100 | **78.0%** | 83.3% | — |

Weakest question types: multi-session 69.2%, knowledge-update 71.8%. Strongest:
single-session-user 84.3%. External published anchor is ~90.4% on a different stack — an
aim point, not a like-for-like comparison.

**The most useful thing these runs taught us:** extraction beat retrieval. Pulling facts
out of assistant turns moved the score 66.2% → 75.8% (PR #391) — one capture change
outweighing the entire retrieval architecture above it. Where memory quality is the goal,
spend on what gets written down before what reads it back.

---

## Decisions already made

These came out of the design conversation and are inputs to the sub-project specs, not
open questions.

1. **Report-only metering.** No budgets, no enforcement. Revisit only if hard limits are
   ever wanted — at which point the capture point must move (see A).

2. **Teams sync from the directory.** `@ax/teams` was built to be swapped for an
   IdP-backed implementation. Use that. No team-authoring UX — a sharing dropdown that
   already knows what "Engineering" means costs the user nothing to learn.

3. **Agents inherit their owner's reach; they are never grantees.** Cost: an agent cannot
   be given *less* reach than its owner. If per-agent narrowing turns out to matter it is
   an additive change to the grant subject, not a rewrite.

4. **One brain per agent. No multi-brain attachment.** This deletes the merge policy, the
   hot-tier budget contention, the write-arbitration matrix, and the temptation to add a
   scope key to the index contract.

5. **Shared *documents* are shared folders, not brains.** Handbooks and runbooks are files;
   an agent with file tools reads them directly. The index is for facts an agent *learned*.

6. **Shared *expertise* is a curated wiki with one writer** — not a knowledge agent. This
   is what removed delegation from the critical path.

7. **Conversations feed the agent's own brain automatically; the shared wiki only through
   gates.** Three gates — secret scan, recurrence across ≥2 distinct *people*, and a
   confidentiality ceiling — then curator approval.

8. **Team-visible agents contribute promotion candidates by default; personal agents opt
   in.** `visibility` is the privacy line, with different defaults on each side.

9. **A promotion may never widen reach beyond the narrowest grant of its sources.** A fact
   learned reading a Finance-only folder is promotable at most to Finance. Without this
   the grant model is decorative.

10. **The retrieval planner is provider-agnostic**, chosen by deployment config rather than
    architecture.

11. **Agent chat transcripts do not go into the external RAG.** Published artifacts and
    approved decision records may. Transcripts are mostly model output; indexing them
    launders assertion into authority, exports data out of our permission model into one
    we don't control, and drowns deliberate content in working chatter.

---

## The sub-projects

### A — Usage and cost metering · **New** · no dependencies

The largest untouched gap and the headline requirement. Capture usage in the runner, price
it on arrival, store raw turns plus daily rollups, show it.

**Capture point.** Three exist: the runner (the SDK's `result` message — cheap and
detailed, but inside the sandbox); the credential proxy (trusted, already MITMs TLS and
already carries a per-session egress-attribution token, but would need to parse SSE
response bodies on the hot path of every credentialed request); and provider-side invoice
reconciliation (authoritative for billing, blind to which employee).

Recommend **runner + reconciliation**. The honest caveat: our numbers are then as
trustworthy as the runner. Acceptable while nothing is enforced on them; reconciliation
catches systematic drift. **If hard limits are ever wanted, revisit — an under-reporting
runner would then mean free compute, and the proxy becomes the right answer.**

**Its spec must answer:**
- Record shape: who (originating human, team, agent), lineage (root + parent turn refs),
  tokens broken out (input / output / cache-read / cache-write — they price differently),
  and cost plus price-book version *alongside* raw counts.
- Rollup granularity and retention.
- `usage:record` boundary review. Alternate impl: an OpenTelemetry or BigQuery exporter.
- The employee view (dollars first, tokens behind a disclosure) and the admin view.
- Reconciliation cadence and what a drift alarm does.

**Non-negotiable now:** lineage fields ship in the first schema even though delegation is
deferred. Adding them later means a permanent gap in every report predating the change.

---

### B — Sharing and grants · **Extend** · blocks C

One primitive: `(resource, grantee, access)` where grantee is a person or team. New
`@ax/grants` plugin owning it. Alternate impl: an IdP- or Drive-backed grant source.

Today `workspace-filestore` emits exactly one mount, `subPath = agentId`, and the code is
blunt about why that is safe: *"other agents' subtrees are not even mounted."* Isolation is
structural. Sharing must not dissolve that.

The protocol already fits: `sandbox:resolve-mounts` returns an **array**, and `MountSpec`
already carries `readOnly`. No contract change — the resolver grows from one subtree to
own-plus-granted.

**Its spec must answer:**
- Export layout for shared subtrees and their in-sandbox mount paths.
- Grant resolution: agent → owner → grants → mounts, and what happens when a grant is
  revoked mid-session.
- The sharing UI: *Only me* / *Everyone* / *Specific people or teams…*, third collapsed.
- Directory sync for teams: source, cadence, failure behaviour.
- Mount-count ceiling under Autopilot pod-spec limits, and what a user sees at the cap.

---

### C — Shared knowledge · **Extend** · depends on B

Smaller than it looked. The tiered wiki already runs over each agent's own memory. Two
things are missing: making a corpus **shared**, and pointing the bottom tier at the
**company RAG** instead of our own index.

Three of the four moving parts exist: the secret gate, distinct-source counting (counts
conversations, needs to count people), and a human-owned tier automated rollup may not
touch. Approvals have a home too — `@ax/decisions` is a durable approval queue with
attendance, replay and expiry, so curator review is a new row type rather than a new
system.

**Its spec must answer:**
- The confidentiality ceiling — how a candidate's source reach is computed and enforced.
- Curator workflow, and how much a curator can safely approve at once.
- Provenance and staleness. **Non-deferrable.** A stale cached fact is worse than no cache
  because it short-circuits the lookup that would have returned the truth. Every page
  carries its source; volatile categories re-verify rather than trust themselves.
- Reaching the external RAG as an MCP connector, and how `<fts>` routes to it.
- Hot-tier budget when an agent carries both its own map and a shared one.
- Per-conversation opt-out, and how the default is disclosed to staff.

---

### D — Sandbox at scale · **Extend** · no hard dependency

Autopilot cold start is a live failure today; company-wide load makes it worse. Pools and
suspend/resume are the scale story.

**Its spec must answer:**
- Cold-start mitigation on Autopilot specifically.
- Pooling design — **and the B collision**: a pod warmed before we know the agent cannot
  carry that agent's mounts. Either pools are mount-generic and mounts attach late, or
  pooling only helps sessions with no shared folders. This must be resolved explicitly,
  not discovered.
- Whether GKE's managed agent sandbox is usable here (see spikes).

---

### E — Usability · **Extend** · continuous

Not a phase. A gate on every change in A–D, plus one consolidation pass before rollout,
measured against the north-star script. The `ux-design` skill and `ux-designer` agent
already exist for this; use them rather than inventing review criteria per PR.

---

### Deferred, with triggers

- **Agent delegation.** A manager agent handing work to reporting agents. Stopped being
  load-bearing once shared knowledge became folders plus a curated wiki. Revisit when a
  real workflow needs an agent to invoke another agent with *different* reach.
  Prerequisites when it returns: an explicit delegation grant, cycle detection, and the
  lineage fields A already ships.
- **Terminal UI (ttyd).** Genuinely optional; nothing depends on it. Revisit if power users
  ask for it after rollout.

---

## Interlocks

| Between | The collision | Resolve in |
|---|---|---|
| B ↔ D | Shared mounts are per-agent and fixed at pod creation; pre-warmed pools are generic by definition | D's spec, informed by B |
| A ↔ delegation | Delegated turns must bill to the originating human | A's first schema |
| C ↔ B | The confidentiality ceiling cannot be implemented without grants | C waits for B |
| C ↔ external RAG | Per-user scoped search requires per-document ACLs on their side | Spike before promising it |
| A ↔ enforcement | Capture point is in-sandbox; enforcement would need a trusted one | Only if limits are ever wanted |

---

## Sequencing

**Track 1 (independent, starts now): A.** Report-only metering touches no schema B or C
needs and never enters the turn loop. Starting it early makes the buildout's own cost
visible while rollout scale is still being decided.

**Track 2 (foundations, in order): B → C.** C's ceiling rule depends on B's grants. D runs
alongside as cluster work allows; it shares no code with B or C but must be designed with
the mount/pool collision in view.

**E gates every PR in both tracks**, plus one consolidation pass before company-wide
rollout.

Deferred work is not scheduled. It has triggers, not dates.

---

## Open questions — spikes before design

1. **GKE Agent Sandbox on Autopilot.** Does it support Autopilot, and what does it give us
   for pooling and snapshot/restore? Not answerable from memory; product surface moves.
   Blocks D's design, not its existence.

2. **Orchestrator vs BM25 as the default retrieval path.** *Isolated bench settled
   2026-09-11:* the planner wins by **11.2pp accuracy / 35.4pp recall@5** at n=500 — but only
   with `z-ai/glm-5.3-flash:nitro`. The model we ship (Haiku) is statistically tied with BM25
   (+1.8pp, z=0.69), and the old 7.6pp figure was measured against a since-deprecated Grok id.
   BM25 was re-measured in the same round and reproduced its May recall@5 exactly.
   Still open end-to-end: the gap there was ~2pp at unequal sample sizes, and E-glm now
   retrieves gold into the top 5 on 77.2% of questions while answering only 32.4% correctly,
   which points the next investigation at the ANSWER stage rather than retrieval. The
   `2026-07-07` levers brief flags this as WS1a. See
   `docs/plans/2026-09-11-orchestrator-accuracy-report.md`.

3. **External RAG per-document ACLs.** If "search my own past work" is wanted, the corpus
   must support ACLs that line up with our grants. If it doesn't, that feature lives on our
   side of the boundary. Cheap to check, expensive to assume.

---

## What this doc deliberately does not do

- No implementation plans. Each sub-project earns its own design doc, then its own plan.
- No card decomposition. That is `auto-ship`'s design-intake job once a sub-project's
  design exists.
- No re-litigation of the as-built architecture. Where this doc and
  `2026-05-24-current-architecture.md` disagree about what the code does today, that doc
  wins.
