# @ax/validator-identity

A `workspace:pre-apply` subscriber that gates an agent's writes to its own identity files
under `/permanent/.ax/`.

In the conversational-agent-identity model, an agent discovers who it is through
conversation and writes its own identity into markdown files: `IDENTITY.md`, `SOUL.md`,
and (optionally) `AGENTS.md`. The runner injects those files **verbatim into the system
prompt**, so a write to one of them is the agent rewriting its own system prompt. This
plugin is the gate on that — modeled line-for-line on `@ax/validator-skill`.

## Policy

- **Bootstrap window** — while the host-seeded `.ax/BOOTSTRAP.md` is present in the
  committed workspace (the one signal that means "still bootstrapping"): the agent may
  write `IDENTITY.md` / `SOUL.md` (it's creating itself) and may **delete** `BOOTSTRAP.md`
  (the completion ritual).
- **After bootstrap** — writes to `IDENTITY.md` / `SOUL.md` / `AGENTS.md` are **allowed
  but flagged** (a structured `identity_self_edit` audit log; git history is the audit
  trail). The runner's evolution guidance is what tells the user "it's your soul."
- **Always** — a `put` to `.ax/BOOTSTRAP.md` is allowed **only** when its bytes match the
  canonical `BOOTSTRAP_TEMPLATE` (the host's seed); any other content is **hard-vetoed**
  (it's host-seeded only — an agent-authored bootstrap script runs verbatim with no safety
  floor). An identity write carrying a **prompt-injection signature** (or non-UTF-8 bytes)
  is **hard-vetoed** too.

The bootstrap window is read from the committed state at the apply's `parent` (via an
optional `workspace:read`), never inferred from the change set — so a re-created
`BOOTSTRAP.md` cannot re-open the window.

## Capabilities

Subscribe `workspace:pre-apply` + one optional `workspace:read` call. No process spawn, no
filesystem I/O, no network, no env access. See [SECURITY.md](./SECURITY.md) for the
three-threat-model walk.

## Wiring

Loaded in both the CLI preset (`@ax/cli`) and the k8s preset (`@ax/preset-k8s`), and
exercised end-to-end by the Phase-3 commit-notify canary in
`presets/k8s/src/__tests__/acceptance.test.ts`. It is a leaf plugin — nothing imports it
at runtime except the presets.
