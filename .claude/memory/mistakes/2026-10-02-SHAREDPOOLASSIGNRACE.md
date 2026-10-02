# Shared assignment and reconciliation race

- During final shared-pool GKE recovery checks, initial AI SDK activation failed
  after host/image restart and succeeded on retry. Investigation found a cleanup
  race; the live failures do not independently establish its exact cause.
- A deterministic regression pauses `protect` after the unpublished local intent
  is saved while Kubernetes discovery sees no annotation. Reconciliation used to
  snapshot `published: false` outside the per-Pod lock and retire the assignment
  after it completed. The regression failed before the fix.
- Load the ledger and decide whether to release inside the same per-Pod lock,
  then call the locked cleanup implementation directly. Assignment completion
  now survives reconciliation; crash recovery still retires unpublished intent.
- Sandbox tests: 16 files, 367 passed, one Linux-only skip; build passed. Final
  GKE retest and evidence are tracked separately in the consolidated acceptance
  guide. This note claims no additional live acceptance gate.
