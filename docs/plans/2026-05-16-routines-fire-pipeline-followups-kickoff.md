# Routines fire-pipeline follow-ups — kickoff prompt

Three follow-ups surfaced during the 2026-05-16 cluster walk that closed out PR #77's MANUAL-ACCEPTANCE webhook scenario. The three load-bearing PRs (#81/#84/#85) are merged; what's left is plumbing that only shows up on the live cluster once those landed. Copy the block below into a fresh Claude Code session.

---

## Prompt

I want to close out the three open follow-ups uncovered during the 2026-05-16 Phase C MANUAL-ACCEPTANCE walk, then re-walk the scenario end-to-end and tick the four acceptance criteria on PR #77.

### Context

The Phase C webhook walk on 2026-05-16 (see `gh pr view 77 --comments` for the partial-pass report) verified that:

- ✅ **#80** (workspace-git-server delta author) — PR #81, merged
- ✅ **#82** (webhook CSRF bypass via `bypassCsrf` flag) — PR #84, merged. Plain external `curl` returns 202.
- ✅ **#83** (sandbox-k8s pod label sanitization) — PR #85, merged. Pod creates with sanitized `ax.io/session-id`.

What it found beneath those: the rest of the routine fire pipeline doesn't reliably complete end-to-end on the live cluster. Three concrete issues:

- **#86** — Routine `sessionId` is stable per routine (`routine-<agentId>-<routinePath>`), but `session:create` in `@ax/session-postgres/src/store.ts:178` rejects duplicates (even when the prior row is `terminated=true`). First fire works; every subsequent fire of the same routine fails at `session:create` with `session 'X' already exists`. One-line site is `@ax/routines/src/fire.ts:32`.
- **#87** — `@ax/routines`'s `init({ bus })` (`plugin.ts:53–96`) wires subscribers but doesn't scan `routines_v1_definitions` to re-mount webhook routes. The in-memory `webhookRoutes` Map is empty after every host pod restart; webhook URLs return 403 (no `bypassCsrf` flag set because no route is registered) until the agent triggers a real workspace change that touches the routine file. The mount logic exists — `rebindWebhooksForAgent` in `sync.ts` is the shape — it just isn't invoked on init.
- **Observation (not yet filed)** — Zero rows have ever been written to `routines_v1_fires` across the cluster's lifetime, even from fires that completed before the pod restart and the prior session's walks. The routines plugin's `chat:turn-end` subscriber (`plugin.ts:98–`) is what writes the fire row. Either (a) `chat:turn-end` isn't reaching the host from runner pods spawned via `agent:invoke` in the routine fire path, OR (b) the `reqId` in `ctx` is being rebound between fire dispatch and turn-end and `pending.get(reqId)` returns undefined. Needs triage before filing.

### Pre-work checklist

- `git branch --show-current` should be `main`; `git pull --ff-only` to be sure.
- `gh issue view 86 --json state,title` and `gh issue view 87 --json state,title` — both should be OPEN. If either is already closed/in-flight, find the branch with `gh search prs --state open "fire.ts" OR "webhook routes" --repo project-ax/ax-next` and pick up there instead of starting fresh.
- Read `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_routines_phase_c_walk_complete_2026_05_16.md` — has the cluster repro details (agent id, webhook token, routine path).
- Read `packages/routines/src/fire.ts` (whole file is ~110 LOC) and `packages/routines/src/plugin.ts:53–160` and `packages/routines/src/sync.ts:155–203` (`rebindWebhooksForAgent`) before starting (1) and (2).
- Skim `packages/routines/src/__tests__/canary.test.ts` — the harness pattern for routine fires + webhook tests is the shape any new tests should follow.

### (1) Close #86 — routine sessionId reuse

Single-line site in `@ax/routines/src/fire.ts:32`:

```ts
const baseCtx = makeAgentContext({
  sessionId: `routine-${row.agentId}-${row.path}`,
  ...
});
```

