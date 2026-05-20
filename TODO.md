# TODO — deferred work

Living list of work explicitly punted, parked, or "wait until earned." Anything
without a concrete trigger is a candidate for deletion. When an item ships,
strike it through (or remove it) and reference the closing PR.

Sources scanned (2026-05-19): `MEMORY.md`, recent `docs/plans/*followup*`,
`docs/plans/2026-05-10-memory-strata-roadmap.md`,
`docs/plans/2026-05-08-first-use-onboarding-followup.md`, recent commits, and
`project_codex_findings_2026_04_29.md`.

---

## Manual verification

- [x] ~~**PR #105 (defaults routines-half) — MANUAL-ACCEPTANCE walk on `ax-next-dev`.**~~ Walked 2026-05-19. Create / materialize / refresh / delete-cascade all ✅; fire initially ❌ (surfaced bug → fixed in PR #108) and re-walked ✅ on the rebuilt image.

## Open bugs

- [x] ~~**PR #105: default-sourced routine fires error with `forbidden: agent X not accessible to user '@ax/routines/defaults'`.**~~ Fixed in PR #108. Added `agents:list-personal-owners` service hook; routines tick now stamps each materialized default-routine row with the agent owner's user id, so `agents:resolve`'s ACL gate sees a real user. Backfill migration drops the broken rows so the next tick re-materializes them. Real-bus integration test in `canary-defaults.test.ts` exercises `agents:resolve` via a stubbed handler (no `fire`-spy). Walk-verified on `ax-next-dev` 2026-05-19. **Team agents are deliberately excluded from default-materialize pending the policy decision below.**
- [x] **Credential-proxy shutdown race emits unhandled ECONNRESET.** Surfaced in PR #104 walk. Suspect bypass-MITM `net.connect()` at `packages/credential-proxy/src/listener.ts:680` — `'error'` listener attached at line 727, leaving a sync-error window. WIP test in git status: `packages/credential-proxy/src/__tests__/listener-shutdown-race.test.ts`. Fix shape: attach the `'error'` listener at the same tick `net.connect()` returns. Also audit the MITM `tls.connect()` path at line 470 (line 483 listener) for the same shape. **File a GitHub issue.**
- [x] ~~**Possible jsonl-parser duplication.**~~ Fixed in this branch — root cause was not the parser. Channel-web's `POST /api/chat/messages` was building the `AgentMessage` with the typed text in BOTH `content` (via `extractText`) AND the wire's `contentBlocks` (verbatim, including the `{type:'text', …}` block the client always sends). The runner's user-message handoff then prepended `content` as a text block alongside the translated `contentBlocks`, so the SDK saw two identical text blocks and wrote both to its jsonl — the parser faithfully returned the duplication. Fix strips text-type blocks from `AgentMessage.contentBlocks` at the route boundary, restoring the runner's documented invariant (`content` carries text, `contentBlocks` carries non-text). Regression covered by `routes-chat.test.ts` tests #4 (text-only → `contentBlocks` omitted) and the attachment_ref test (text + attachment → only the attachment block in `contentBlocks`).

## Routines

- [ ] **Default routines for team agents (fire-under-team policy).** Spun out of the PR #105 fix: `agents:list-personal-owners` excludes team agents because routing a default fire under "the team" needs a policy answer — does the routine fire under each member separately, under the team creator, under a designated steward? Pick up when team agents become a real surface; for now, team-owned agents simply don't get default routines materialized.
- [ ] **Cron + webhook triggers for default routines.** Deferred per I-R5 / HP7. Cron needs a croner evaluator in claim SQL; webhook needs per-default tokens + live rebind on admin edit. Pick up when a real caller needs it.
- [ ] **Phase F — conversation titles.** Branch parked. New piece of work, not a follow-up.
- [ ] **Per-team / per-tenant scoped default routines.** Not currently load-bearing.
- [ ] **Per-agent opt-out for default routines** beyond the current override-by-name mechanic.
- [ ] **"Drift indicator" UI** (visibility into stale `definition_updated_at`).
- [ ] **Default → workspace "promote" flow.**

## Skills (Phase 1 follow-ups from PR #96)

