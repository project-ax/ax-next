# conversations:get 0-turns investigation

**Date:** 2026-05-19
**Predecessor:** Phase 3 smoke (PRs #97, #98) — every conversation on the
`ax-next-dev` kind cluster returns `{ turns: [] }` from
`GET /api/chat/conversations/:id`, even immediately after a successful
assistant turn that visibly rendered in the live frame.

## Observed state

- 5 conversations exist with non-null `runner_session_id`, all sharing the
  same `(userId=usr_67441…, agentId=agt_In_4…)` pair → all map to bare
  repo `ws-c9079f06d909894c.git`.
- That repo contains exactly **one** transcript file:
  `.claude/projects/-permanent/16f8d41e-d5f0-408b-b04f-8789fa130d90.jsonl`
  (sessionId of the OLDEST conversation, last written 2026-05-18 13:47).
- The 4 newer sessionIds (May 19) never appear in any commit's tree;
  `git log --all -- "**/{sid}.jsonl"` returns no commits for them.
- Per-turn bundles ARE still landing post-restart — the commits contain
  `.cache/claude-cli-nodejs/`, `.npm/_logs/`, `summary.md`,
  `.ax/uploads/…` (attachments), but NOT `.claude/projects/<sid>.jsonl`
  or `.claude/sessions/<n>.json`. So the bundle path works; only the SDK-
  native transcript files are missing.
- The host pod restarted at 2026-05-18 22:45 EDT (= 2026-05-19 02:45 UTC).
  Every turn AFTER that restart fails to bundle the jsonl; every turn
  BEFORE bundled it normally. The restart picked up a new image rolled
  out in PR #95 / #96 (Phase 0 / Phase 1 skill-install).
- Read-path glob in `packages/conversations/src/plugin.ts:741`:
  `` `.claude/projects/**/${runnerSessionId}.jsonl` `` — would correctly
  match `.claude/projects/-permanent/<sid>.jsonl` IF the file existed in
  the workspace. It doesn't, for May 19 sessions.

## Diagnosis

**Bucket:** 1 (runner never writes).

Root cause is concrete: PR #95 (Phase 0 skill-install) added
`CLAUDE_CONFIG_DIR=/home/runner/.ax/session` to the runner pod's env
(`packages/sandbox-k8s/src/pod-spec.ts:185`). The Anthropic SDK uses
`$CLAUDE_CONFIG_DIR` (when set) as the root for **both** its skill-
discovery `'user'` source AND its native transcript writes. So after
Phase 0:

  - SDK skill discovery: `$CLAUDE_CONFIG_DIR/skills/…` — works as
    intended (host-installed-skills surface).
  - SDK transcript: `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl`
    = `/home/runner/.ax/session/projects/-permanent/<sid>.jsonl` —
    **outside the workspace root** `/permanent`, so the post-turn
    `git add -A` in `/permanent` never sees it.

Before Phase 0, the runner's only redirect was `HOME=/permanent`
(workspaceRoot, set in `agent-claude-sdk-runner/src/main.ts:497`), and
the SDK fell back to `$HOME/.claude/projects/...` — which WAS inside
`/permanent`, hence got bundled. The comment block at
`main.ts:418-427` warned that the HOME redirect needs to win over
`CLAUDE_CONFIG_DIR` — but CLAUDE_CONFIG_DIR governs jsonl-write
location independently of HOME, so the warning protected the wrong
invariant.

Buckets 2 (path-glob drift) and 3 (workspace-resolution drift) were
ruled out by direct inspection of the bare repo — both the glob and the
`(userId, agentId)` derivation would resolve correctly IF the file were
there.

## Resolution

Filed as a separate plan:
`docs/plans/2026-05-19-runner-jsonl-write-phase-e-followup.md`.

Investigation ends here. Per the Task 5 spec, Task 6 (Phase 3 canary)
will proceed by seeding `.claude/projects/<sid>.jsonl` directly via
`workspace:apply`, which sidesteps the runner-side gap until the
follow-up lands.
