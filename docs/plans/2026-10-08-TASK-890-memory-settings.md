# TASK-890 — Memory settings and rail

Preserve the mounted conversation and shared correction ledger. The settings page already hosts Memory; consolidate its list/search/history into one responsive manager without changing server hooks. Keep learned facts next to the source transcript, outside all tab panels. The existing URL parser is the canonicalization boundary; old Memory links select settings Memory. No rail tab is persisted today (only collapse preferences).

1. Pin route migration and labelled Chats / Files / Activity tabs with tests; remove Memory rail content, add learned card below any active panel. Load-bearing: navigation and transcript source links.
2. Consolidate settings manager into search/history toolbar, local-date desktop table and mobile cards, preserving receipts, correction/Undo ledger and closure metadata. Load-bearing: cross-conversation management.
3. Verify cross-view correction/forget behavior and mounted conversation regressions; build, channel-web suite, root script/rule suites and lint. Commit decisions, independent review at a recorded full SHA, PR and green CI. No shared-cluster deployment.