- [ ] **System-prompt fold for skill descriptions.** SDK-only today (SDK indexes description into prompt + invokes `Skill` tool on demand).
- [ ] **MCP-skill bundling.** Reserved `capabilities.mcpServers` currently rejects with `capability-deferred`.
- [ ] **Skill versioning / upgrade flow.** `version` field stored, only consumed at parse-time today.
- [ ] **User-installable skills** (`/settings/skills*` + scope on `skills:list/get`). Admin-only today.
- [ ] **Workspace → installed "promote" flow.** Agent writes `.ax/skills/x/SKILL.md` sans capabilities → admin button promotes with chosen grants.
- [ ] **Automated e2e canary for skill-install** (real Postgres testcontainer + mocked GitHub server). Today the proof is the manual scenario in MANUAL-ACCEPTANCE.md.

## Attachments / artifacts

- [ ] **Artifact-publish round-trip e2e via real runner.** Chip components are unit-tested; the canary in `presets/k8s/__tests__/acceptance.test.ts` seeds jsonl directly via `workspace:apply`. A runner-stub for `tool_use` / `tool_result` would be a separate slice.
- [ ] **`$CLAUDE_CONFIG_DIR/sessions/` mirroring.** Today's scaffold only links `projects/`. Add a sibling symlink if a future feature needs session metadata in the workspace.

## Auth / onboarding cleanup (Phase 4 + Phase 5 follow-ups)

These wait on stated triggers — don't ship pre-emptively.

- [x] ~~**Delete `@ax/credentials-anthropic-oauth`**~~ Shipped in PR #110 (2026-05-20) — package deleted, CLI dep + tsconfig refs removed, k8s preset comment rewritten. No off-default preset depended on the Anthropic-OAuth kind once `ax credentials login` was removed.
- [x] ~~**Delete `@ax/credentials-oauth-pending`**~~ Shipped in PR #110 — `@ax/credentials-admin-routes` had no remaining callers of `credentials:oauth:stash-pending` / `:claim-pending` after PR #109 removed the `/oauth/*` routes.
- [x] ~~**Retire `/admin/credentials/oauth/start` + `/finish`** routes + `oauth-flow.test.ts` in `@ax/credentials-admin-routes`.~~ Already done in PR #109; comment/test cross-references cleaned up in PR #110.
- [x] ~~**Audit + delete `oauthStart` / `oauthFinish`**~~ Shipped in PR #110 — only the test file referenced them; no production UI caller remained after `OAuthFlowForm` was deleted in PR #109.
- [x] ~~**Delete `ax credentials login`** subcommand~~ Shipped in PR #110 — `runLoginCommand` + `startRedirectListener` + OAuth constants + the `open-browser.ts` helper removed, `@ax/credentials-anthropic-oauth` dep dropped.
- [ ] **`ax admin reset-password` CLI + `/auth/reset-password` route.** Pick up when local password sign-in becomes a real surface (wizard re-adds password OR Settings → Password lands). Today the wizard captures only name+email against `@ax/auth-oidc`.
- [ ] **Delete `/auth/dev-bootstrap` route + `dev-bootstrap.ts`** in `@ax/auth-oidc`. Pick up when `@ax/auth-oidc` itself retires (touches `packages/auth-oidc/src/types.ts` that `@ax/auth-better` type-imports).

## Credentials UX redesign (PR #109, merged 2026-05-19)

- [ ] **ModelConfigTab broken at runtime.** `packages/channel-web/src/components/admin/ModelConfigTab.tsx:88` POSTs to the deleted `/admin/credentials` endpoint via `adminCredentials.create({ kind: 'setting', ref: 'setting.fast-model', ... })`. Read path (provider list, picker UI) still works; save will 404 after this redesign lands. Pre-existing misuse of the credentials store as a KV settings store. Fix shape: dedicated `/admin/settings/<key>` endpoint OR migrate model-picker storage to a different primitive.
- [ ] **User-delete wiring in `@ax/auth-better`.** When a user-delete service hook lands, it should call `credentials:purge-by-owner({ scope: 'user', ownerId })` — the facade hook + the matching agent-delete wiring already exist; only the auth-better side is missing.
- [ ] **Routine markdown linter for `secretRef` mismatch.** Routine YAML frontmatter still names a `secretRef` string by hand; for the destination-first design to make sense, it should equal `refForDestination({ kind: 'routine-hmac', agentId, routinePath })`. Add a `@ax/validator-routine` check that vetoes upserts on mismatch.
- [ ] **Provider pre-save validation against the provider API.** The deleted `/admin/credentials/providers/:id/validate` route used to validate the key against Anthropic before saving. The new `ProvidersPanel` drops this — UX regression. Reintroduce as a pre-save hook on the destination-routes path if reviewers push back.
- [ ] **Bulk "all credentials" admin inventory view.** Design §3 non-goal; revisit when an operator needs a single audit surface.
- [ ] **Drift guard for the 3× `refForDestination` duplication.** `@ax/credentials/src/refs.ts` is canonical; `packages/channel-web/src/lib/credentials.ts` and `packages/credentials-admin-routes/src/destination-routes.ts` carry local duplicates (eslint `no-restricted-imports` blocks cross-plugin runtime imports). A test that snapshots all three copies against the canonical output for every kind would catch silent divergence when adding a 6th destination kind.

