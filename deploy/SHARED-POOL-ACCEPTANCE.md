# Shared GKE pool acceptance and resume guide

Last reconciled: **2026-10-02**. This is the consolidated checklist and evidence
index for resuming shared-pool acceptance. **Shared pools remain disabled in
production.** Passing the Claude Stop regression on GKE cleared that defect;
it did not accept the shared-pool rollout.

Use this document to track acceptance status. Deployment prerequisites,
security boundaries, and rollback instructions remain in
[SHARED-POOL.md](SHARED-POOL.md). The design is in
[the shared-pool architecture plan](../docs/plans/2026-10-01-agent-sandbox-shared-pool-design.md).
Keep the sanitized JSON records as historical evidence. Their status fields
reflect the time of each run; the reconciled status below supersedes those
fields where later evidence exists.

## Recorded deployment and source state

These are observations from the last accepted run, not a fresh cluster check.

- Cluster context: `gke_canopy-ai-498321_us-central1-a_ax-next-std`;
  Kubernetes `1.36.4-gke.1247000`.
- Production release: `ax-next`, namespace `ax-next`, Helm revision **30**.
  Host ready, zero restarts, `/health` returned `200 {"ok":true}`.
- Backend: direct Agent Sandbox v1beta1 with gVisor. Shared-pool configuration,
  WarmPool/templates, and the storage helper were absent.
- Deployed image:
  `us-central1-docker.pkg.dev/canopy-ai-498321/ax-next/agent:claude-stop-21dab8fa@sha256:3677e2eebe71a2e2eacec0387b2d9a582ec6d6778bb15947b7c9b94be1155405`.
- Shared-pool implementation commit: `b9189606`; Claude Stop fix: `21dab8fa`;
  rollout evidence commit: `82d82548`. Work is on local branch
  `codex/gke-agent-sandbox`, in worktree
  `/private/tmp/ax-next-agent-sandbox-rollout-20261001` at this checkpoint.
  These commits were not pushed or merged as part of the recorded acceptance.
- All acceptance fixtures were removed. No isolated release, synthetic storage,
  or helper ledger should be assumed to still exist.

## Production preflight retry

On 2026-10-02, after the session was granted full filesystem and network access,
Git index refresh, Kubernetes queries, Helm status, and the host health check
succeeded. Production remained on revision 30 with the accepted Claude Stop
image digest, a ready host, zero restarts, and `200 {"ok":true}` from `/health`.
No shared-pool environment settings, warm pools, templates, claims, or shared
storage helper DaemonSets were observed. The guide was already committed as
`8806fb12`; no duplicate commit was needed. See the
[preflight record](gke/shared-pool-preflight-2026-10-02.json).
This retry changed no production configuration and accepted no additional gate.

## Acceptance checklist

Checked items have recorded evidence within the stated scope. Unchecked items
need evidence before accepting the corresponding gate. The seven gate numbers
preserve the original runbook's coverage.

### Gate 1 Shared adoption and runner behavior

- [x] Two synthetic agents share one Claude pool; standby capacity belongs to
  the runner class rather than each agent.
- [x] Existing Pod UID and container ID remain unchanged with zero restarts
  when adopted; claimed standbys are replenished.
- [x] Claude SDK and AI SDK execute real provider turns and Bash tools through
  an isolated full application release.
- [ ] Record claim assignment, activation, and first SDK reply as separate
  timings in the resumed run. Existing samples record activation and first
  text, but do not separately quantify the assignment stage.

### Gate 2 Storage durability and isolation

- [x] Markers written through `/files` are verified independently on Filestore
  and read by later sessions for the same agent.
- [x] Concurrent sessions for the same agent see writes; sibling agents cannot
  read those files or escape through symlinks.
- [x] `/memory` is readable and rejects writes even when source permissions
  would permit them.

### Gate 3 Application lifecycle

- [x] Transcript commits and usage attribution pass for both SDKs.
- [x] Cold gVisor NFS mounts work with the image's `/files` and `/memory` aliases.
- [x] AI SDK Stop leaves the delayed completion marker absent in the shared
  application fixture.
- [x] Claude Stop fix passes native Linux and GKE regressions, including a
  managed Agent Sandbox with synthetic Filestore. See the scope below.
- [ ] Recheck Claude Stop through the full shared-pool application release
  using the corrected image. The later native GKE acceptance did not repeat
  that application fixture.
- [ ] Verify quota refusal and disk quota enforcement through the application.
- [ ] Verify normal idle cleanup through the application. Claim expiry passed
  separately; that does not establish the full idle lifecycle.
- [ ] Verify sessions requiring service sidecars use the cold path and their
  application routes remain reachable.

**Quota gap:** Existing disk accounting covers Git workspaces and
uploaded/published blobs, but does not count arbitrary writes directly into
raw `/files`. The 16 MiB staging limit does not cap attached NFS data. Define
and enforce the intended storage quota behavior before recording this as a pass.

