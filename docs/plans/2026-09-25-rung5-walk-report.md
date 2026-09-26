# Rung 5 walk report — the facts-memory preset on kind (TASK-519)

Walked 2026-09-25 against `kind-ax-next-dev`, Playwright MCP driving the real
UI, `host.preset=memory` on a live NFS export. Design:
`docs/plans/2026-09-18-dem-first-memory-design.md` §8 rung 5.

## Setup added

- `deploy/kind/memory-nfs/` — a dev-only kernel-nfsd server (Alpine pinned by
  digest, `nfs-utils` pinned), a Service with a pinned ClusterIP, and a README.
  The export admits only the node; a pod mounting directly is refused.
- `deploy/charts/ax-next/kind-memory-values.yaml` — the overlay
  (`host.preset=memory`, `memory.exports.*`). `memory.vertexProject` stays a
  `--set`. A chart test pins overlay server == Service ClusterIP.
- Chart and `presets/k8s` unchanged.

Credentials: Vertex (ADC token) and Cohere seeded through `credentials:set`
with an in-pod script — no product path exists (TASK-523). OpenRouter stored
through the admin Provider keys route.

## Walk results

| Step | First walk | After fix (rebuilt image) |
|---|---|---|
| Day-one empty state | Pass — authored copy, no codes/paths, both themes | Pass (fresh agent) |
| Profile after one chat | Pass once OpenRouter was stored; before that, extraction silently paused (TASK-525). Observer runs at the idle reap (~5 min), by design | — |
| Injected block reflects it next turn | **Fail for a new agent** — bootstrap mode drops the whole block incl. Rules (TASK-524). Pass once graduated: rules verbatim, profile provenance-tagged | — |
| Correction survives re-mention | UI profile, export profile, injected block: pass. **`memory_recall` + UI search: fail** — stale extracted value returned as current `[FACT]` beside the human `[UNKNOWN]` | **Pass** — restated old value hidden from API, UI search and agent `memory_recall`; a new value stays visible; history shows all rows |
| Forget | Pass — gone from UI, recall; export keeps it as `(until …)` (§5.2 convention) | — |
| History | Pass — closed rows with date and "Replaced by …" / "Forgotten" | Pass |
| Export visible + read-only at `/memory` (live mount) | Pass — `nfs4 (ro,…)`, `touch`/append → `Read-only file system` | Pass |
| `rules.md` unwritable from the sandbox | Pass — host refuses (`workspace_runner_immutable_refused`), UI rule unchanged, next turn commits normally. Side effect: sandbox copy keeps the edit, agent reports success, observer memorializes it (TASK-528) | Pass |
| Injection sinks (`\|`, newline, `[x](javascript:)`) | Pass — UI plain text, 0 anchors; evidence table and export escape `\|` and collapse the newline; chat renders the link with an empty href | Pass |
| Degraded mode (Cohere removed) | Pass — `degraded: ["ranking"]`, UI "Some search features are unavailable…", agent header `Degraded: ranking` | Pass |
| Contrast (measured) | Text: all enabled text ≥ 5.03:1 dark / 5.2:1 light. **Control boundaries 1.2–1.5:1** (app-wide `--input` token, TASK-527) | — |

## Fixed here

`memory:recall` (active reads) now hides a **re-mention**: a slot row whose
value matches a value the person's correction replaced, while a
higher-provenance row is active in that chain. Values are compared after
normalizing case, spacing and trailing punctuation. A genuinely new value
under an old human row ("I moved to Coimbra") stays visible, a forgotten value
doesn't count as replaced, and history still shows every row. The chain is
read whole, so a correction outside the retrieved pool still counts.

The first version hid *every* lower-provenance row under a human one (the
profile's rule); the preset canary caught that it also hid genuine moves said
only in chat, and the owner chose re-mention-only.

Regression test `packages/memory/src/__tests__/shadowed-slot.test.ts`: 5 of 8
cases fail against the unfixed code; the other 3 are controls (history, new
value, forgotten value). Live on the rebuilt image: the restated role is
hidden, the human correction shows. The benchmark corpus has no human rows,
so rung-4 numbers are unaffected.

## Filed (Backlog)

| Card | Finding |
|---|---|
| TASK-523 | No operator path for Vertex/Cohere credentials; Vertex is a 1-hour token |
| TASK-524 | Bootstrap mode drops the memory block, including Rules the UI promises |
| TASK-525 | Extraction paused (no OpenRouter key) is invisible; OpenRouter is undeclared |
| TASK-526 | Copy/legibility bundle (`[UNKNOWN]` human rows, raw subject id, "you lives in", unfiltered-looking search, …) |
| TASK-527 | Control boundaries fail 3:1 in both themes (shared `--input` token) |
| TASK-528 | Refused `rules.md` write leaves the sandbox copy changed; agent reports success; memory records it |
| TASK-529 | Export never rebuilt after the export volume is lost |
