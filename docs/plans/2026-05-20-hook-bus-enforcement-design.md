# Hook-bus service-boundary enforcement — Finding 2 (Codex 2026-04-29)

**Date:** 2026-05-20
**Status:** Shipped as PR #118 (2026-05-21). This document is the design that PR implemented; the "current behavior" described below is the pre-PR state it replaced.
**Context:** Architectural-debt finding 2 (`TODO.md` → "Architectural debt (Codex
2026-04-29)"). The architecture spec promises that service-hook returns are
Zod-validated and that each service hook has a timeout, but at design time
`HookBus.call` only awaited the handler and cast the
result — no validation, no timeout. Finding 4 (shipped 2026-05-20) already
caveated those doc claims as "not yet enforced"; this finding makes them real.
Finding 4 also settled where per-hook declarations live: **in code at the
service-registration site, never `package.json`.**

## Decision (approved)

Two guarantees, deliberately asymmetric in cost:

- **Timeout — universal.** Every one of the ~157 service-hook calls is bounded by
  a default timeout, overridable per hook. Catching a hung handler is nearly free
  and needs no per-hook authoring.
- **Return-shape validation — opt-in.** A hook may declare a Zod schema for its
  return; when present, `HookBus.call` validates against it. Adopted now on a
  small representative set (returns that cross the sandbox/untrusted boundary or
  carry secrets); convention established for the rest. We do **not** hand-write
  schemas for all 157 hooks (most just re-encode existing compile-time TS types).

## Architecture

### 1. Registration shape — optional 4th arg

Extend `HookBus.registerService` with an optional options object:

```ts
registerService<I, O>(
  hookName: string,
  plugin: string,
  handler: ServiceHandler<I, O>,
  opts?: { returns?: ZodType<O>; timeoutMs?: number },
): void
```

`returns` and `timeoutMs` are stored on the `RegisteredService` record. All ~157
existing 3-arg calls keep compiling and behaving identically (opts undefined).
The schema and timeout live next to the handler and its `<I, O>` generics — one
source of truth, no manifest churn. The manifest's `registers: string[]` stays
purely declarative (cycle detection).

### 2. Timeout enforcement (universal default + per-hook override)

`HookBus` gains a construction-time default:

```ts
new HookBus({ defaultServiceTimeoutMs?: number })  // default 120_000
```

`HookBus.call` races the handler against `timeoutMs ?? defaultServiceTimeoutMs`.
On expiry it throws `PluginError({ code: 'timeout', plugin, hookName, message })`
(`'timeout'` already exists in `PluginErrorCode`). Reuse the `withTimeout` race
pattern from `bootstrap.ts:160` — extract it to a shared `@ax/core` util (e.g.
`util/with-timeout.ts`) and use it in both places. The timer is `.unref()`'d so
it never keeps the event loop alive.

- **Default = 120 000 ms.** Comfortably above the IPC layer's heaviest ceilings
  (`IPC_TIMEOUTS_MS` tops out at 30 s for `tool.execute-host` /
  `workspace.commit-notify` / `materialize`). This is a **hang backstop**
  (deadlock, infinite await) — not a latency SLA.
- **Disable escape hatch.** `timeoutMs: Infinity` skips the timer entirely, for
  any genuinely unbounded hook. (We expect to use this rarely, if ever.)
