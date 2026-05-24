## Routines

- [ ] **Default routines for team agents (fire-under-team policy).** Spun out of the PR #105 fix: `agents:list-personal-owners` excludes team agents because routing a default fire under "the team" needs a policy answer — does the routine fire under each member separately, under the team creator, under a designated steward? Pick up when team agents become a real surface; for now, team-owned agents simply don't get default routines materialized.
- [ ] **Cron + webhook triggers for default routines.** Deferred per I-R5 / HP7. Cron needs a croner evaluator in claim SQL; webhook needs per-default tokens + live rebind on admin edit. Pick up when a real caller needs it.
- [ ] **Phase F — conversation titles.** Branch parked. New piece of work, not a follow-up.
- [ ] **Per-team / per-tenant scoped default routines.** Not currently load-bearing.
- [ ] **Per-agent opt-out for default routines** beyond the current override-by-name mechanic.
- [ ] **"Drift indicator" UI** (visibility into stale `definition_updated_at`).
- [ ] **Default → workspace "promote" flow.**

## Skills (Phase 1 follow-ups from PR #96)

- [ ] **System-prompt fold for skill descriptions** (Phase A — **PARKED**). SDK-only today (SDK indexes description into prompt + invokes `Skill` tool on demand). Formally parked in `docs/plans/2026-05-20-skills-capability-lifecycle-impl.md` — trigger to un-park is either `packages/agent-native-runner/` gaining `src/` or `packages/test-harness/` adding a real-LLM code path. No code lands until then; when the trigger fires, write a fresh `docs/plans/YYYY-MM-DD-skills-system-prompt-fold-impl.md`.

## Attachments / artifacts

- [ ] **`$CLAUDE_CONFIG_DIR/sessions/` mirroring.** Today's scaffold only links `projects/`. Add a sibling symlink if a future feature needs session metadata in the workspace.

## Auth / onboarding cleanup (Phase 4 + Phase 5 follow-ups)

These wait on stated triggers — don't ship pre-emptively.

- [ ] **`ax admin reset-password` CLI + `/auth/reset-password` route.** Pick up when local password sign-in becomes a real surface (wizard re-adds password OR Settings → Password lands). Today the wizard captures only name+email against `@ax/auth-better` (which silently ignores the optional `password` input until the local-password slice lands).
- [ ] **Walk the Google new-user gate-*allow* branch live.** The PR #116 `kind` walk used the existing admin email, so it exercised account-LINKING + the cookie bridge + the gate's reject branch — but NOT brand-new-user creation (gate allows an in-domain email → creates a `role:'user'` row with the Google-supplied name). That path is unit-tested only. Pick up next kind walk with a second `@<allowed-domain>` Google account on hand.
- [ ] **Port the gated `k8s-e2e` tests off `/auth/dev-bootstrap`.** `presets/k8s/src/__tests__/k8s-e2e/helpers.ts:42` + `credentials-admin-roundtrip.test.ts` still POST to the retired route. Gated by `AX_K8S_E2E=1`, not in CI, so this didn't block the retirement merge — but anyone walking those e2e tests against `kind-ax-next-dev` will hit immediate failures. Fix: rewrite `signInAsK8sAdmin` to call `auth:create-bootstrap-user` over the bus (or POST `/setup/admin` via the wizard) and exchange for the signed cookie, mirroring `@ax/test-harness/sign-in.ts`. Pick up next time someone walks the e2e suite.
- [ ] **Refresh `deploy/MANUAL-ACCEPTANCE.md` dev-bootstrap caveat.** The walk-through document references "the dev-bootstrap auth path mints a single shared user with `role='admin'`" — no longer accurate after the retirement. Update next time the doc gets walked.

## Credentials UX redesign (PR #109, merged 2026-05-19)

- [ ] **User-delete wiring in `@ax/auth-better`.** When a user-delete service hook lands, it should call `credentials:purge-by-owner({ scope: 'user', ownerId })` — the facade hook + the matching agent-delete wiring already exist; only the auth-better side is missing.
- [ ] **Bulk "all credentials" admin inventory view.** Design §3 non-goal; revisit when an operator needs a single audit surface.

## Memory-strata Phase 5+ (friction-driven; don't pre-schedule)

Listed here only so the triggers are easy to find. Per the roadmap, these stay dormant until their stated trigger fires.

- [ ] **Multi-tenant memory scoping** — when ax-next opens to multi-tenant beyond per-agent isolation.
- [ ] **Curator-as-patch pipeline** — when user-facing memory governance is requested OR bad-observation incidents surface.
- [ ] **Reranker (Level 6) re-spike** — only with new candidate model + production BM25 recall evidence.
- [ ] **Memory replay / time-travel queries** — when a user asks "what did the agent know on date X?"
- [ ] **Cross-agent memory sharing** — explicit user request only (likely requires the Curator pipeline first).
- [ ] **Bring-your-own embedding provider** — Phase 3 dropped vectors; reopen only if Level 7 is re-spiked and lands "IN".

## Web tools (@ax/web-tools, PR for `feat/web-tools-impl`)

- [ ] **Web-tools cost/usage metering + per-agent search-spend visibility.** YAGNI now (plan "Out of scope"). Add a usage-metering subscriber hook if operators need per-agent web-search spend (web search bills ~$10/1k). Trigger: an operator asks for the visibility.
