# TASK-323 — teardown timeouts consistent with their own beforeAll

## Re-derived facts (from the tree, 2026-08-24 — NOT from the card)

**21 packages start a real container** in their tests (`new PostgreSqlContainer` /
`new GenericContainer` / `startPostgresContainer`) — 20 under `packages/`, plus
`presets/k8s`, which already satisfies the invariant below (60s/120s) and needs no
change:

agents, attachments, auth-better, channel-web, cli, connectors, conversations,
database-postgres, decisions, eventbus-postgres, host-grants, mcp-client, mcp-oauth,
memory-strata-index-postgres, onboarding, routines, session-postgres, skills,
storage-postgres, teams.

**13 of them do not carry the full `packages/agents/vitest.config.ts` pattern.**
9 have *no `vitest.config.ts` at all* — they run bare `vitest run`, so they inherit
vitest's 5s `testTimeout` and 10s `hookTimeout` defaults:

| package | current config |
|---|---|
| attachments, auth-better, connectors, conversations, decisions, host-grants, routines, skills, teams | **no config file** |
| channel-web, mcp-client, mcp-oauth | config exists, neither timeout set |
| cli | `testTimeout: 20000`, no `hookTimeout` |

(The card guessed 12 and omitted `cli`; the predecessor learning's correction to 13 is
the one that matches the tree.)

**108 of the repo's 751 test files contain at least one hook with an explicit timeout
AND at least one bare `afterAll`** — that bare teardown silently gets 10s (or, once a
config exists, whatever the config says). (The definition matters: an earlier draft of
this doc said "94", which came from an unstated first-hook-only heuristic. The figure
above is reproducible from the stated definition.) Dominant declared budget is `120_000` (79 sites), then
`60_000` (45 sites).

## The invariant this PR establishes

> A container-starting package sets **both** `testTimeout` and `hookTimeout`
> explicitly, and its `hookTimeout` is **at least the largest hook-timeout argument
> any hook in that package already declares**.

Rationale: an explicit `}, 120_000)` on a hook always overrides the config, so the
config value governs exactly the *bare* hooks — the teardowns this card is about.
Setting it to the package maximum gives every bare `afterAll` at minimum the budget
its own file's `beforeAll` already declares, **without editing those 108 files**.

Not chosen: a flat 30s (the card's original figure) — it would *tighten* the 79 sites
that declare 120s and *loosen* the ones that declare less. Not chosen: raising every
timeout everywhere — `cli`'s deliberate `testTimeout: 20000` stays as it is, because
it is already well above the default and nothing has failed against it.

Cost of a larger `hookTimeout`: none on a passing run. It is spent only when a hook is
*already* hanging, where it trades a faster red for a less ambiguous one.

## Tasks

### T1 — apply the timeout pattern (13 packages) + close 2 in-package inconsistencies
Per package: `testTimeout: 60_000` (the in-tree precedent, 8 packages already), and
`hookTimeout` = the package's own maximum declared hook argument.

- new config file: attachments(120), connectors(120), conversations(120),
  decisions(120), host-grants(120), routines(120), skills(120), teams(60),
  auth-better(60)
- add to existing config: channel-web(test 60 / hook 120), mcp-oauth(60/120),
  mcp-client(60/60), cli(hook 120 — its `e2e.test.ts` declares `}, 120000)`; `testTimeout: 20000` stays)
- **fix existing violations of the invariant:** `agents`, `onboarding` and `cli` set
  `hookTimeout: 60_000` while files in the same package declare `120_000` on
  `beforeAll` → raise all three to `120_000`. (`cli` was missed on the first pass and
  caught in review — the guard's close-brace regex could not see its describe-nested
  hook. Both the config and the regex are fixed.)
- unchanged (already satisfy it): database-postgres, eventbus-postgres,
  session-postgres, storage-postgres, memory-strata-index-postgres.

### T2 — make the fixed-iteration polls time-budgeted
`for (let i = 0; i < N && <cond>; i++) await sleep()` is a fixed iteration budget that
**no timeout setting can rescue**. Replace with `vi.waitFor` (a real wall-clock budget).

- `packages/auth-better/src/__tests__/init-awaits-adapter.test.ts:155` — the site the
  card names (200 × 10ms ≈ 2s).
- `packages/credential-proxy/src/__tests__/{acceptance,egress-events,integration-with-bridge}.test.ts`
  — 4 more sites of the identical defect (100 × `setImmediate`, i.e. no wall-clock
  budget at all). **In scope by decision** so the T3 guard can be repo-wide instead of
  carved out around known violations.

### T3 — the regression guard (Bug Fix Policy)
`scripts/__tests__/container-test-timeouts.test.js`, run by `pnpm test:scripts` — no
network, no Docker, no build, same posture as the other drift guards there:

1. every container-starting package sets both `testTimeout` and `hookTimeout`;
2. its `hookTimeout` ≥ the largest hook-timeout argument declared in that package;
3. no test source uses a fixed-iteration poll loop.

Each must fail against the pre-fix tree (13 packages fail 1, agents+onboarding fail 2,
5 sites fail 3) — verified by running the guard on `main` before the fix lands.

## Out of scope
The `57P01` swallow in `packages/test-harness/src/stop-postgres-container.ts` — the
card's own struck-through correction establishes it is narrow, deliberate, and not a
defect. Nothing to do.
