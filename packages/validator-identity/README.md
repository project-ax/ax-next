# @ax/validator-identity

Two jobs, one small regex scanner:

1. **`identity:scan`**: the write-time check on an agent's identity, soul and
   Instructions. `@ax/agents` calls it on every write, whether the agent or a person
   made it.
2. **A legacy `workspace:pre-apply` gate** on the agent's identity files under
   `/agent/.ax/`. Since TASK-989 identity lives in `@ax/agents` and the runner no longer
   reads those files, so this gate now guards files nobody uses. It goes away with the
   git workspace.

## `identity:scan` — the write-time check

`@ax/agents` stores an agent's identity, its soul and its people's Instructions. When a
runner starts, they are frozen into its session config and placed **verbatim into the
system prompt**. Text that lands there unchecked is a way to rewrite the agent's rules,
so every write gets checked first.

- **Input:** `{ text: string }`, one section's text. Anything that isn't an object with
  a string `text` throws a `PluginError` with code `invalid-payload`.
- **Output:** `{ verdict: 'clean' }`, or `{ verdict: 'refused', category, reason }`.
  `reason` is a fixed sentence of at most 160 characters that names the category. It
  never quotes the text.

The checks run in this order, and the first one that fails decides:

| # | Check | `category` |
|---|---|---|
| 1 | More than 262,144 UTF-8 bytes (256 KiB) | `too-large` |
| 2 | A lone UTF-16 surrogate, so the text has no valid UTF-8 encoding | `not-well-formed` |
| 3 | An injection signature from the Layer-1 regex set | `instruction-override`, `credential-exfiltration` or `obfuscation` |

Size goes first, so the regexes never run over an oversized text.

A refusal is an answer, not an error. `@ax/agents` saves the text only when the answer
is exactly `{ verdict: 'clean' }`; anything else means nothing is saved. A missing or
throwing scanner means nothing is saved either: `@ax/agents` fails closed. The service is
pure (no I/O, no bus calls) and logs `identity_scan_refused` with the category only,
never the text.

## The legacy pre-apply gate

This is the original job, from when the runner read identity out of markdown files:
`IDENTITY.md`, `SOUL.md`, and (optionally) `AGENTS.md` under `/agent/.ax/`. The runner
injected those files **verbatim into the system prompt**, so a write to one of them was
the agent rewriting its own system prompt. This gate was modeled line-for-line on
`@ax/validator-skill`. The runner no longer reads the files; the policy below still runs
on every `.ax/` write until the git tier is removed.

- **Bootstrap window** — while the host-seeded `.ax/BOOTSTRAP.md` is present in the
  committed workspace: the agent may write `IDENTITY.md` / `SOUL.md` and may **delete**
  `BOOTSTRAP.md` (the completion ritual).
- **After bootstrap** — writes to `IDENTITY.md` / `SOUL.md` / `AGENTS.md` are **allowed
  but flagged** (a structured `identity_self_edit` audit log; git history is the audit
  trail).
- **Always** — a `put` to `.ax/BOOTSTRAP.md` is allowed **only** when its bytes match the
  canonical `BOOTSTRAP_TEMPLATE` (the host's seed); any other content is **hard-vetoed**.
  An identity write carrying a **prompt-injection signature** (or non-UTF-8 bytes) is
  **hard-vetoed** too.

The bootstrap window is read from the committed state at the apply's `parent` (via an
optional `workspace:read`), never inferred from the change set — so a re-created
`BOOTSTRAP.md` cannot re-open the window.

## Capabilities

Registers `identity:scan` (pure, no I/O). Subscribes `workspace:pre-apply` + one optional
`workspace:read` call. No process spawn, no filesystem I/O, no network, no env access.
See [SECURITY.md](./SECURITY.md) for the three-threat-model walk.

## Wiring

Loaded in both the CLI preset (`@ax/cli`) and the k8s preset (`@ax/preset-k8s`, which
`@ax/preset-memory` builds on). `@ax/agents` calls `identity:scan` (declared as an
`optionalCall`, failing closed without it), and the `@ax/preset-memory` canary drives it
through the real assembly. The pre-apply gate is exercised by the Phase-3 commit-notify
canary in `presets/k8s/src/__tests__/acceptance.test.ts`. It is a leaf plugin — nothing
imports it at runtime except the presets.
