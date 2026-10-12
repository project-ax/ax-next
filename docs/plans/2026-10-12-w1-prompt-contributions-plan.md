# W1 implementation plan — prompt contributions from several plugins

Spec: `docs/plans/2026-10-12-w1-prompt-contributions-design.md`. Decisions:
`.claude/memory/decisions/2026-10-12-AXWM-2.md`. One PR.

## Task 1 — `@ax/core`: shared contract (load-bearing: both sides import it)

New `packages/core/src/system-prompt-augment.ts`, re-exported from `index.ts`:

- `SYSTEM_PROMPT_AUGMENT_REQUIRED_PREFIX = 'system-prompt:augment:required:'`
- `SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX = 'system-prompt:augment:optional:'`
- `SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS = 32_000`
- `SystemPromptAugmentOutputSchema` — `z.object({ rules, context, recall: z.string().optional() }).strict()`
- `type SystemPromptAugmentOutput = z.infer<…>`, `type SystemPromptAugmentInput = Record<string, never>`

Tests: schema accepts `{}`, each field; rejects `null`, non-object, non-string body,
`null` body, unknown key.

## Task 2 — `@ax/chat-orchestrator`: discovery, isolated steps, ordering

- Replace the single call (`orchestrator.ts` "Phase 2B" block) with: list services by
  both prefixes; call each in parallel inside its own step (call → orchestrator
  deadline → schema → class rule → size). Log
  `system_prompt_contribution_failed { provider, class, reason }`.
- Any failed required provider → no augment at all (both strings stay `''`), log
  `system_prompt_augment_suppressed { provider }`.
- Otherwise join non-empty bodies in section order `rules`, `context`, `recall`,
  within a section by full service name, with `'\n\n'`. Bootstrap string = `rules`
  bodies only.
- `augmentDeadlineMs` config (default 15 000), rejected at init unless finite and > 0.
  Timer cleared + unref'd; the losing call's late rejection is swallowed.
- Unknown class segment under `system-prompt:augment:` → ignored, logged once.
- Update the type comment block, the manifest comment at `plugin.ts:123`.
- Tests (rewrite `__tests__/augment.test.ts`, migrate `orchestrator.test.ts` keepalive
  cases to the new name): every case in spec §6 "Orchestrator".

## Task 3 — `@ax/memory`: register as required

- Register `system-prompt:augment:required:memory` with `returns:
  SystemPromptAugmentOutputSchema`; return `{ rules, recall }` (omit empty ones).
- Drop the local `SystemPromptAugmentOutput` type in favor of core's; keep the
  public exports coherent (`SYSTEM_PROMPT_AUGMENT_HOOK` → new name).
- Manifest `registers`, stale memory-strata comment (`augment.ts:813`).
- Migrate tests; add the golden byte-for-byte check (normal = rules + `\n\n` + recall
  joined the orchestrator's way; bootstrap = rules) and a Rules-read-error-throws case.
- `scripts/memory-product-e2e.mjs` call site → new name.

## Task 4 — prose sweep (contract rule 5)

Comments that name `bootstrapSafe` / "bootstrap-safe contributions" / the bare hook as a
single-provider service: `ipc-protocol/src/actions.ts`, `sandbox-protocol/src/schemas.ts`,
`session-inmemory`, `session-postgres`, `agent-runner-core` prompt-engine/run-runner,
`core/src/workspace-policy.ts`, `ipc-core` commit-notify. Wording only.

## YAGNI pass

All four are load-bearing: 1 is the shared contract, 2 and 3 are the behavior change, 4
stops the next reader trusting a dead flag. No registry plugin, no per-section services.

## Security

Touches untrusted content assembly into the prompt → run `security-checklist` before PR.
