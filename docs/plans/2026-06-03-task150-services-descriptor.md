# TASK-150 — neutral services descriptor + Capabilities.services grammar + validator

**Branch:** `auto-ship/TASK-150-services-descriptor` · **Base:** `main` · **Window: OPENS** (schema field exists, nothing renders it yet).

## Problem

Add the neutral, transport/storage-agnostic `services` descriptor to:
1. the `sandbox:open-session` wire contract (`@ax/sandbox-protocol`), and
2. the shared neutral `Capabilities` shape (`@ax/skills-parser`, consumed by CONNECTORS — TASK-100 moved capabilities off skills),

plus a validator that enforces digest-pin (I8), the descriptor caps, and rejects smuggled k8s vocabulary (I2). Depends on nothing. This is the contract slice that OPENS the half-wired window.

## Invariants honored
- **I2** — transport/storage-agnostic descriptor; reject `pod`/`container`/`securityContext`/`runtimeClassName`/`volume`/`emptyDir`/`initContainers`/`restartPolicy`.
- **I8** — digest-pinned images (`.+@sha256:<64hex>$`), validated at the wire boundary.
- **I11** — capabilities on connectors.
- **I12** — both `@ax/skills-parser` + `@ax/sandbox-protocol` are eslint-allow-listed pure schema/parser packages; no cross-plugin runtime imports.

## Descriptor shape (canonical, authored in `@ax/skills-parser`)
```ts
ServiceDescriptorSchema = z.object({
  name: z.string().regex(ID_RE),                       // diagnostics + container name
  image: z.string().regex(/.+@sha256:[0-9a-f]{64}$/),  // I8 digest pin
  ports: z.array(z.number().int().min(1).max(65535)).max(16),
  env: z.record(z.string().max(256), z.string().max(2048)) /* ≤32 entries via superRefine */,
  healthcheck: z.union([
    z.object({ kind: z.literal('tcp'), port: z.number().int().min(1).max(65535) }),
    z.object({ kind: z.literal('exec'), command: z.array(z.string().max(256)).min(1).max(16) }),
  ]).optional(),
  writablePaths: z.array(z.string().regex(/^\//).max(256)).max(16).default([]),
}).strict();  // .strict() rejects forbidden extra keys at the schema level
```
Array cap on the carrier: `services: z.array(ServiceDescriptorSchema).max(8).optional()` (Capabilities default `[]`).

## Tasks (TDD — test first each)

### Task 1 — `@ax/skills-parser`: descriptor interface + canonical Zod (load-bearing)
- Add `zod` to `packages/skills-parser/package.json` deps.
- New `packages/skills-parser/src/service-descriptor.ts`: `ServiceDescriptor` interface + `ServiceDescriptorSchema` Zod (+ `Healthcheck` types) — `.strict()` so unknown keys reject; env ≤32 via `.superRefine`.
- `capabilities.ts`: add `services?: ServiceDescriptor[]` to `Capabilities` interface; add a runtime `CapabilitiesSchema` Zod (new) that includes `services: z.array(ServiceDescriptorSchema).max(8).default([])`.
- `index.ts`: export the new types + the Zod schemas (`ServiceDescriptorSchema`, `CapabilitiesSchema`).
- Tests: descriptor accepts well-formed; rejects non-digest image, non-absolute writablePath, over-cap env (33 entries), forbidden extra key; Capabilities round-trips `services` through parse.

### Task 2 — `@ax/sandbox-protocol`: re-declare descriptor + wire it onto OpenSessionInput (load-bearing)
- `schemas.ts`: add a LOCAL `ServiceDescriptorSchema` (re-validation at the wire, McpServerSchema precedent) + `services: z.array(ServiceDescriptorSchema).max(8).optional()` on `OpenSessionInputSchema`. Reuse the existing `ID_RE`.
- Export `ServiceDescriptorSchema` type from index if useful for backends.
- Tests (in `schemas.test.ts` / new): well-formed descriptor accepted on OpenSessionInput; non-digest image rejected; non-absolute writablePath rejected; over-cap env rejected; forbidden extra key rejected; absent `services` still parses (back-compat).

### Task 3 — `@ax/connectors`: thread `services` through the local CapabilitiesSchema (load-bearing — I11 round-trip)
- `types.ts`: add a local `ServiceDescriptorSchema` mirror + `services: z.array(...).default([])` to the local `CapabilitiesSchema`; add `services?: ServiceDescriptor[]` is already covered by the type-import of `Capabilities` from skills-parser.
- Test: a connector capability spec carrying `services` round-trips through `validateCapabilities` (parse-on-write/read).

### Task 4 — `@ax/validator-service`: new plugin registering `services:validate` (load-bearing — closes the validator gap)
- New package `packages/validator-service` mirroring `validator-skill`'s structure (plugin.ts + index.ts + __tests__ + package.json + tsconfig).
- `services:validate` service hook: input `{ services: unknown[] }` (or the descriptor array); returns `{ verdict: 'clean' } | { verdict: 'invalid', reason }`. Enforces:
  - digest-pin (I8) — re-check `@sha256:<64hex>$` even though the schema does (defense-in-depth + clear reason),
  - caps (array ≤8, ports ≤16, env ≤32, writablePaths ≤16, command ≤16),
  - writablePaths absolute,
  - **forbidden vocabulary rejection** — scan descriptor keys (deep) for `pod|container|securityContext|runtimeClassName|volume|emptyDir|initContainers|restartPolicy`; the Zod `.strict()` rejects them at the top level, but the validator gives an explicit, named rejection (the card's "REJECTING forbidden vocabulary").
- Pure: NO spawn, NO file I/O, NO DB. Loads in both presets.
- Tests: rejects non-pinned image; rejects non-absolute writablePath; rejects a descriptor carrying a forbidden key; accepts a clean descriptor.

### Task 5 — wire `@ax/validator-service` into BOTH presets (load-bearing — I3 reachability)
- `packages/cli/src/main.ts`: import + push `createValidatorServicePlugin()` alongside the other validators.
- `presets/k8s/src/index.ts`: same. Add to `presets/k8s/package.json` deps + `presets/k8s/src/__tests__/preset.test.ts` loaded-plugin assertion (per `feedback_preset_drop_vs_load_lists` — preset.test asserts the full loaded set; acceptance.test has the DROP list).
- Add `@ax/validator-service` to root `pnpm-workspace`/tsconfig refs as needed.

## YAGNI pass
- Every task is load-bearing: T1/T2 = the contract (the card's core), T3 = I11 round-trip (capabilities live on connectors), T4 = the validator the card requires, T5 = I3 reachability (a plugin that isn't wired into a preset is half-wired). None cut.

## Security
Untrusted-input schema at a trust boundary → run `security-checklist`, paste the note in the PR.

## Acceptance
`pnpm build && pnpm test --filter @ax/sandbox-protocol --filter @ax/skills-parser` green; full `pnpm test` + `pnpm lint` clean. PR body notes "window OPEN".