### Gate 4 Network and credential boundaries

- [x] Runner access to the helper, NFS, and rpcbind is denied.
- [x] Helper TLS requests without a client certificate are rejected.
- [x] Existing IPC and credential proxy paths remain usable.
- [x] Bootstrap credentials are consumed; runners have no Kubernetes token.

Never put session bootstrap files, tokens, private keys, or provider keys into
acceptance evidence.

### Gate 5 Deletion ordering and cleanup

- [x] External claim deletion, direct Pod deletion, and claim expiry preserve
  durable markers and clear helper records and child mounts.
- [ ] Explicitly capture deletion while writes are active, with runner
  termination before flush/detach and finalizer removal. The existing summary
  records the durable outcome, but does not independently establish every
  ordering step required by this gate.

**Required storage invariant:** Late attachment uses a memory-backed 16 MiB
`emptyDir` with the force-shared annotation. The helper verifies both the Pod
medium declaration and the held directory's actual tmpfs filesystem before
attaching storage. Disk-backed staging reproduced kubelet deleting durable
Filestore files through the bind mount despite finalizers. Prototype images
1 and 2 are unsafe and must not be deployed.

### Gate 6 Recovery and infrastructure failure

- [x] Helper restart recovers three live bindings without republishing consumed
  credentials.
- [x] Transcript reads survive an isolated host restart.
- [x] Claim expiry preserves markers and clears records and mounts.
- [ ] Restart the helper during activation; recover partial assignments.
- [ ] Interrupt assignment at intermediate stages and prove bounded failure
  with no leaked mount, claim, or credential.
- [ ] Force detach to fail, restart the helper, and retain cleanup state until
  detach succeeds. Never report successful cleanup while a mount remains.
- [ ] Restart the host with live claims; verify automatic recovery or bounded
  failure, reaping, and mount/ledger cleanup.
- [ ] Drain a dedicated disposable gVisor node and test node loss. Retain durable
  data and report bounded failure rather than silently successful cleanup.

Do not drain the existing gVisor node hosting production conversations.
Dedicated-node provisioning was previously blocked by Google Cloud OAuth/API
DNS access; recheck access before resuming that test.

### Gate 7 Upgrades and fixture teardown

- [ ] Upgrade the image and change pool capacity. New runner classes start,
  obsolete standbys disappear, and existing claimed conversations continue.
- [x] Previous fixtures were fully removed after claims drained and ledger
  entries and child mounts were verified absent.
- [ ] Repeat complete teardown for the next fixture, including namespaces,
  release/database, PVCs/PVs, synthetic Filestore directories, and node ledgers.

### Additional application coverage

- [ ] Memory extraction with a valid OpenRouter credential. The earlier fixture
  lacked that credential. This remains unaccepted; decide explicitly whether
  it is part of shared-pool rollout acceptance or a separate application check.
- [ ] Browser UI acceptance if required for release. Existing application
  evidence exercised API/SSE, not a browser walk.
- [ ] Complete the repository-wide test gate. Targeted validation passed, but
  no full green repository gate is recorded.

## Evidence and observed results

| Record | Scope and result |
| --- | --- |
| [Shared pool GKE evidence](gke/shared-pool-acceptance-2026-10-01.json) | Isolated controller fixture plus isolated full application release; storage, sharing, both SDKs, usage, network fences, deletion/expiry, helper restart, and complete teardown. Also retains the original Claude Stop failure. |
| [Claude Stop Linux evidence](gke/claude-stop-linux-acceptance-2026-10-01.json) | Native SDK reproduction and corrected process termination behavior on Linux. |
| [Claude Stop GKE evidence](gke/claude-stop-gke-acceptance-2026-10-02.json) | Four native cases passed in a restricted gVisor Pod and a managed Agent Sandbox with synthetic Filestore; zero independently observed delayed completion markers. Direct backend deployed at revision 30; shared pools disabled. |

### Shared pool observations

The corrected prototype image was
`sharedpool-20261001-prototype3`, digest
`sha256:9cd431a45699f3ab783071a8a3cfaa32a9a81b5df34cd41d58e0f234b4fb129f`.
Both real runner binaries booted through the unchanged workspace/inbox
protocols against a synthetic controller. Three claims adopted existing Pods
and containers with zero restarts in **1068, 1089, and 728 ms**. Two agents used
the same Claude pool. These measured activation, without provider requests.

A separate isolated Helm release used its own PostgreSQL database,
workspace/facts PVCs, dedicated TLS leaves, and synthetic Filestore root.
Both SDKs executed real Bash writes/reads through the credential proxy and
committed transcripts. Two agents shared the Claude pool. Application
activation took **1028–1114 ms**; first text for three new conversations arrived
in **6.3–7.1 seconds**. Usage attributed four initial turns to one test user.
Provider credentials stayed on the trusted host/client side. These are small
acceptance samples, not a latency benchmark.

