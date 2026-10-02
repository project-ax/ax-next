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

- Created review-ready PR #834:
  https://github.com/project-ax/ax-next/pull/834. It is mergeable. Initial CI
  exposed Helm diagnostic wording differences and two CodeQL substring-match
  findings in chart tests. Tests now accept both Helm diagnostics and compare
  Kubernetes API groups by exact equality; no runtime behavior changed.
- Gitleaks mistook the serial test-log checksum in historical evidence for an
  API key. Added one commit/file/rule/line fingerprint exception, without
  excluding any file or rule. CI-pinned Gitleaks 8.24.3 scanned the complete PR
  history locally with zero remaining findings.
- Post-main validation passed all three suites: 85 package suites / 15,622
  assertions, 22 root ESLint-rule tests, and 1,100 script tests (three skipped).
  Full typecheck/lint and capability lint passed. The final chart tests passed
  all 278 assertions under CI-pinned Helm 3.21.0; typecheck and changed-test lint
  were repeated after their assertion fixes. Initial CI failures are superseded
  only when the refreshed PR checks complete; local success is not CI success.
