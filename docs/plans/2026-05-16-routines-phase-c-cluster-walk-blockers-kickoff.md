# Routines Phase C cluster-walk blockers — kickoff prompt

Three follow-ups left before PR #77's MANUAL-ACCEPTANCE webhook scenario can be walked end-to-end. PR #81 (issue #80) is open and was the load-bearing one — the other two (#82, #83) surfaced during the live verification after #81 landed locally. Copy the block below into a fresh Claude Code session.

---

## Prompt

I want to close out the three open blockers on PR #77's MANUAL-ACCEPTANCE webhook scenario, then walk the scenario against the live `ax-next-dev` kind cluster.

### Context

Phase C webhook trigger (PR #77, merged `06eb761` on 2026-05-15) and its follow-ups (PR #78, merged 2026-05-16) shipped clean. Live cluster verification on 2026-05-16 surfaced three independent bugs:

- **#80** — `@ax/workspace-git-server`'s `apply` and `applyBundle` returned a `WorkspaceDelta` with no `author` field. The local backend (`@ax/workspace-git-core`) sets it from ctx; the multi-replica backend didn't. Subscribers that key off `delta.author.agentId` (only `@ax/routines` today) silently early-returned on every `workspace:applied`. **Fix in PR #81** — `git log origin/main..origin/fix/issue-80-workspace-git-server-delta-author` to see it; verified end-to-end against the cluster. As of this kickoff, PR #81 is open and may or may not be merged.
- **#82** — Webhook routes hit `@ax/http-server`'s CSRF subscriber. Plain external `curl` POST returns 403 `csrf-failed:origin-missing`. The MANUAL-ACCEPTANCE doc shows a plain-curl form that doesn't work. Webhook receivers are explicitly external; the URL token IS the auth (Phase C design §5).
- **#83** — When `@ax/routines` fires a webhook routine, `@ax/sandbox-k8s` tries to create a runner pod with the label `routine-<agentId>-<routinePath>`. The routine path contains `/` (invalid k8s label char) and the full string exceeds 63 bytes. Pod create fails 422.

All three are required for the MANUAL-ACCEPTANCE walk to succeed.

### Pre-work checklist

- `git branch --show-current` should be `main`; `git status` clean other than the persistent `.claude/skills/shadcn/` and `.env.bench` untracked files.
- Check PR #81 status: `gh pr view 81 --json state,mergeable,statusCheckRollup`. If merged, fast-forward main and skip the #81-related re-test (its acceptance already happened). If still open, you may need to wait for review or rebase if conflicts.
- Read `docs/plans/2026-05-15-routines-phase-c-design.md` §5 (route handler chain) and the CSRF subscriber in `@ax/http-server` before starting (1).
- Read `@ax/sandbox-k8s/src/pod-spec.ts` (search for the routine-source label composition) before starting (2).
- The k8s-acceptance-loop skill at `.claude/skills/k8s-acceptance-loop/` is the recipe for the cluster walk in step (3). Read its SKILL.md first.
- Project memory: `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md`. The 2026-05-16 entries cover the prior session's diagnoses; the workspace-sync-missing one notes that #79 was a wrong-diagnosis dead-end superseded by #80.

### (1) Close #82 — webhook routes bypass CSRF

Per the issue, two options:

- **Option A — per-route opt-out flag** on `http:register-route` (recommended). Extend `HttpRegisterRouteInput` with optional `bypassCsrf?: boolean`. The CSRF subscriber in `@ax/http-server` checks whether the matched route has the flag and skips when true. `@ax/routines` sets it when registering webhook routes.
- **Option B — path-prefix exemption** in the CSRF subscriber, hardcoding `/webhooks/*`. Simpler but couples http-server to routine semantics. Reject unless A turns out to be unexpectedly invasive.

Steps:

1. Branch from `main` as `fix/issue-82-webhook-csrf-bypass`.
2. Add `bypassCsrf?: boolean` to `HttpRegisterRouteInput` in `@ax/http-server`'s types. Plumb through the route registry. The CSRF subscriber should consult the registered route's flag at check time. TDD: write a `@ax/http-server` test that asserts a route registered with `bypassCsrf: true` accepts a no-Origin POST while a default route still rejects.
3. In `@ax/routines/src/sync.ts:112-124` (the `http:register-route` call site inside `handleWorkspaceApplied`), set `bypassCsrf: true` on the webhook route registration. Same place in `sync.ts`'s `rebindWebhooksForAgent` if that path also registers routes directly.
4. Add a canary case to `packages/routines/src/__tests__/canary.test.ts` (case 7?) that asserts the registered route has `bypassCsrf: true` in the captured input. Mirror the shape of the existing case 4 (valid POST → templated agent:invoke).
5. `pnpm build && pnpm test && pnpm lint` — all green.
6. `gh pr create` referencing #82. Update MANUAL-ACCEPTANCE.md if anything in the curl form changed (it should NOT — the doc's plain curl will Just Work after this).

Commit: `fix(http-server): bypassCsrf flag for routes that opt out (fixes #82)`.

### (2) Close #83 — sandbox-k8s pod label sanitization

Per the issue, two options:

- **Option A — drop the routine path from the label entirely** (recommended). k8s labels are for selector matching; routine identity is already captured in pod env vars and the fire row's `path` column. Cleanest.
- **Option B — slugify + truncate**: replace non-`[A-Za-z0-9._-]` chars with `-`, truncate to 63 bytes with a short stable suffix (last 8 chars of sha1 of original) to keep collisions deterministic.

Pick A unless there's an existing selector that keys off the label (grep the codebase for the label string first; if no selectors use it, A is safe).

Steps:

1. Branch from `main` as `fix/issue-83-pod-label-sanitization`.
2. Find the label composition in `packages/sandbox-k8s/src/pod-spec.ts` (or wherever the routine-source label is set). Grep `routine-` to locate.
3. Implement Option A or B. If A: just remove the label. If B: add a tiny `sanitizeLabel(s)` helper with the rules above and use it.
4. TDD: add a `pod-spec.test.ts` case that constructs a pod spec for a routine fire with a path like `.ax/routines/long-name-1234567890.md` and asserts (A) the label is absent OR (B) the label value matches the k8s regex `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?` and is ≤ 63 bytes.
5. `pnpm build && pnpm test && pnpm lint` — all green.
6. `gh pr create` referencing #83.

Commit: `fix(sandbox-k8s): sanitize pod label for routine fires (fixes #83)` OR `fix(sandbox-k8s): drop routine-path label (fixes #83)` depending on which option you pick.

### Steps for (1) + (2)

- They're independent — do them in parallel or sequentially, doesn't matter. Each is its own PR.
- Reviewer-bandwidth note: keep each PR small (<150 LOC including tests). Don't bundle them.

### (3) MANUAL-ACCEPTANCE walk against the kind cluster

Once PRs #81, #82, #83 are all merged, walk the scenario.

Use the `k8s-acceptance-loop` skill — it has the recipe.

The cluster state from the prior session may still be live (`kind get clusters` will show `ax-next-dev` if so). If yes:

1. Rebuild image from current main: `docker build -t ax-next/agent:dev -f container/agent/Dockerfile .`
2. Kind load: `kind load docker-image ax-next/agent:dev --name ax-next-dev`
3. Rollout: `kubectl rollout restart -n ax-next deployment/ax-next-host && kubectl rollout status -n ax-next deployment/ax-next-host --timeout=180s`
4. Port-forward: `kubectl port-forward -n ax-next svc/ax-next-host 9090:9090 &`

If the cluster has been torn down, follow `deploy/MANUAL-ACCEPTANCE.md` §Goldenpath: kind steps 1-6 to bring it back up, walk the wizard (the admin user `vinay@canopyworks.com` was created on 2026-05-16; if it's gone, re-walk per the doc's first-use wizard scenario).

Then walk `deploy/MANUAL-ACCEPTANCE.md` §"Receive a webhook (Routines Phase C)":

- The no-HMAC variant should reach `HTTP/1.1 202`, a new per-fire conversation should appear in the sidebar, and the first user turn should contain `received: bar` (or whatever payload value you sent).
- The HMAC variant: store credential, edit routine to add hmac block, test missing/wrong/correct signatures.
- All four acceptance criteria from MANUAL-ACCEPTANCE.md L893-897 should pass.

If everything passes:

1. `gh pr comment 77` marking the MANUAL-ACCEPTANCE box checked, with the date + cluster used + the four acceptance criteria confirmed.
2. Update memory `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md`: mark the workspace-sync-missing memory file as fully resolved (issues #80/#82/#83 all merged).
3. If MANUAL-ACCEPTANCE.md still references `/workspace` as the runner path (L86, L88, L219), open a tiny docs PR updating to `/permanent` — the actual runner layout per the runner-owned-sessions redesign.

If anything fails:

- The failure is most likely either (a) an interaction between the three fixes that wasn't anticipated, or (b) a new bug. Capture the signal (host log, runner log if catchable, DB state of `routines_v1_definitions`+`routines_v1_fires`), file a new issue, decide whether to fix in one of the open PRs or as a separate PR.
- Don't claim done if any criterion fails.

### Order

- (1) and (2) in parallel; either order. Both are small.
- (3) after both land on main (or against a stacked PR if you'd rather verify before merge — but the cluster walk is the merge gate, not the other way around).

### Order vs PR #81

If PR #81 is still open when you start: pick whichever path is easiest with your reviewer's bandwidth. Option Q: stack #82 and #83 on top of `fix/issue-80-...` so the cluster walk in (3) can verify all three in one go. Option R: merge #81 first, then branch #82/#83 from a fresh main. Option R is cleaner if there's no reviewer urgency.

### Don't

- Don't bundle the three fixes into one PR. They touch different packages and have independent review concerns (http-server CSRF, sandbox-k8s pod-spec, workspace-git-server delta).
- Don't update MANUAL-ACCEPTANCE.md's runner path (`/workspace` → `/permanent`) inside any of these fix PRs — open a separate tiny docs PR for that so it doesn't get lost in a code-review discussion.
- Don't claim MANUAL-ACCEPTANCE done without actually walking it against the rebuilt image — the verify-end-to-end-against-rebuild step is the contract.
