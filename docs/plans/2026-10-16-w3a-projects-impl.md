# W3a: projects you can chat in — implementation plan

Spec: [W3 §4](2026-10-12-w3-projects-design.md#4-w3a-projects-you-can-chat-in), plus
the W3a columns of §10 and §11. Stacks on `feat/w2-shared-folders` (PR #989);
W2 + W3a land as **one squash** (§4.9). Decisions: `.claude/memory/decisions/2026-10-12-AXWM-3.md`.

Line numbers in the spec have drifted; the explorer maps (2026-10-16) give
current ones: orchestrator augment at `orchestrator.ts:3094`, open at `:4007`,
`sharedFolderIdsFor` at `:238-257` / `:2361` / `:3958`.

## Decisions taken without asking (all logged in the shard)

1. **Refusals are "audited" the W2 way:** a `projects_refused` warn line with
   `{hook, reason, actor, projectId?, agentId?}`, one uniform `forbidden` /
   `not-found` message. There is no audit table to write to (`@ax/audit-log`
   only takes egress).
2. **Most recently used managed agent (Q5):** channel-web computes it, reusing
   the `POST /api/workspace/route` recency logic (max `lastActivityAt ??
   createdAt` per agent over the user's conversations), filtered by
   `agents:can-manage-sharing`. Agents with no chats sort by `createdAt` desc.
   Served as `GET /api/workspace/projects/owner-candidates`.
3. **`project-unavailable` copy is static:** "This chat's project isn't
   available to this agent anymore." `ERROR_LABELS` entries are static; the
   agent's name is already in the chat header.
4. **Delete ordering:** whichever path removes the project row (`projects:delete`
   or the `shared-folders:deleted` subscriber) fires `projects:deleted`, using
   `DELETE … RETURNING`, so it fires exactly once per row.
5. **W2's deferred sweep re-fire (W2 §12):** the sweep fires
   `shared-folders:deleted` for every due tombstone before each cleanup attempt.
   Delivery is at-least-once; the projects subscriber is idempotent.
6. **"Updated 2h ago"** is the project row's `updated_at` in W3a.
7. **The orchestrator reads `conversations:get-metadata` undeclared,
   `hasService`-guarded**, like its other `conversations:*` peers;
   `projects:resolve` goes in `optionalCalls`. A chat with a `projectId` and no
   `projects:resolve` service fails closed (`project-unavailable`).

## Tasks

Each task: test first, `tsc` clean, its package suite green. Order matters where
a later task calls a hook an earlier one adds.

| # | Task | Packages | Load-bearing? |
|---|---|---|---|
| 1 | `shared-folders:get`, `shared-folders:deleted` (delete, agent-delete with no editor, sweep re-fire), SECURITY.md | shared-folders | yes: projects needs both |
| 2 | `AgentContext.projectId` (host-set only) | core | yes: providers read it |
| 3 | `@ax/projects`: table, `create/list/get/update/delete/resolve`, `projects:deleted`, `shared-folders:deleted` handler, prompt block provider, refusal logging | new package | yes |
| 4 | Conversations: `project_id`, create/list/metadata, `projects:deleted` purge + `conversations:purged` | conversations | yes |
| 5 | Orchestrator: drop `sharedFolderIdsFor`; project lookup at spawn; `project-unavailable`; derived ctx for providers; `sharedFolderIds` at open; record `projectId`; UI label | chat-orchestrator, channel-web (label only) | yes |
| 6 | Presets: k8s loads `@ax/projects`; preset/prod-bootstrap/drop lists; cycle assertion; §4.9 six-step acceptance with an IPC runner fixture that does file I/O | presets/k8s | yes |
| 7 | channel-web server: project routes, `projectId` on chat create, project labels in agent detail, owner candidates; memory canary route tests | channel-web, presets/memory | yes |
| 8 | channel-web UI: router, sidebar section, grid, New project dialog, project page, chat breadcrumb, rail label, settings + AlertDialog | channel-web | yes |
| 9 | Docs: W2 §12 → done, W3 spec as-built, umbrella W2 row, memory | docs | yes (contract rule 5) |

Security-checklist runs on tasks 3, 4, 5 and 7 (new hooks, a host-set context
field, untrusted text in the prompt, new HTTP routes).
