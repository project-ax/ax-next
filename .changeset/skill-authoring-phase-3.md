---
'@ax/skill-broker': minor
'@ax/agents': minor
'@ax/chat-orchestrator': minor
'@ax/agent-claude-sdk-runner': minor
'@ax/cli': minor
'@ax/ipc-core': minor
---

Skill-authoring Phase 3 — bundle-native discovery projection + re-spawn.

Self-authored skills are now discovered bundle-natively: the read-only host
`user` projection (`$CLAUDE_CONFIG_DIR/skills/`, `0555`) is the **single**
discovery chokepoint, fed from cleared workspace `.ax/draft-skills/` bundles
(quarantined drafts omitted — the projection is the enforcement gate, the
Phase-2 commit scan is best-effort defense-in-depth). `@ax/agents` gains
`agents:resolve-authored-skills` (dir-form drafts only, strict-grammar ids,
empty caps in Phase 3); the orchestrator unions drafts in at highest precedence;
the runner drops `'project'` from the SDK `settingSources` and the
`.claude/skills` symlink so the agent can't author a discoverable skill outside
the host's control.

**Breaking:** the `install_authored_skill` tool and the
`agents:install-authored-skill` promotion/draft-retire transaction are deleted —
the workspace draft is the source of truth (no DB round-trip, no `git-rm`
retire). `search_catalog` / `request_capability` are unchanged.

A `workspace:applied` subscriber marks a session dirty when a turn changes
`.ax/draft-skills/`; the next turn re-spawns so the projection re-derives.

Capability *approval* for self-authored skills remains Phase 4 — pure-instruction
skills work end-to-end after this slice; capability skills are discoverable but
inert until Phase 4.