The `reqId` produced by `makeReqId()` later in the same function is already unique per fire — pull that up and use it in the sessionId. Suggested shape:

```ts
const reqId = makeReqId();
const baseCtx = makeAgentContext({
  sessionId: `routine-${row.agentId}-${row.path}-${reqId}`,
  agentId: row.agentId,
  userId: row.authorUserId,
  reqId,
});
```

Then drop the second `makeReqId()` call and the separate `fireCtx`. Be careful: `baseCtx` is currently passed to `agents:resolve` and `conversations:find-or-create` before `reqId` is computed; either reorder so reqId is minted first, or compose the sessionId from a small per-fire suffix (e.g., `randomUUID().slice(0,8)`) that doesn't depend on `makeReqId`. Either is fine — the constraint is "unique per fire".

Steps:

1. Branch from `main` as `fix/issue-86-routine-session-id-reuse`.
2. TDD: in `packages/routines/src/__tests__/canary.test.ts`, add a Phase C webhook case that fires the same webhook routine twice in a row and asserts both produce distinct sessionIds in the captured `session:create` calls (you'll need to add a `session:create` mock to the WebHarness — pattern matches the existing `http:register-route` capture).
3. Apply the fix in `fire.ts`. Keep the change tight — don't refactor surrounding code.
4. `pnpm build && pnpm test --filter @ax/routines && pnpm lint` — all green.
5. Commit + push + PR.

Commit: `fix(routines): per-fire sessionId so repeated fires don't collide (fixes #86)`.

### (2) Close #87 — startup rebind of webhook routes

In `@ax/routines/src/plugin.ts` `init({ bus })`, after the migration + subscriber wiring, add a startup pass that scans `routines_v1_definitions` and re-mounts webhook routes for every row where `trigger_kind = 'webhook'`. The existing `rebindWebhooksForAgent` in `sync.ts` already does the per-row mount; factor out the body so both the startup pass AND the rotation subscriber call the same helper.

One subtlety: at init time you don't have a per-agent rotation event — you need to iterate ALL agents that have webhook routines. The cleanest shape is probably a new exported helper `mountAllWebhookRoutesOnStartup(deps, ctx)` that does:

```ts
const rows = await deps.store.list({});            // no agentId filter
const byAgent = groupBy(rows, r => r.agentId);
for (const [agentId, agentRows] of byAgent) {
  for (const row of agentRows.filter(r => r.trigger.kind === 'webhook')) {
    // same body as rebindWebhooksForAgent's inner loop
  }
}
```

The per-row inner loop is identical to `rebindWebhooksForAgent` — extract it into a single helper that both callers use, so they can't drift.

Steps:

1. Branch from `main` as `fix/issue-87-routines-startup-rebind`. (Or stack on #86 if #86 isn't merged yet — call out either way.)
2. TDD: add a canary case that creates a webhook routine, simulates a fresh plugin init (close the harness + create a new one against the same DB), and asserts the same webhook route is re-registered with `bypassCsrf: true` without firing any `workspace:applied` event.
3. Implement the startup pass + the extracted helper.
4. `pnpm build && pnpm test --filter @ax/routines && pnpm lint` — all green.
5. Commit + push + PR.

Commit: `fix(routines): re-mount webhook routes from DB on plugin init (fixes #87)`.

### (3) Triage and possibly file the fire-row issue

Before doing anything code-side: **does fixing #86 also fix the fire-row gap?** Plausible chain: stable sessionId → session:create throws → fire path errors out before agent:invoke completes → no chat:turn-end → no fire row recorded. If #86 was the upstream cause, then after #86 lands you'd see fire rows appear and the observation auto-resolves.

So the order is:

1. Land #86 (PR from step (1) above).
2. Rebuild the kind image + redeploy (`docker build … && kind load … && kubectl rollout restart …`).
3. `DELETE FROM session_postgres_v1_sessions WHERE session_id LIKE '%routine%';` — clean the prior collision row.
4. Drive the chat UI via Playwright MCP to nudge `workspace:applied` (#87 workaround until that lands too).
5. `curl -i -X POST … /webhooks/$TOKEN/fixed` → expect 202.
6. Wait ~30s, query `routines_v1_fires`:

```bash
kubectl exec -n ax-next ax-next-postgresql-0 -- \
  env PGPASSWORD=$(kubectl get secret -n ax-next ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d) \
  psql -U postgres -d ax_next -c "SELECT id, status, error, conversation_id FROM routines_v1_fires;"
```

If a row appears: ✅ observation resolved by #86. Move on to (4).

If no row appears: this is a separate bug. File it. Likely places to dig:

- `packages/agent-claude-sdk-runner/src/runner.ts` (or wherever the runner emits its `chat:turn-end` IPC event) — verify it actually fires for fire-and-forget invokes from `agent:invoke`.
- `packages/ipc-core/src/handlers/` — look for the handler that forwards runner-emitted `chat:turn-end` onto the host bus. Confirm the `ctx.reqId` it carries matches what the routines plugin put into `pending`.
- `packages/routines/src/plugin.ts:102–` — the `chat:turn-end` subscriber's `pending.get(reqId)` lookup. Log what reqIds are landing vs. what's in pending.

A targeted instrumented run (host log + runner log + DB before/after) is what to capture in the new issue.

### (4) Re-walk the MANUAL-ACCEPTANCE scenario

After #86 and #87 are merged (and the fire-row issue is either resolved or has a known workaround):

1. Rebuild image from fresh main, kind load, rollout restart, port-forward (see `.claude/skills/k8s-acceptance-loop/SKILL.md`).
2. Cluster state on `ax-next-dev` should still have the agent + routine from the prior session — see `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_routines_phase_c_walk_complete_2026_05_16.md` for ids + token. If those are gone, re-walk the wizard + the agent-creates-routine prompt per `deploy/MANUAL-ACCEPTANCE.md` §"Receive a webhook (Routines Phase C)".
3. After #87 lands, you should NOT need to drive Playwright to nudge `workspace:applied` — the route should mount on startup. Verify by curl-ing immediately after rollout.
4. Walk both variants:
   - **No-HMAC**: 202 + new conversation + `received: <value>` in first user turn + fire row in `routines_v1_fires` with `status='ok'`.
   - **HMAC**: missing signature → 401, wrong signature → 401, correct signature → 202 + new conversation + fire row.
5. All four acceptance criteria from `deploy/MANUAL-ACCEPTANCE.md` L893-897 should pass on the same cluster lifetime (no manual `DELETE` between fires — that's what #86 buys).
6. `gh pr comment 77` updating the partial-pass note with the full ✅ + the date + cluster used + commit SHAs of the four PRs (#81/#84/#85 plus #86's PR, #87's PR).
7. Update memory `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md` to mark the walk as fully closed; supersede the partial-pass entry.

### Order

- (1) → (3 triage) → (2) → (4) is the natural order. Reasoning: #86 is a one-liner and a strong candidate to also explain the fire-row gap, so land it first and re-check. #87 lets us drop the Playwright nudge from the walk, which makes (4) reliable. Final walk after both.
- Stacking (1) and (2) into one branch is fine if you want fewer review cycles, but they're independent — separate PRs preferred. Don't bundle (3)'s triage findings into either: that's either resolved by #86 or earns its own issue + PR.

### Don't

- Don't try to make `session:create` idempotent (the broader contract change). The fix lives in `@ax/routines`, not `@ax/session-postgres`. Issue #86 calls this out.
- Don't add a `routines:rebind-all` admin HTTP endpoint as part of #87. The fix is to call the existing helper from `init`, not to expose a new external trigger.
- Don't claim the walk done in (4) without all four acceptance criteria observably passing on the same cluster lifetime — the prior 2026-05-16 walk was marked partial precisely because criterion 1's "first user turn contains `received: bar`" couldn't be observed.
- Don't refactor `fire.ts` or `sync.ts` beyond what each fix needs. Both files have known shape; preserve it.
