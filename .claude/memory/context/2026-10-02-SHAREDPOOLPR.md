# Shared-pool PR preparation

- The user requested a PR before production activation. Required isolated GKE
  gates are accepted within the documented later-turn and same-GCE-identity
  fencing scope; permanently lost nodes still need independent cloud fencing.
- Merged origin/main `2c15e4b0` into `codex/gke-agent-sandbox` without conflicts,
  preserving the exact source commits referenced by the GKE evidence. Frozen
  lockfile install, full typecheck, and full lint passed after that merge.
- Added release notes for shared pools, runner bootstrap, conversation recovery,
  and Claude Stop. No production deployment or feature activation is part of
  this PR preparation. Disposable acceptance fixtures remain removed.
