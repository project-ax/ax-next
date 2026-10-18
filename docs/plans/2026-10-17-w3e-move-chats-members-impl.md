# W3e: moving chats, and your other agents — implementation plan

Spec: [`2026-10-12-w3-projects-design.md`](2026-10-12-w3-projects-design.md) §8 and §11 (W3e).
Decisions: `.claude/memory/decisions/2026-10-17-AXWM-3.md`.

## Decisions made while planning

- **Member changes go through `@ax/projects`**, not straight to
  `shared-folders:*` from channel-web. Projects owns the project → folder
  mapping (one source of truth), and the browser never sees a `folderId`.
  One hook: `projects:set-member { projectId, agentId, role: 'editor' | 'viewer' | null }`
  (`null` removes). It runs `loadManaged`, then `shared-folders:grant` /
  `revoke` on the row's folder with the person's ctx, so W2's rules (same
  owner only, can't touch the owner) and reaping apply unchanged.
- **Every session records the project it opened with**, including "none".
  Today `recordSessionSharedFolders` returns early with no folders, so a move
  from no project into one would go unnoticed.
- **Moving fires no event.** Nothing would subscribe: the orchestrator reads
  the chat's `projectId` on the reuse path (it already calls
  `conversations:get`), and the UI refetches after the call.
- **Removing a member leaves its chats in the project.** Their next turn ends
  `project-unavailable` (W3a's label), and "Remove from project" is always
  allowed. The confirm dialog says so in plain words.
- **The project composer picks from member agents only**, with no Auto. The
  default is the agent the person last chatted with in this project, else the
  owner.

## Shapes

```ts
// @ax/conversations
'conversations:set-project' { conversationId, userId, projectId: string | null } → { projectId: string | null }
//   owner-only (foreign = not-found); routine origin refused (forbidden, reason 'routine-conversation');
//   into a project: projects:resolve { projectId, agentId } as the person (same rule as create);
//   out: always allowed.

// @ax/projects
'projects:set-member' { projectId, agentId, role: 'editor' | 'viewer' | null } → { members: ProjectMember[] }

// channel-web
PUT    /api/chat/conversations/:id/project        { projectId: string | null }
PUT    /api/workspace/projects/:projectId/members/:agentId   { role: 'editor' | 'viewer' }
DELETE /api/workspace/projects/:projectId/members/:agentId
```

## Tasks

1. **`conversations:set-project`**: store `setProject`, the hook (modelled on
   `set-title`: load, owner check, routine refusal, `assertAgentReachable`,
   `assertProjectResolvable` with the hook name as a parameter), manifest,
   return schema, tests (`projects.test.ts`).
2. **Orchestrator**: record every session's spawn `projectId`; on the reuse
   path compare it with the chat's current one and retire with
   `project-changed`; the next spawn mounts the new project or none. Tests
   for no project → P, P → none, P → Q.
3. **`projects:set-member`**: `loadManaged`, grant / revoke, fire
   `system-prompt:augment-changed` for the agent; refusals map like the other
   hooks (`different-owner` → forbidden). Tests.
4. **channel-web server**: the move route and the member routes, client
   functions, manifest calls, tests (ACL, 404s, refusals).
5. **channel-web UI** (invoke `shadcn`):
   - the chat row's menu: "Move to project ›" (projects whose members include
     this chat's agent; not shown for routine chats, which don't reach the rail)
     and "Remove from project";
   - the Members card: "Add one of your agents" (agents the person manages,
     minus members; Can edit / Can view), change role, remove (confirm);
   - the composer chip "Chat with ‹agent› ▾" on the project page.
6. **Acceptance + kind walk**: move a chat in and out, and the next turn
   mounts the new folder or none; add and remove one of your own agents, with
   reaping; the UI on kind.
7. **Docs**: W3 spec "As built: W3e", Resume here, decisions shard.
