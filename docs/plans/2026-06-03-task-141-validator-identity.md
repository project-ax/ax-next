# TASK-141 — @ax/validator-identity (conversational-agent-identity Phase 3)

A new plugin: the **third** subscriber to `workspace:pre-apply`, gating identity-file
writes under the bootstrap-window policy. Modeled line-for-line on `@ax/validator-skill`
/ `@ax/validator-routine`. Veto-only (pass or `reject()`); declares its payload locally.

## Identity paths

- `.ax/BOOTSTRAP.md` — host-seeded; agent only ever DELETEs it (completion ritual).
- `.ax/IDENTITY.md`, `.ax/SOUL.md`, `.ax/AGENTS.md` — agent-authored identity files.

## Policy (the decision matrix)

The bootstrap window is **open iff `.ax/BOOTSTRAP.md` is present in the committed
workspace at `parent`** — read via `workspace:read('.ax/BOOTSTRAP.md', version=parent)`.
NOT inferred from the change set (an agent `put` of BOOTSTRAP must not open the window —
that's the TASK-139 un-gated-trust hole this validator closes).

For each change touching an identity path:

| change | window OPEN (BOOTSTRAP@parent found) | window CLOSED (post-bootstrap) |
|---|---|---|
| `put .ax/IDENTITY.md` / `.ax/SOUL.md` | allow (+ injection scan) | allow + log `identity_self_edit` (+ injection scan) |
| `put .ax/AGENTS.md` | allow (+ injection scan) | allow + log `identity_self_edit` (+ injection scan) |
| `put .ax/BOOTSTRAP.md` | **HARD VETO** (host-seeded only) | **HARD VETO** (re-creation attack) |
| `delete .ax/BOOTSTRAP.md` | allow (completion ritual) | allow (idempotent / already-deleted) |
| `delete` identity file | allow | allow |

- **Injection scan** (copied `regexScan`, Layer-1 pure regex from validator-skill) runs
  on every identity-file `put` content REGARDLESS of window. A signature → **hard veto**.
  This is the prompt-injection mitigation for self-edits.
- Non-identity paths (anything not `.ax/{IDENTITY,SOUL,AGENTS,BOOTSTRAP}.md`) → pass-through.
  (validator-skill still owns the `.claude/**` SDK-config veto; no overlap.)
- `workspace:read` unavailable → treat window as CLOSED (fail-closed-toward-stricter:
  no false veto on identity writes, but never grant the BOOTSTRAP-delete trust we can't verify).

## Tasks

1. **Package scaffold** — `packages/validator-identity/{package.json,tsconfig.json,vitest.config.ts}`;
   dep `@ax/core` only. Root `tsconfig.json` reference. (mechanical)
2. **`src/identity-safety-scan.ts`** — copy validator-skill's `regexScan` + `ScanHit` (Layer-1
   only, no LLM). + `identity-safety-scan.test.ts` (the validator-skill scan tests, retargeted).
3. **`src/plugin.ts`** — `createValidatorIdentityPlugin()`: manifest
   (`subscribes:['workspace:pre-apply']`, `optionalCalls:['workspace:read']`, registers/calls []),
   local `PreApplyPayload`, the policy above. `src/index.ts` export.
4. **`src/__tests__/plugin.test.ts`** — manifest test; bootstrap-window allow (IDENTITY/SOUL put +
   BOOTSTRAP delete, with a `workspace:read` stub returning found); post-bootstrap allow-but-log
   (read returns not-found); BOOTSTRAP put hard-veto (both windows); injection-signature hard veto;
   read-unavailable degrade; non-identity pass-through.
5. **Wire CLI preset** — `packages/cli/{package.json,tsconfig.json,src/main.ts}`: add dep + ref +
   `plugins.push(createValidatorIdentityPlugin())`.
6. **Wire k8s preset** — `presets/k8s/{package.json,tsconfig.json,src/index.ts}`: same.
7. **Preset assertions** — `presets/k8s/src/__tests__/preset.test.ts`: add `@ax/validator-identity`
   to the plugin-set list + a `subscribes workspace:pre-apply` assertion. (canary reachability:
   the Phase-3 canary harness boots the full k8s preset, so the validator is automatically in the
   commit-notify → workspace:apply → pre-apply loop once it's in the preset.)
8. **SECURITY.md + README.md** — threat-model note (security-checklist output) + a short README.
9. **Gate** — `pnpm build && pnpm test` (validator-identity + cli + k8s) + `pnpm lint` scoped.

## Invariants / boundary review

- **#1/#2:** no new hook signature; reuses `workspace:pre-apply` (existing `.ax/`-filtered payload)
  + `workspace:read` (existing). Payload declared locally. No cross-plugin runtime import (scan is
  copied, not imported). validator-identity is a leaf — NOT added to the eslint allow-list (nothing
  imports it at runtime but the presets, already allowed importers).
- **#3:** loaded in BOTH presets + reachable from the Phase-3 canary in THIS PR.
- **#5:** capabilities = subscribe pre-apply + optional read; NO spawn, NO file I/O, NO net.
- **Boundary review:** alternate impl of pre-apply = the existing git/GCS backends; payload fields
  = `changes`/`parent`/`reason` (already `.ax/`-filtered, storage-agnostic — no leak); subscriber
  risk = none (we never key off a backend-specific field; `parent` is passed opaquely to
  `workspace:read`). No IPC wire surface.
