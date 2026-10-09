# TASK-888 implementation plan (resume)

1. Route grammar: distinct agent-settings kind, six canonical sections, default and unknown fallback; test all sections.
2. Settings shell: preserve mounted AgentView and current/past conversation state; desktop two-pane layout, compact list/drill-in; verify both entry points.
3. Instructions: move existing rules editor with save/read/error behavior intact; make MemorySurface facts-only. Model/Skills/Routines use truthful Empty states; existing Connectors/Facts sections remain reachable.
4. Gate: install/build, channel-web tests, lint, app build; desktop/mobile browser validation and detector; commit decisions and implementation.
5. Independent whole-branch review from committed-clean head; address findings, obtain approved SHA; open PR and drive required checks green. Never merge or edit routing fields.

All five tasks are required for acceptance. No hooks, backend boundaries, dependencies, or read-only chat reach summary are added.
