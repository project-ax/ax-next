# Final shared-pool recovery acceptance

- The three previously open API/SSE gates passed on isolated GKE at source
  `f998d912`: first-request conversation recovery for both SDKs after host
  restart, actual different-image host/runner/helper rollout, and dedicated
  node loss with every local ledger JSON deliberately removed.
- Recovery fixes are `f18ed011` (host ownership and fenced lost-ledger cleanup),
  `dbd4c740` (serialize reconciliation decisions with assignment), and
  `f998d912` (move a new stream binding before old-session termination). Each
  defect gained a regression that failed before its fix.
- Host follow-ups completed in 8.9/6.9 seconds; image follow-ups in 9.9/6.9.
  Real matched Bash results and independent Filestore reads prove context and
  file continuity. Helper rollout retained live bindings without republishing
  consumed bootstrap credentials.
- Foreground node-loss timeout was 30.7 seconds under a fixture-only 30-second
  limit. A new Compute instance/Node retained the same GCE UUID but had a new
  native boot. Both old claims/Pods, ledgers, and mounts cleared automatically;
  a real later conversation/Bash turn and durable marker survived. Operator
  finalizer patches: zero. A background-command attempt was excluded and rerun.
- Scope is later-turn recovery with replacement process/proxy sessions. A
  permanently absent/differently named node or unconfirmed machine identity
  needs independent cloud fencing. The image pair differs by a real filesystem
  layer/digest with identical code/schema; incompatible migrations and browser
  UI were not accepted by this run. Raw Bash `/files` quotas remain separate.
- Final build and all three repository suites passed: 85 package suites / 15,557
  assertions, root ESLint rules 22, scripts 1,091. Sandbox 367 passed with one
  Linux-only macOS skip; orchestrator 280 passed; targeted lint and shard guard
  passed.
- Fixture `ax-spfinal-20261002` and its three namespaces/PVCs/PVs, synthetic
  Filestore root, node pool/VM/boot disks were removed after an empty ledger and
  absent child mounts. Private staging credentials, cookies, TLS keys, and raw
  snapshots were deleted after sanitized evidence was consolidated.
- Production remained revision 31, `agent:2c15e4b0`, one ready host, HTTP health
  200, and no shared pools/templates/claims/helpers/configuration. No production
  activation, push, or merge occurred. Source/evidence are on local branch
  `codex/gke-agent-sandbox` in the durable worktree.
- Resume from `deploy/SHARED-POOL-ACCEPTANCE.md` and
  `deploy/gke/shared-pool-final-gates-2026-10-02.json`. Exact immutable images and
  Cloud Build provenance are recorded there; disposable TLS/fixtures no longer
  exist.
