# Production shared pools enabled

- User explicitly authorized pulling merged PR #834 and deploying production.
  Pulled origin/main `c888232a` in the clean durable worktree on branch
  `codex/shared-pool-production`; preserved the primary checkout's dirty files.
- Cloud Build `682163da-ccdc-474b-a170-3bd3e9da2118` built the exact git archive
  with the canonical Dockerfile for linux/amd64. Production Helm revision 32
  pins `agent:shared-pools-c888232a` at digest
  `sha256:0570cd8f866ce62660cedfe73e08d5c3c8edaf17f2f9bb976bfa73d83e2a78ac`.
- Agent Sandbox/shared pools are enabled with one standby per SDK. Host and
  privileged helper `ax-sandbox-system/ax-next-storage` are ready. Both warm
  claims adopted existing Pod/container identities without restart in 956/880 ms;
  probe claims/Pods were removed, pools replenished, and helper ledger was empty.
  These probes assigned no storage or bootstrap and submitted no provider turns.
- Dedicated deployment CA and client/server TLS leaves are provisioned. CA key
  stays outside Kubernetes at the private user configuration directory
  `~/.config/ax-next/gke/canopy-ai-498321-ax-next-std/shared-pool-pki` (directory
  0700, files 0600). Cluster Secrets contain only CA cert and leaf cert/key.
  Leaves expire 2027-10-02; rotate leaves and restart host/helper before expiry.
  Authenticated TLS passed; absent client certificate failed at TLS handshake.
- Public health 200 with ok=true and existing application secret bytes unchanged.
  Record: `deploy/gke/shared-pool-production-rollout-2026-10-02.json`. Existing
  isolated acceptance retains its scope; permanently lost/differently named nodes
  require independent cloud fencing. Drain claims and verify empty ledgers before
  removing the helper/RBAC during rollback.
