# TASK-608 — delete `@ax/memory-strata*`

Owner ruling (TASK-576): keep Strata only until the facts-memory switch (#762)
shipped and passed its walk (TASK-607), then delete it. Both are true. Old Strata
data is reset by the operator runbook in `deploy/README.md`, not by code.

## Decisions (full rows in `.claude/memory/decisions/2026-09-27-TASK-608.md`)

- **`host.preset=k8s` / `AX_PRESET=k8s` fail loudly.** "k8s" existed only to
  select Strata. Without Strata it would silently mean "no memory at all", so
  `serve` refuses it (exit 2) and `helm template` fails, both naming the facts
  preset and the runbook. `@ax/preset-k8s` stays as the base assembly
  `@ax/preset-memory` composes; it is no longer a bootable choice on its own.
- **Skill-reflection stays forced OFF** in the memory preset. TASK-611 (which
  re-enables it under facts memory) has not merged. Only the comment changes
  (now names TASK-611). The reflection prompt text is TASK-611's to rewrite: it
  cannot run while the routine is forced off.
- **Drop migration** lives in a small preset-k8s plugin that runs
  `DROP TABLE IF EXISTS memory_strata_index_v2_docs` (and the orphaned v1) at
  init, via `database:get-instance`. The owning plugin is gone, so the preset
  that wired it owns the cleanup.
- CLI (local dev) loses Strata and gets no memory product layer (follow-up).
- `memory:learned:read` had one registrant (Strata). channel-web's consumer of it
  (server branch, wire field, "What it worked out" UI) is removed.
- Tool-policy rules for Strata's tools (`memory_search`, `memory_read_section`)
  are removed.
- The facts benchmark harness (`scripts/memory-product-e2e.mjs`) imported four
  helpers from Strata's bench. They move to `scripts/memory-bench/` (judge
  without the OpenAI client, which the harness never used).
- Historical docs (`docs/plans/**` except the current-architecture doc,
  `.claude/memory/**`, `dem-memory/**` research) are left as history.

## Tasks

1. Delete the four packages; unwire CLI, preset-k8s (incl. `memoryOrchestratorModel`
   / `AX_MEMORY_ORCHESTRATOR_MODEL`), root tsconfig, eslint block, lockfile;
   memory preset exclusions + tests.
2. `AX_PRESET=k8s` refused in `serve`; chart `host.preset=k8s` fails render;
   remove `memory.orchestratorModel`; NOTES/values/schema/gke-values; chart tests.
3. Drop-table plugin in preset-k8s + unit test + real-postgres assertion;
   acceptance `PLUGINS_TO_DROP` + memory canary kept consistent.
4. Relocate bench helpers to `scripts/memory-bench/`; fix scripts tests.
5. channel-web: remove the `memory:learned:read` path end to end.
6. tool-policy: remove Strata tool rules.
7. Comment/doc sweep: every live reference made true today; deploy docs,
   architecture doc, ax-conventions skill, BACKLOG.