## Phase 6 PR-A follow-ups (open since 2026-04-29)

- [ ] **Phase 6 PR-B (a.k.a. 6.6).** Rewrite `claude-sdk-runner.e2e.test.ts` and `presets/k8s/__tests__/{acceptance,multi-tenant-acceptance}.test.ts` against a stub Anthropic backend. Parked tests still skipped.
- [ ] **Phase 7 — kernel-type audit.** `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` in `@ax/core` + `@ax/ipc-protocol`. Switch `@ax/audit-log` subscription from `chat:end` → `event.http-egress`. Narrow `AgentMessage` 3 roles → 2.
- [ ] **Merge `@ax/tool-dispatcher` → `@ax/mcp-client`** to own the host-tool catalog. Earlier reality-check failed (mcp-client + test-harness + sdk-runner all consume `tool:register` / `tool:list`).
- [ ] **Merge `@ax/agent-runner-core` → `@ax/agent-claude-sdk-runner`** (IpcClient, DiffAccumulator, SessionInvalidError, toWireChanges). Phase 5's deferred decision still holds.

## Architectural debt (Codex 2026-04-29)

These are ordered: 4 gates 2 and 3.

- [ ] **Finding 4 — plugin manifest canonical form.** Spec says core reads `package.json` `ax` field; reality is runtime manifests in code. Zero packages currently declare `"ax"` in `package.json`. **Decide first** (runtime stays canonical → update spec + `ax-conventions` skill; or `package.json` wins → migrate ~25 packages).
- [ ] **Finding 2 — hook bus enforces service-boundary guarantees.** `HookBus.call` currently just awaits and casts — no return-shape Zod, no per-hook timeouts. Declarations naturally live wherever finding 4 says manifests live.
- [ ] **Finding 3 — workspace policy hooks bypassable.** `workspace:pre-apply` veto and `workspace:applied` notification fire in the IPC commit path (`workspace-commit-notify.ts:58`) but not around `workspace:apply` itself. Any in-process `bus.call('workspace:apply')` silently bypasses. Codex's facade pattern (rename → private/internal hook; new public hook wraps with pre/post fire) is the agreed shape. Land on top of finding 2.

## Investigations / unresolved design

- [ ] **Workspace 04-24 → 04-25 pivot rationale.** Current `FileChange[]`-over-JSON architecture was chosen-by-cascade (the (b)-rejection in `2026-04-25-workspace-git-http-handoff.md:44-45`), not chosen-on-merits. The (b)-rejection's premises may not still hold (see `2026-04-30-workspace-redesign-brainstorming-context.md`). Surface premises before extending the surface.
- [ ] **Extend `make dev-fast` to cover host-TS.** SPA-only today by design — `pnpm deploy --legacy` leaves recursive workspace symlinks that defeat both `docker cp` and `tar -h`. Worth solving if host-side iteration speed becomes painful. Candidate approach: build the deploy tree inside docker matching the Dockerfile builder stage exactly, then extract.

## Memory-strata Phase 5+ (friction-driven; don't pre-schedule)

Listed here only so the triggers are easy to find. Per the roadmap, these stay dormant until their stated trigger fires.

- [ ] **Multi-tenant memory scoping** — when ax-next opens to multi-tenant beyond per-agent isolation.
- [ ] **Curator-as-patch pipeline** — when user-facing memory governance is requested OR bad-observation incidents surface.
- [ ] **Reranker (Level 6) re-spike** — only with new candidate model + production BM25 recall evidence.
- [ ] **Memory replay / time-travel queries** — when a user asks "what did the agent know on date X?"
- [ ] **Cross-agent memory sharing** — explicit user request only (likely requires the Curator pipeline first).
- [ ] **Bring-your-own embedding provider** — Phase 3 dropped vectors; reopen only if Level 7 is re-spiked and lands "IN".