- **Timeout ≠ cancellation.** A timeout stops the *caller* waiting; the handler
  promise keeps running (JS can't cancel it). For side-effecting long hooks this
  could otherwise orphan work, so they get explicit generous overrides:
  - `sandbox:spawn` → 300 000 ms (cold k8s image pull + scheduling)
  - `llm:call` (`@ax/llm-anthropic`) → 300 000 ms (long generations / slow providers)
  - any other hook found to legitimately exceed ~90 s during implementation gets
    an override rather than tripping the default.
  The losing (timed-out) handler promise must have a `.catch` attached so its
  eventual rejection never surfaces as an `unhandledRejection`.

### 3. Return-shape validation (opt-in)

After the handler resolves, if `returns` is set, validate:

```ts
const parsed = returns.safeParse(result);
if (!parsed.success) {
  throw new PluginError({
    code: 'invalid-return',   // NEW code added to PluginErrorCode
    plugin: registered.plugin,
    hookName,
    message: `service hook '${hookName}' returned an invalid shape: ${parsed.error.message}`,
  });
}
return parsed.data as O;
```

Add `'invalid-return'` to `PluginErrorCode` in `errors.ts`.

**Adoption set (this PR).** Selection criterion: returns that cross the
sandbox/untrusted boundary or carry sensitive data, preferring hooks with an
existing reusable Zod schema. Target ~3–5 hooks. Candidates to confirm during
planning (exact list pinned in the plan after checking for reusable schemas in
`@ax/ipc-protocol` / `@ax/workspace-protocol`):
- `workspace:read` — returns file bytes that the host ships to the sandbox.
- the credential-resolution hook (`credentials:*`) — returns secrets.
- one workspace mutation return (e.g. `workspace:apply` → `WorkspaceVersion`) to
  prove the pattern on a hook that already has a typed output.

The point of this PR is the **mechanism + a real, non-trivial adoption** (so it
is not half-wired), plus a documented convention for adding `returns` to a hook.

### 4. Out of scope

- Subscriber `fire()` — subscribers have no single return contract and their
  throws are already isolated/logged. Unchanged.
- Writing Zod return schemas for all 157 hooks.
- Any change to `PluginManifestSchema` (finding 4 blessed it; nothing here needs
  manifest fields).

## Data flow

`bus.call(hook, ctx, input)` → look up `RegisteredService` → run
`withTimeout(handler(ctx, input), timeoutMs ?? default)` → on timeout throw
`PluginError('timeout')` → on resolve, if `returns` present `safeParse` → on
failure throw `PluginError('invalid-return')`, else return parsed value. Existing
throw-wrapping (non-`PluginError` → `PluginError('unknown')`) is preserved and
now also wraps timeouts/validation as structured errors.

## Error handling

| Condition | Result |
|---|---|
| Handler exceeds timeout | `PluginError('timeout', plugin, hookName)` |
| Handler resolves, no `returns` declared | value returned as today |
| Handler resolves, `returns` set, shape OK | `parsed.data` returned |
| Handler resolves, `returns` set, shape bad | `PluginError('invalid-return', plugin, hookName)` |
| Handler throws `PluginError` | propagated unchanged (today's behavior) |
| Handler throws non-`PluginError` | wrapped as `PluginError('unknown')` (today's behavior) |

## Testing

Core unit tests (`packages/core/src/__tests__/`):
- handler that resolves within the timeout → value returned.
- handler that never resolves → rejects with `PluginError` code `'timeout'`
  (use fake timers; assert the timer is `.unref()`'d and no `unhandledRejection`).
- per-hook `timeoutMs` override beats the default (both directions).
- `timeoutMs: Infinity` → never times out.
- `returns` schema match → parsed value returned.
- `returns` schema mismatch → `PluginError` code `'invalid-return'`.
- 3-arg registration (no opts) → unchanged behavior, no validation, default timeout.
- construction-time `defaultServiceTimeoutMs` honored.

Plus: each adopted hook gets a test that a malformed return is rejected (in that
plugin's suite, or a focused core test using a stub handler).

## Documentation loop-closure (reverses finding 4's caveats)

Finding 4 added "not yet enforced" caveats. This PR flips them to reflect reality:
- `docs/plans/2026-04-22-plugin-architecture-design.md` failure-mode caveat →
  timeouts are enforced (universal default); return-validation enforced where a
  hook declares `returns`.
- `.claude/skills/ax-conventions/SKILL.md` two caveats (`hooks.call` list +
  failure-modes table) → same. Also document the 4th-arg `registerService` option
  in the hook-bus-mechanics section so the convention is discoverable.

## Boundary review

- **Hook-surface change?** This changes the bus *API* (`registerService`
  signature), not a service-hook payload. The addition is optional and additive;
  no existing payload field names change, nothing leaks backend vocabulary.
- **Alternate impl this enables:** any plugin can now declare a runtime return
  contract independent of the bus internals; the bus enforces uniformly.
- **Subscriber risk:** none — `fire()` is untouched.

## Security (full `security-checklist` runs at implementation)

This touches the `@ax/core` hook bus — the inter-plugin trust boundary — so the
`security-checklist` skill is invoked when the code is written (per invariant #5
and the skill's "@ax/core hook bus signatures" trigger). Summary of intent:
- **Prompt-injection / untrusted content:** return validation is a *hardening* —
  it rejects malformed/oversized hook returns (which may carry model/tool output)
  before they propagate to other plugins.
- **DoS:** the universal timeout bounds a hung or maliciously-slow handler, so one
  plugin can't wedge the host indefinitely.
- **No new capabilities, no new dependencies** (Zod is already a core dep). No
  filesystem/network/process surface added.
- Caveat to record: timeout ≠ cancellation (handler keeps running); overrides for
  side-effecting hooks prevent premature-timeout inconsistency.

## Out-of-band note

This work happens in a worktree **based on local `main` (`0dcad38b`)**, which
already contains finding 4 — so the caveat-flipping edits apply against the text
finding 4 introduced. Finding 4 is on local `main` only (unpushed), so finding 2
and finding 4 are both local-only until someone pushes; if these go to `origin`
later, the push includes both (4 then 2, or together). Nothing here depends on
`origin` state.
