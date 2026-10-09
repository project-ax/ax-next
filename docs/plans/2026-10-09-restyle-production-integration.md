# Integrate the authored workspace redesign into production

Production serves the latest main commit, while the requested Figma redesign remains local on design/workspace-restyle. Integrate its existing commit into main; retain the agent settings routes, mounted hidden conversations, complete connector settings and OAuth returns, shared Memory corrections, and labelled rail tabs from TASK-888–890.

1. Cherry-pick DESIGN-8 into an isolated branch from main. Preserve the source worktree and existing behavior.
2. Verify build, SPA, lint and all test suites. Run browser visual smoke in desktop light/dark, intermediate and mobile sizes; run connector/Memory geometry regressions. Fix any integration defects and preserve red-to-green evidence.
3. Obtain independent whole-branch review, address findings, and open a CI-green PR. The parent orchestrator owns merge and production rollout.

All three steps are necessary for this deployment. No new product design, dependencies, hooks or backend changes are planned.
