# Shared GKE pool acceptance and resume guide

Last reconciled: **2026-10-02**. This is the consolidated checklist and evidence
index for resuming shared-pool acceptance. **Shared pools are enabled in
production at revision 32.** Passing the Claude Stop regression on GKE cleared that defect;
it did not accept the shared-pool rollout.

The three previously open recovery/upgrade gates **passed on the final isolated
GKE run**, after fixes `f18ed011`, `dbd4c740`, and `f998d912`. Host restart and
image rollout passed the first follow-up request for both SDKs. Node recovery
passed with deliberately lost ledgers and a confirmed new boot under the same
GCE VM identity. See [final evidence](gke/shared-pool-final-gates-2026-10-02.json)
and the scope below. The subsequent production rollout is recorded below.

Implementation review: [PR #834](https://github.com/project-ax/ax-next/pull/834).
The PR merged as `c888232a`, and the user authorized production activation.
Creating the PR alone did not activate production shared pools.

## Production activation — 2026-10-02

Release `ax-next` is deployed at Helm revision **32**, with the Agent Sandbox
backend and shared pools enabled. Its immutable image is
`agent:shared-pools-c888232a@sha256:0570cd8f866ce62660cedfe73e08d5c3c8edaf17f2f9bb976bfa73d83e2a78ac`.
Cloud Build `682163da-ccdc-474b-a170-3bd3e9da2118` built the canonical Dockerfile
from an archive of merged `main`. The clean worktree pulled that commit; unrelated
edits in the primary checkout were preserved.

The host and dedicated storage helper are ready. Both SDK pools have **one ready
standby each**, independent of agent count. Operator claims adopted their existing
Pods in **956 and 880 ms** without changing container IDs or restarting them.
Probe claims and adopted Pods were removed; both pools replenished. These timings
measure controller adoption, not model response latency. No probe storage was
assigned and no new production provider turn was submitted. Full application and
storage-lifecycle acceptance remains the isolated GKE evidence above.

Public HTTPS `/health` returned `200 {"ok":true}`. The helper accepted a
server-verified authenticated TLS connection and rejected a connection without
a client certificate. Its ledger was empty after the probes. Existing application
Secret bytes matched the pre-upgrade snapshot.

The dedicated CA private key is retained outside the cluster in private user
configuration. Leaf certificates expire **2027-10-02**; rotate them and restart
the host/helper before expiry. The namespace/Secret names, exact image, and
sanitized checks are in the
[production rollout record](gke/shared-pool-production-rollout-2026-10-02.json).
The recovery/fencing limits below still apply. Rollback must drain claims and
verify empty ledgers before removing the helper or its permissions.

Use this document to track acceptance status. Deployment prerequisites,
security boundaries, and rollback instructions remain in
[SHARED-POOL.md](SHARED-POOL.md). The design is in
[the shared-pool architecture plan](../docs/plans/2026-10-01-agent-sandbox-shared-pool-design.md).
Keep the sanitized JSON records as historical evidence. Their status fields
reflect the time of each run; the reconciled status below supersedes those
fields where later evidence exists.

## Recorded pre-activation deployment and source state

These historical observations precede production activation. They are not a
fresh cluster check.

- Cluster context: `gke_canopy-ai-498321_us-central1-a_ax-next-std`;
  Kubernetes `1.36.4-gke.1247000`.
- Production release: `ax-next`, namespace `ax-next`, Helm revision **30**.
  Host ready, zero restarts, `/health` returned `200 {"ok":true}`.
- Backend: direct Agent Sandbox v1beta1 with gVisor. Shared-pool configuration,
  WarmPool/templates, and the storage helper were absent.
- Deployed image:
  `us-central1-docker.pkg.dev/canopy-ai-498321/ax-next/agent:claude-stop-21dab8fa@sha256:3677e2eebe71a2e2eacec0387b2d9a582ec6d6778bb15947b7c9b94be1155405`.
- Shared-pool implementation commit: `b9189606`; Claude Stop fix: `21dab8fa`;
  rollout evidence commit: `82d82548`; guarded claim-reaping fix: `0567279a`.
  Work is on local branch
  `codex/gke-agent-sandbox`, in worktree
  `/Users/vpulim/dev/ai/ax-next/.worktrees/gke-agent-sandbox`.
  The worktree was moved out of temporary storage on 2026-10-02.
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

The final resumed-run check observed production revision **31**, image
`us-central1-docker.pkg.dev/canopy-ai-498321/ax-next/agent:2c15e4b0`, a ready host,
zero restarts, and `200 {"ok":true}` from the public HTTP health endpoint.
Revision 31 was deployed at `2026-10-02T06:10:52-04:00`; acceptance operations
targeted only the isolated release. Shared pools, templates, claims, and helpers
remain absent in production. Revision 30 above records the earlier accepted
Claude Stop deployment. The resumed evidence contains the fresh snapshot.

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
- [x] Record storage assignment, activation, and first SDK reply separately.
  The resumed application run records the mTLS `/assign` round trip, host
  `creating_pod` → `pod_ready`, and submission → first text. See resumed evidence.

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
- [x] Recheck Claude Stop through the full shared-pool application release
  using the corrected image. The delayed marker stayed absent beyond the
  original command deadline; the same conversation completed a later Bash turn.
- [x] Verify existing workspace and committed upload quota accounting and
  refusal through the application. Identity writes and upload commits returned
  `413 storage-full`; a full owner received `chat:start:storage-full`.
- [x] Verify normal idle cleanup through the application. The default five-minute
  idle window and grace period terminated an idle runner and removed its claim,
  helper record, and mounts while keeping its durable marker.
- [x] Verify sessions requiring service sidecars use the cold path. An approved
  Redis connector produced a direct Sandbox with a native sidecar; a real
  application turn reached Redis at loopback, received `+PONG`, and wrote `/files`.

**Quota scope (user decision, 2026-10-02):** Verify the existing Git workspace
and uploaded/published blob limits. Track hard limits on arbitrary Bash writes
to raw `/files` separately; they are not a shared-pool acceptance prerequisite.
The 16 MiB staging limit does not cap attached NFS data. Temporary uploads have
their own pending-upload limit; disk accounting charges the committed blob.
The quota tests used a synthetic near-full ledger row, as the repository canary
does, and removed it afterward.

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
- [x] Capture deletion during active writes. At a trusted operator checkpoint
  before `sync -f`, every runner container was terminated, both mounts remained,
  and the Pod/claim finalizers and ledger were present. After successful detach
  they disappeared and the independent Filestore marker survived.

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
- [x] Restart the helper during activation; recover an unpublished partial bind.
- [x] Interrupt assignment after the first bind and before bootstrap publication.
  The turn failed in 12.4 seconds; subsequent convergence removed its claim,
  Pod, mounts, and unpublished bootstrap. Other bindings remained intact.
  Unit tests cover the other rollback stages; this live run interrupted one stage.
- [x] Force detach to fail and restart the helper. It stayed unready with the
  mount and ledger retained. Removing the injected fault restored readiness
  and cleared the claim, Pod, ledger, and mounts without losing the marker.
- [x] Restart the host with live claims. Both SDKs reopen the same durable
  conversations with fresh managed sessions, preserve prior context, and execute
  real Bash on the first follow-up request. Old claim/Pod UIDs, records, and
  mounts disappear automatically. Final evidence uses `f998d912`.
- [x] Drain a dedicated disposable gVisor node. Cleanup completed in 5.5 seconds;
  the independent Filestore marker survived.
- [x] Recover after dedicated-node loss with all local ledger JSON removed.
  The final foreground turn returned `chat-run-timeout` in 30.7 seconds. A new
  native boot with the same GCE UUID recovered secret-free Pod annotations and
  automatically retired both old bindings. Claims, Pods, records, and mounts
  disappeared without operator finalizer patches; the durable marker and later
  conversation/Bash turn survived. This supersedes the lost-ledger failure in
  the historical resumed run within the stated fencing scope.

Do not drain the existing gVisor node hosting production conversations.
The resumed run provisioned a separately tainted disposable gVisor node.
Its runner-only drain passed and preserved durable data. The 30-second chat
limit was a fixture override; the product default remains ten minutes.
Node-loss recovery and teardown are recorded in the resumed evidence.

### Gate 7 Upgrades and fixture teardown

- [x] Upgrade to different image bytes through the application release. Both
  SDKs preserve the same conversation/context and durable files on the first
  follow-up request after host rollout. Host and runner image IDs match the new
  digest; an added filesystem layer is observed. Old claims, Pods, records,
  mounts, pools, and templates disappear. The helper image rollout preserves
  live bindings without credential replay. Application code/schema are identical
  between these two final images; incompatible migrations were not tested.
  Conversation continuity uses replacement managed sessions, not unchanged Pod UIDs.
- [x] Previous fixtures were fully removed after claims drained and ledger
  entries and child mounts were verified absent.
- [x] Repeat complete teardown for this fixture, including namespaces,
  release/database, PVCs/PVs, synthetic Filestore directories, and node ledgers.
  The earlier resumed fixture needed manual lost-ledger finalizer cleanup after
  independent VM fencing; that historical result remains in its evidence. The
  final fixture drained claims, records, and mounts automatically, removed its
  synthetic Filestore root, release/database, three namespaces, three PVCs/PVs,
  and disposable node pool/VM. No operator finalizer patches were needed.

### Additional application coverage

- [x] Memory extraction with a valid OpenRouter credential. Observer logs
  recorded facts; an independent read of the isolated facts database found
  20 extracted facts across five synthetic agent keys. No credential values
  are included in the evidence.
- [ ] Browser UI acceptance if required for release. Existing application
  evidence exercised API/SSE, not a browser walk.
- [x] Complete repository-wide coverage: build, every recursive package suite,
  root ESLint-rule tests, and root script tests. Docker-outage failures were
  rerun; container-start queue failures then passed in serial retries. This
  is complete coverage across runs and retries, not a single green invocation.
  The final `f998d912` run also passed all three suites together: 85 package
  suites / 15,557 assertions, 22 root ESLint-rule tests, and 1,091 root script
  tests. Build and targeted lint passed. Sandbox: 367 passed with one Linux-only
  macOS skip; orchestrator: 280 passed.

PR #834 also merged `main` at `2c15e4b0` without conflicts and refreshed all three
repository suites: 85 package suites / 15,622 assertions, 22 root ESLint-rule
tests, and 1,100 script tests (three skipped). Full typecheck, lint, and capability
lint passed. The chart's 278 assertions passed with CI-pinned Helm 3.21.0 after
making schema-error wording portable and API-group assertions exact. CI-pinned
Gitleaks scanned the PR history with one exact historical test-log checksum
exception and no remaining findings. These checks supplement the isolated GKE
evidence; production activation still requires the reviewed rollout image.

## Evidence and observed results

| Record | Scope and result |
| --- | --- |
| [Shared pool GKE evidence](gke/shared-pool-acceptance-2026-10-01.json) | Isolated controller fixture plus isolated full application release; storage, sharing, both SDKs, usage, network fences, deletion/expiry, helper restart, and complete teardown. Also retains the original Claude Stop failure. |
| [Claude Stop Linux evidence](gke/claude-stop-linux-acceptance-2026-10-01.json) | Native SDK reproduction and corrected process termination behavior on Linux. |
| [Claude Stop GKE evidence](gke/claude-stop-gke-acceptance-2026-10-02.json) | Four native cases passed in a restricted gVisor Pod and a managed Agent Sandbox with synthetic Filestore; zero independently observed delayed completion markers. Direct backend deployed at revision 30; shared pools disabled. |
| [Resumed shared-pool acceptance](gke/shared-pool-resumed-acceptance-2026-10-02.json) | Full application timings, Stop, existing quotas, idle cleanup, sidecar cold path, memory extraction, interrupted activation, active-write ordering, forced detach, class replacement, dedicated-node drain/loss, new-image claim-reaping scope, test retries, and teardown. Host/node recovery remained open at that checkpoint; the final record supersedes those statuses. |
| [Final recovery and upgrade gates](gke/shared-pool-final-gates-2026-10-02.json) | Final `f998d912` image pair; first-request recovery for both SDKs after host/image rollout, helper image rollout, lost-ledger node recovery with a native boot fence, all three repository suites green, teardown, and production recheck. |

### Resumed acceptance and historical recovery gaps

The isolated release used separate PostgreSQL, workspace/facts PVCs, TLS leaves,
and synthetic Filestore paths. A dedicated tainted gVisor node kept fault tests
off production runners. Trusted fixture wrappers paused bind/flush and rejected
detach; they were removed with the fixture. Runner Pod Security matched the
production namespace's `baseline` policy.

Two real Claude turns used the shared runner class. Assignment round trips were
368 and 343 ms; activation was 934 and 1032 ms; first text arrived after 8.0 and
7.1 seconds. The first AI SDK activation failed and cleaned up; a later real
Bash turn produced a marker independently read from Filestore. An intermediate
model reply without a tool call was excluded from tool acceptance.

Host restart preserved transcript reads, but resuming a live session returned
proxy `407` in 476 ms because the host no longer knew its credential-proxy
registration. Storage detached; the claim survived. A surviving claim can let
the Sandbox controller recreate a standby after the helper removes the old
Pod. Keep the existing operational requirement to drain runners before host
restart. Transparent host/image rollout continuity remains unaccepted.

Commit `0567279a` fixes the sweeper's view of terminal claims and claims with a
confirmed absent assigned Sandbox. Claim aliases now carry claim metadata,
and deletion uses the observed claim UID while preserving storage finalizers.
Pending claims, running sessions, temporarily missing Pods under an existing
Sandbox, foreign prefixes, and API errors are left alone. Eight regression
cases cover these boundaries and same-name UID replacement.

Cloud Build produced an immutable image containing that commit:
`sharedpool-reap-20261002-cloud@sha256:1267ad38d758a1d4b624873b44b76210d3ac7a7e2ee3a89b99392709b7492b45`.
Only the isolated release was upgraded, after draining its healthy claims.
A new real Bash turn passed, and terminated-session cleanup converged within
a one-minute polling window with the durable file intact. That normal cleanup
check does not isolate the reaping fix. A separate operator-seeded claim whose
status pointed to an absent Sandbox was reaped by the exact production sweeper
with its terminal-age threshold set to zero. The stranded node-loss finalizer
remained untouched. Neither check accepts transparent host restart recovery.

Node replacement exposed a separate blocker: the new helper had an empty
host-local ledger and reported ready, while the old claim and Pod remained
finalized. The durable marker survived. Recovery needs a safe node-fencing and
lost-ledger strategy; an unreachable node or a Kubernetes terminal status alone
must not authorize detaching storage or dropping finalizers.

### Final recovery acceptance

The final isolated release was `ax-spfinal-20261002`, with a dedicated tainted
gVisor node, separate database/PVCs and TLS leaves, and synthetic Filestore.
The immutable image pair came from Cloud Build `be6b365b-6e49-4765-a513-a55c9060724f`
at source `f998d912`. Exact image digests, old/new UIDs, boot identities, matched
Bash results, timings, test-log hashes, and teardown are in
[the final record](gke/shared-pool-final-gates-2026-10-02.json).

Host restart retained prior conversation context and durable files for Claude
and AI SDK. Their first follow-up requests completed in 8.9 and 6.9 seconds.
The different-image follow-ups completed in 9.9 and 6.9 seconds. The old sessions
were retired; fresh process/proxy sessions served the same durable conversations.
An earlier reconciliation race and an SSE binding loss each gained a regression
that failed before the fix. Final acceptance requires the first follow-up request;
earlier retry successes remain historical evidence.

Node testing froze the trusted helper and removed every local ledger JSON while
a real foreground Bash command was active. Pod/claim protection and secret-free
recovery annotations remained. After managed same-name VM replacement, the helper
observed the same GCE UUID with a different native kernel boot. It reconstructed
retirement intent, cleared both old bindings without operator finalizer patches,
and preserved the independently read durable marker. The same conversation then
completed a real Bash turn. A background-command attempt was excluded from the
timeout check and repeated with verified foreground arguments.

**Recovery scope:** This accepts later-turn conversation recovery and the reproduced
same-identity GKE node-loss case. It does not promise uninterrupted in-flight commands.
A permanently absent or differently named node needs independent cloud fencing before
cleanup; Kubernetes node deletion or unreachability alone is insufficient. A helper's
readiness on another node does not establish that the old node is fenced. The 30-second
chat limit was a fixture override; production still defaults to ten minutes.

**Upgrade scope:** A new filesystem layer and distinct digests were exercised across
host, runners, and helper with identical application code/schema. Incompatible schema
migrations and browser UI behavior remain outside this run.

All final fixture resources were removed after automatic claim/ledger/mount drain.
Production was rechecked at revision 31, image `agent:2c15e4b0`, ready with HTTP
health 200 and no shared-pool configuration/resources. No acceptance operation
deployed these fixes or enabled shared pools in production.

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
The corrected-image shared application recheck subsequently passed; Gate 3 and
the resumed record contain that full application Stop evidence.

Do not infer command termination from an interrupted result or closed stream.
Wait beyond the command's original deadline and check storage independently.
Use `&&` between follow-up assertions so a later success cannot mask a failure.

## Local validation record

The repository build, sandbox lifecycle/storage tests, protocol tests, both
runner startup tests, the Claude SDK main suite, production assembly unit
tests, and chart render tests have run. The chart suite used its cached pinned
PostgreSQL tarball because the standard global setup's registry fetch was
blocked. Linux descriptor tests are explicitly skipped on macOS.

The resumed run completed the build and all three test suites. The recursive
no-bail run covered every package, but OrbStack stopped answering during it.
All 21 failing packages were rerun after Docker recovered. Eighteen passed in
that retry; `auth-better`, `connectors`, and `conversations` then passed serially
after container-start slot contention. The final sandbox suite passed 358 tests
with one Linux-only test skipped on macOS. Root ESLint-rule and script suites
passed. The immutable Linux image was built and pushed by Cloud Build when
the local Docker image build stalled.

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
5. The three required recovery/upgrade gates now have final scoped evidence.
   Repeat them when changing session/proxy recovery, storage cleanup/fencing,
   controllers, or rollout behavior. Use a fresh isolated fixture and provision
   a disposable node before fault tests. Verify foreground Bash arguments before
   injecting a fault. Evaluate a browser walk separately if required for release;
   API/SSE acceptance does not establish browser behavior.
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
`DOCKER_HOST`; see the repository instructions. This continuation reran both
application and cluster checks; the original consolidation was documentation-only.

## Claim-reaping security review

- Sandbox: Claim deletion uses observed UIDs and existing RBAC. Storage finalizers
  remain owned by the helper; the reaper never removes them. Pending capacity,
  another pool prefix, a running session, a temporarily absent Pod, and an API
  error do not authorize deletion. Node-loss finalizers remained intact in GKE.
- Injection: Decisions use trusted Kubernetes metadata and confirmed API `404`
  results. No model text, command output, or runner-provided path authorizes
  reaping. Bootstrap and credential values are excluded from evidence.
- Supply chain: No dependency manifest or lockfile change. The immutable image
  was built from committed source with the existing pinned base images.

## Claude Stop security review

- Sandbox: Signals target descendants of the SDK child created by this runner in
  its existing PID namespace. Kernel PID/start-time checks guard reuse. Startup
  MCP processes and the SDK remain alive. No host PID access or new privilege.
- Injection: Model commands still cross the existing host policy. Process IDs
  come from the child handle and kernel metadata, never command text or
  model-writable PID files. Stop denies a pending policy allow after interruption.
- Supply chain: N/A — no dependency manifests or lockfile entries changed.
