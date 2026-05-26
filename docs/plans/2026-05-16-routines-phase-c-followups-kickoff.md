# Routines Phase C — follow-ups + MANUAL-ACCEPTANCE kickoff prompt

Copy the block below into a fresh Claude Code session. It's self-contained — assume the new session has no memory of the prior Phase C work beyond what's in project memory.

---

## Prompt

I want to close out two remaining items from Routines Phase C (PR #77, merged 2026-05-15, merge commit `06eb761`):

### (a) Three small follow-ups, single PR

Branch from `main` as `feat/routines-phase-c-followups`. Three changes, three commits (TDD where applicable). Then open the PR.

**F1 — Pin `croner` to `8.1.2`.** `packages/routines/package.json` currently declares `"croner": "^8.0.0"`. The security-checklist walk on PR #77 flagged this as Minor (caret range accepts a future supply-chain-compromised `8.x.y`). Lockfile already resolves to `8.1.2`. Change the version string to exactly `"8.1.2"` and run `pnpm install` to verify the lockfile diff is empty (it should be — same version).

Commit: `chore(routines): pin croner to 8.1.2 (PR #77 security follow-up)`.

**F2 — Sixth canary case for the rotation rebind end-to-end.** The Phase C canary at `packages/routines/src/__tests__/canary.test.ts` has five cases under `describe('Phase C webhook canary — half-wired window closure', ...)`. Add a sixth:

> case 6: `agents:webhook-token-rotated` fires the rebind subscriber, unmounts the old `/webhooks/<old>/...` route, and registers a fresh `/webhooks/<new>/...` route — proving the K5 rotation invalidates the old URL.

The existing harness stubs `agents:ensure-webhook-token` to return whatever token is in the `tokens` map. To test rotation: index a webhook routine (token = `tok-1`), capture the registered route + handler, mutate `tokens.set(agentId, 'tok-2')`, then `h.bus.fire('agents:webhook-token-rotated', h.ctx({ userId: 'u1' }), { agentId: 'agt_a' })`. Assert `captured.unregisters` contains `/webhooks/tok-1/r/x` AND `captured.routes` now also has `/webhooks/tok-2/r/x` AND `captured.handlers.size === 1` (old gone, new present).

The rebind subscriber lives in `packages/routines/src/plugin.ts` and uses `rebindWebhooksForAgent` from `packages/routines/src/sync.ts`. The sync-webhook unit tests already cover the helper in isolation; this canary case proves the bus wiring + subscriber dispatch.

Commit: `test(routines): canary case 6 — rotation invalidates old webhook route (K5 e2e)`.

**F3 — Duplicate `trigger.path` validator pass.** Two webhook routines under the same agent with the same `trigger.path` (e.g., two `.ax/routines/*.md` files both declaring `path: "/r/x"`) would currently both reach the `http:register-route` call site, where the second one fails with `duplicate-route` and gets logged via K10. That works but produces a confusing operator experience — the apply succeeds, the second routine silently has `last_status='error'`, and there's no clean signal.

Better: surface it as a validator veto at `workspace:pre-apply` time so the apply is rejected outright with a clear reason. Caveat that needs investigation: does `workspace:pre-apply` give the validator visibility into the FULL set of `.ax/routines/*.md` files in the post-apply tree, or only the changes? If only the changes, the validator can compare the changed files against each other for in-batch collisions, but a single-file change that collides with an unchanged existing file would slip through. The PR #77 design doc deferred this work explicitly; revisit and decide:

- Option A: in-batch only (cheap, only catches multi-file applies with same path). Better than nothing; matches what's actually a common case (operator edits two routines at once and types the same path by accident).
- Option B: full tree scan via a workspace read API at pre-apply time. Heavier; needs to confirm the API exists.
- Option C: defer further; document that `http:register-route` failures are surfaced via `routines:list` (`last_status='error'`, `last_error` non-null).

Pick the lightest acceptable option and implement. If Option C, just add a paragraph to `packages/routines/README.md` (create the README if missing) and skip the code change — but commit it as a docs change so the decision is captured.

Commit: `feat(validator-routine): reject duplicate webhook trigger.path within agent (PR #77 follow-up)` OR `docs(routines): clarify duplicate trigger.path posture (PR #77 follow-up)`.

### Steps for (a)

1. `git checkout -b feat/routines-phase-c-followups` from `main`.
2. Do F1, F2, F3 in order. Each is small (<200 LOC). Use TDD for F2; F1 is mechanical; F3 depends on which option you pick.
3. `pnpm build && pnpm test && pnpm lint` after each commit — all green.
4. `gh pr create` with a body that references PR #77 and lists each follow-up. Use the existing PR #77 body as a style reference.

### (b) MANUAL-ACCEPTANCE walk against kind

The "Receive a webhook (Routines Phase C)" scenario at `deploy/MANUAL-ACCEPTANCE.md` (around line ~780) is documented but has never been run. Walk it against a live kind cluster.

This requires the `k8s-acceptance-loop` skill (already installed in the project). Use it to:

1. Bring up the goldenpath kind cluster (`deploy/MANUAL-ACCEPTANCE.md` §Goldenpath: kind, steps 1-6).
2. Walk the wizard (`deploy/MANUAL-ACCEPTANCE.md` §First-use wizard).
3. Execute the webhook scenario — both no-HMAC and HMAC variants — and confirm each acceptance criterion.
4. Report back: which step failed (if any), what the actual vs expected behaviour was, what (if anything) in the Phase C code needs a follow-up fix.

If everything passes: post a comment to PR #77 marking the MANUAL-ACCEPTANCE box checked, with the date + cluster used + a one-line confirmation.

If something fails: open a fresh issue on GitHub describing the failure mode, then decide whether to fix it inside the follow-ups PR from (a) or as a separate PR.

### Order

Do (a) first because it's self-contained code work, then (b) which needs a live cluster and is harder to interleave. If (b) surfaces a real bug, the follow-ups PR from (a) is the natural home for the fix.

### Pre-work checklist for the new session

- Confirm `git branch --show-current` is `main` and `git status` is clean (other than the persistent `.claude/skills/shadcn/` and `.env.bench` untracked files — both pre-existing, unrelated).
- Confirm PR #77 is merged: `git log main --oneline -5 | grep "Phase C"` should show `06eb761 Merge pull request #77 from project-ax/feat/routines-phase-c-webhook`.
- Read `docs/plans/2026-05-15-routines-phase-c-design.md` §7.3 for the phase context.
- Read project memory `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md` for the prior phases' shipping notes.
- The k8s-acceptance-loop skill is at `.claude/skills/k8s-acceptance-loop/` — read its SKILL.md for the loop pattern before starting (b).

Don't start (b) without (a) done first — Phase D will read smoother on top of the closed follow-ups.