Helper restart retained three live bindings without credential replay.
External claim deletion, direct Pod deletion, and expiry preserved markers
and cleared storage records and child mounts. Independent storage reads,
source-permission checks, sibling/symlink checks, and network probes established
the other recorded passes. All fixture namespaces, database/PVCs, synthetic
storage, and node ledger directories were removed after draining claims.

### Claude Stop failure and subsequent acceptance

The first full shared application run failed Claude's filesystem check even
though the API returned `interrupted: true`, SSE ended, and the tool result
reported exit 137. This command still wrote its completion marker after 30 seconds:

```sh
printf STARTED > /files/stop-started.txt; sleep 30; printf COMPLETED > /files/stop-result.txt
```

The AI SDK marker remained absent. A cold-path early Stop also allowed Bash to
execute after Stop; the attempted cold in-flight baseline did not establish
whether its cause was identical.

Commit `21dab8fa` fixed the Linux tool-descendant termination and latched Stop
through startup and an outstanding policy decision. Four native cases then
passed in both a restricted gVisor Pod and a managed Agent Sandbox with
synthetic Filestore, using a scripted loopback provider and no provider account.
They cover delayed writes past the command deadline, reuse of the same query,
startup Stop, continued startup MCP use, and durable partial streamed text.
An independent Filestore scan found **zero delayed completion markers**.
That accepted the defect fix on GKE; production direct sessions run the image.
The full shared application fixture still needs its corrected-image recheck.

Do not infer command termination from an interrupted result or closed stream.
Wait beyond the command's original deadline and check storage independently.
Use `&&` between follow-up assertions so a later success cannot mask a failure.

## Local validation record

The repository build, sandbox lifecycle/storage tests, protocol tests, both
runner startup tests, the Claude SDK main suite, production assembly unit
tests, and chart render tests have run. The chart suite used its cached pinned
PostgreSQL tarball because the standard global setup's registry fetch was
blocked. Linux descriptor tests are explicitly skipped on macOS.

Earlier broad local runs failed Docker/listener checks under session
restrictions. A full repository test gate has not passed. Later continuation
could use the configured Docker builder and standalone kubectl commands, so
image build and isolated cluster checks proceeded.

## Resume procedure

1. Start from branch `codex/gke-agent-sandbox` and verify the worktree and commits
   above. The primary checkout contained unrelated user changes at this checkpoint;
   preserve them. Do not depend on untracked temporary fixtures from the prior run.
2. Recheck GKE authentication, current context, deployed image, Helm revision,
   and feature state. The recorded revision is a checkpoint, not a promise that
   production still matches it. Read Helm values without printing secrets.
3. Build or select an immutable image containing both the corrected shared-pool
   staging implementation and the Claude Stop fix. Use a new isolated release,
   three fresh namespaces, dedicated TLS leaves, synthetic Filestore storage,
   and a unique helper prefix and ledger directory. Follow
   [the deployment requirements](SHARED-POOL.md#deployment-requirements) and
   [the shared-pool overlay](charts/ax-next/gke-shared-pool-values.yaml).
4. Wait for the helper and configured standbys to be ready. Recheck baseline
   sharing, isolation, durable writes, and full-application Stop on that image.
   Record standby UID/container identity, assignment, activation, and first
   reply separately.
5. Work through the unchecked gates: quotas and sidecars; idle/host recovery;
   interrupted activation and detach; dedicated-node drain/loss; image/capacity
   upgrade. Supply the missing memory-extraction credential if that check stays
   in rollout scope. Provision a disposable node before destructive node tests.
6. Record each result here with date, image digest, fixture scope, assertion,
   outcome, and a relative link to sanitized raw evidence. Leave failures and
   historical evidence intact; explain later results that supersede them.
7. Drain claims, verify empty ledgers and absent child mounts, then remove the
   helper and all fixture resources. Repeat the cleanup checklist for every run.
   Keep production shared pools disabled until the required gates are accepted.

For the repository gate, follow the root instructions and avoid bail-induced
partial coverage. Run all three suites even if the recursive suite fails:

```sh
pnpm build
pnpm -r --no-bail run test
pnpm test:eslint-rules
pnpm test:scripts
```

Record each command's result. Docker-backed tests require an explicit intended
`DOCKER_HOST`; see the repository instructions. No new application or cluster
tests were run for this documentation consolidation.

## Claude Stop security review

- Sandbox: Signals target descendants of the SDK child created by this runner in
  its existing PID namespace. Kernel PID/start-time checks guard reuse. Startup
  MCP processes and the SDK remain alive. No host PID access or new privilege.
- Injection: Model commands still cross the existing host policy. Process IDs
  come from the child handle and kernel metadata, never command text or
  model-writable PID files. Stop denies a pending policy allow after interruption.
- Supply chain: N/A — no dependency manifests or lockfile entries changed.
