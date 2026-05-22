# TODO — deferred work

Living list of work explicitly punted, parked, or "wait until earned." Anything
without a concrete trigger is a candidate for deletion. When an item ships,
strike it through (or remove it) and reference the closing PR.

Sources scanned (2026-05-19): `MEMORY.md`, recent `docs/plans/*followup*`,
`docs/plans/2026-05-10-memory-strata-roadmap.md`,
`docs/plans/2026-05-08-first-use-onboarding-followup.md`, recent commits, and
`project_codex_findings_2026_04_29.md`.

---

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

## UI Bugs

- [x] ~~**Errors resume old session and a chat title bug**~~ — fixed (PR #125). BUG 2/3: `channel-web/runtime.tsx` only cleared `conversationRef` on null and never set it on sidebar-select, so selecting an old chat then sending POSTed `conversationId:null` → a new conversation (lost history). Now mirrors `activeSessionId` into the ref unconditionally. BUG 1: single-turn chats stayed "New Chat" because the runner jsonl syncs ~1s after `chat:turn-end`, so `conversations:get` is empty at the only title attempt — `@ax/conversation-titles` now falls back to the turn-end payload's assistant `contentBlocks`.

## Web tools (@ax/web-tools, PR for `feat/web-tools-impl`)

- [ ] **Fix the `memory-search` host-executor `call.input` bug.** `packages/memory-strata/src/tools/memory-search.ts` reads `input.query` (bare-input shape) instead of `call.input.query`. The host-execution contract passes the **full `ToolCall`** `{ id, name, input }` to the `tool:execute:<name>` hook (see `@ax/mcp-client` and the new `@ax/web-tools` executors), so `memory-search` reads `undefined` in production — masked only by a unit test that invokes the hook with the wrong shape. Out of scope for the web-tools PR; fix + correct the test together (Bug Fix Policy). Low-risk, ~5-line change.
- [ ] **Real-API MANUAL-ACCEPTANCE walk for web tools.** The new `deploy/MANUAL-ACCEPTANCE.md` "Web tools" scenario (search → extract → url-guard refusal) is unit/canary-covered only. Real end-to-end needs an org admin to enable Web Search in the Claude Console + `ANTHROPIC_API_KEY` on the host. Walk it next time the `kind-ax-next-dev` cluster is up with a key.
- [x] ~~**Two unrelated fixes parked on `feat/web-tools` (NOT in the web-tools PR).** `b3c87929` (`fix(auth-better): thread AX_PUBLIC_BASE_URL into better-auth baseURL`) and `494b9e7c` (`fix(channel-web): symmetric vertical spacing around tool-group pill`) rode on the `feat/web-tools` branch but are unrelated to web tools, so they were dropped from `feat/web-tools-impl` (rebased `--onto origin/main`) to keep the PR scoped. They are preserved on the untouched `feat/web-tools` branch — ship them via their own PR(s) or cherry-pick.~~ — done (2026-05-21): rebased onto `origin/main` (post-#121) and pushed to `main` as `44087f24` (auth baseURL) + `3d24f597` (channel-web spacing).
- [ ] **Web-tools cost/usage metering + per-agent search-spend visibility.** YAGNI now (plan "Out of scope"). Add a usage-metering subscriber hook if operators need per-agent web-search spend (web search bills ~$10/1k). Trigger: an operator asks for the visibility.

## Credentialed CLI tools & git Basic-auth (PR for `worktree-credentialed-cli-and-git-auth`)

Sub-projects **B** (git Basic-auth substitution in the credential-proxy MITM path) + **D** (skill-declared `capabilities.packages` → registry auto-allowlist + `uv`/`uvx`/`python3` in the agent image). Design: `docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md`. Shipped green + review-clean; deferred items:

- [ ] **MANUAL-ACCEPTANCE walk (B) — real `git clone` over Basic-auth on kind.** Install a skill declaring `allowedHosts: [gitlab.com]` + a `GITLAB_TOKEN` (`api-key`) credential slot, then have the agent run `git clone https://oauth2:$GITLAB_TOKEN@gitlab.com/<path>.git` and confirm the clone succeeds (the proxy decodes → substitutes → re-encodes the Basic header). Needs `kind-ax-next-dev` up + a real GitLab read token. Covered by unit + MITM integration tests; the cluster walk is the end-to-end proof.
- [ ] **MANUAL-ACCEPTANCE walk (D) — skill-declared CLI through the proxy on kind.** Install a skill declaring `capabilities.packages.npm: ['@linear/cli']` + `allowedHosts: [api.linear.app]` + a `LINEAR_API_KEY` slot, and confirm the agent can `npx @linear/cli ...` (registry auto-allowlisted to `registry.npmjs.org`, tool fetched on demand, Bearer key substituted by the proxy). The agent **image** changed in this PR (D), so rebuild it (`--no-cache` or verify the compiled image per [[docker-build-cache-runner-fixes]]) before walking.
- [ ] **Digest-pin the agent image's pinned-by-tag deps.** `uv`/`uvx` is pinned to `ghcr.io/astral-sh/uv:0.11.16` (version tag, not digest). Fold a digest-pin into the existing `tini`/`ca-certificates` digest-pin follow-up so all image deps are content-addressed. Low-risk; do them together.
- [ ] **Per-package registry allowlisting (vs whole-registry).** D auto-allowlists the *entire* `registry.npmjs.org` / PyPI when an ecosystem is declared (design §5.7 — bounded by the admin-skill trust boundary + session allowlist + canary, acceptable for MVP). A later tightening could restrict egress to the specific declared package paths. Trigger: a tighter supply-chain posture is requested.
- [ ] **Body-split placeholder substitution across TCP segments (pre-existing, out of scope).** B's `RequestFramer` fixes placeholder substitution for placeholders split across TCP segments in the request **head**; a placeholder split across segments inside a request **body** is still handled only by the per-chunk verbatim path (unchanged from before B). Bearer/api-key creds live in the head, so this rarely bites. Fix only if a real body-credential case appears.
- [ ] **Cross-session CLI tool caching / pre-warming (design §5.6, deferred).** MVP is per-session ephemeral `npx`/`uvx` fetch (re-fetch latency per session). Add a cache/pre-warm step if the latency becomes a problem. YAGNI now.
- [ ] **Go toolchain support (design §2/§5.6, deferred).** `packages.go` is rejected with `unsupported-package-ecosystem`. The grammar is shaped to add it (remove from the unsupported set + union a registry host). Trigger: a skill needs a Go CLI AND the ~300 MB+ image weight is acceptable.
