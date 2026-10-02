# Shared GKE runner pool prototype

The host creates one shared pool for each supported runner configuration. With
`replicas: 1`, Claude SDK and AI SDK use two standby Pods in total. A hundred
registered agents still use those two standbys. Active conversations each keep
their assigned Pod; the controller replaces claimed standbys. Used Pods are
destroyed after cleanup.

This implementation is opt-in. The image and integrated helper passed isolated
GKE/Filestore lifecycle checks, and both SDKs completed real provider/Bash turns
through an isolated application release. The Claude Stop fix passed on GKE and
was deployed for direct Agent Sandbox sessions. **Shared-pool rollout remains
blocked until the remaining acceptance gates pass.**
See the [recorded evidence](gke/shared-pool-acceptance-2026-10-01.json).

The late-attachment volume must be a **memory-backed 16 MiB emptyDir** with the
force-shared annotation. A disk-backed emptyDir is unsafe: our deletion test
reproduced kubelet recursively deleting agent files through the child bind
mount. Tmpfs teardown unmounts its root first and waits for child mounts to
detach. The helper checks both the Pod declaration and the held directory's
actual filesystem before attaching data. Finalizers alone do not prevent the
disk-backed failure. This follows the two teardown paths in
[kubelet's emptyDir implementation](https://github.com/kubernetes/kubernetes/blob/v1.36.0/pkg/volume/emptydir/empty_dir.go).

## Deployment requirements

- GKE **Standard** with Agent Sandbox v1beta1 extensions, a gVisor node pool,
  and GKE 1.36.0-gke.3302001 or newer. The privileged storage DaemonSet needs
  hostPath and bidirectional mount propagation; this recipe targets Standard.
- An image built from this change. The helper entrypoint, standby gate, `/files`
  and `/memory` aliases, `flock`, and mount tools must all be present. Do not
  enable the overlay against the currently deployed image.
- Existing Filestore at `/files`; optional read-only memory exports. The helper
  uses the same server/export configuration as the existing mount resolvers.
- A dedicated administrator namespace for the helper. The chart creates it.
  Host and runner namespaces remain separate and keep their current policies.
- Two TLS Secrets from a **dedicated deployment CA**: clientAuth certificate
  in the host namespace, serverAuth certificate in the helper namespace. Each
  Secret contains `ca.crt`, `tls.crt`, and `tls.key`; neither contains the CA
  private key. The server certificate's SAN must match `sharedPool.serverName`.
  Keep the CA private key outside the cluster. The CA must issue no unrelated
  client certificates. Host and helper also compare a digest of their configured
  export endpoints before attaching storage; stale helper configuration fails
  closed. Rotate leaf certificates and restart both host and
  helper Pods; the helper deliberately uses the DaemonSet `OnDelete` strategy.

Use an isolated release and three fresh namespaces first. Give its helper a
unique prefix and ledger directory. Provision synthetic Filestore storage for
that release; do not point acceptance at production agent directories. Create
the helper namespace and TLS Secrets before installing, with the namespace's
Helm ownership annotations for that isolated release so Helm can adopt it.
Apply the normal GKE and Agent Sandbox overlays, then
[gke-shared-pool-values.yaml](charts/ax-next/gke-shared-pool-values.yaml), with
the isolated names, storage, Secrets, and new image overrides.

The host needs namespaced CRUD for pools, templates, and claims, plus helper-Pod
discovery in the administrator namespace. It still has no Pod patch, exec,
attach, port-forward, Secret-read, or cluster-scoped permissions. The helper
alone can patch Pod/claim finalizers and delete runner Pods. It has no API exec
or Secret-read permission. Helm renders these roles when the feature is enabled.

Wait for the helper DaemonSet to be ready and every configured pool to have its
standby Pods before measuring first-message latency. Startup creates pools;
initial image pulls and controller reconciliation still take time.

## Acceptance gate

Record claim assignment, activation, and first SDK reply as separate timings.
Compare the assigned Pod UID with the standby UID recorded before sending a
message. An unchanged UID and zero container restarts establish warm adoption.

1. Start concurrent conversations for two synthetic agents using the same
   runner. Both must use the same pool, adopt existing standbys when available,
   and cause only the configured shared capacity to be replenished. Exercise
   both Claude SDK and AI SDK and a real SDK Bash tool.
2. Write markers through `/files`, verify them independently on Filestore, and
   read them in a second session for the same agent. Verify same-agent
   concurrent sessions see writes and a sibling agent cannot see those markers
   or escape through a symlink. `/memory` must be readable and reject writes.
3. Verify transcript commits, usage attribution, disk quota enforcement,
   cancellation, idle cleanup, and sessions with service sidecars. Sidecars use
   the existing cold path. Also test cold NFS mounts against the image aliases.
4. Attempt helper access from a runner, unauthenticated TLS access, and direct
   NFS access from a shared runner. All must fail. The existing IPC and proxy
   paths must remain usable. Never include session.json or tokens in evidence.
5. Delete a claim externally while writes are active. Verify runner termination
   precedes flush/detach, data survives, finalizers clear, and no mount remains
   in the node namespace. **A finalizer alone does not prove kubelet preserves
   the volume.** This ordering is a required GKE acceptance check.
6. Restart the helper during activation and during a forced detach failure.
   Verify its node-private ledger recovers partial assignments, never republishes
   consumed credentials, and preserves cleanup state until detach succeeds.
   Restart the host, expire a claim, and drain a node. Node loss must retain data
   and produce a bounded failure rather than silently reporting successful cleanup.
7. Upgrade image/capacity: new shared classes should start, obsolete standbys
   should disappear, and existing claim-owned conversations should continue.
   Confirm all fixture namespaces, Pods, mounts, and synthetic storage are gone
   after cleanup. Do not remove a helper while its ledger still has live entries.

Rollback by disabling `sandbox.sharedPool.enabled` for new sessions. Drain all
existing shared claims and verify their ledgers are empty **before** removing
the helper or its RBAC. Removing a helper with live finalizers can strand cleanup.

## Security review

- Sandbox: A trusted privileged helper can access kubelet Pod storage on its
  node, its private ledger, and configured complete Filestore exports. That
  kubelet storage may contain other Pods' mounted secrets; helper compromise
  therefore has node-wide consequences. The activation API exposes only fixed
  operations on verified claim/Sandbox/Pod UIDs. It pins directory descriptors,
  rejects symlinks, uses fixed argv without a shell, and never grants these host
  paths or complete exports to runners. Controller-only mutual TLS, scoped
  NetworkPolicies, a process lock, and a durable secret-free ledger protect
  assignment and cleanup. Shared runners retain gVisor, UID 1000, dropped
  capabilities, read-only rootfs, no Kubernetes token, and no helper/NFS network
  access. Filesystem durability and node teardown remain acceptance gates.
- Injection: Assignment JSON and Kubernetes responses are external input.
  Strict bounded schemas, ownership rechecks, UID preconditions, and an env
  allowlist keep them out of arbitrary shell commands, paths, loaders, and Git
  execution settings. Untrusted tenant directories never choose mount options.
  Bootstrap files are private, instance-bound, expiring, and consumed before
  model work. API errors and ledgers contain no credentials. A malicious string
  such as `"; rm -rf ~; echo "` is rejected as an identity or treated as data;
  it never becomes a helper shell command.
- Supply chain: Added only the existing internal `@ax/sandbox-protocol`
  workspace dependencies/references to runner-core and memory; it has no install scripts and
  introduces no third-party npm packages or transitive lockfile changes. The
  image adds Debian `mount` and `util-linux`, pinned to 2.38.1-5+deb12u3 from the
  established signed Debian archive ([package source](https://packages.debian.org/bookworm/util-linux)).
  Debian package maintainer scripts run only at image build time; the helper
  installs nothing at runtime. The base image remains digest-pinned. The new
  image built successfully and its packaged helper ran on GKE.

## Local validation

The repository build, sandbox lifecycle/storage tests, protocol tests, both
runner startup tests, the Claude SDK main suite, production assembly unit
tests, and chart render tests have run. The chart suite used its cached pinned
PostgreSQL tarball because the standard global setup's registry fetch was
blocked. Linux descriptor tests are explicitly skipped on macOS.

Earlier broad local runs failed Docker/listener checks under session
restrictions. A full repository test gate has not passed. Later continuation
could use the configured Docker builder and standalone kubectl commands, so
image build and isolated cluster checks proceeded.

## Integrated GKE checks on 2026-10-01

The corrected prototype image is `sharedpool-20261001-prototype3`, digest
`sha256:9cd431a45699f3ab783071a8a3cfaa32a9a81b5df34cd41d58e0f234b4fb129f`.
Earlier prototype images contain the unsafe disk-backed staging design and
must not be deployed.

Both real runner binaries booted through the unchanged workspace and inbox
protocols against a synthetic controller. Three claims adopted existing Pod
and container identities, with zero restarts, in 1068, 1089, and 728 ms. Two
agents used the same Claude pool. These are activation timings, not first
model reply timings; no provider request was sent.

Real Filestore checks covered private agent directories, concurrent writes,
read-only memory with deliberately writable source permissions, consumed
bootstrap, and cold gVisor NFS compatibility with the image aliases. Helper
restart retained three live bindings without republishing credentials.
External claim deletion, direct Pod deletion, and claim expiry preserved
markers and cleared storage records and child mounts. Runner networking
allowed IPC and blocked helper, NFS, and rpcbind access; the helper rejected
TLS requests without a client certificate.

A separate isolated Helm release booted the complete application with its own
PostgreSQL database, workspace/facts PVCs, dedicated TLS leaves, and synthetic
Filestore root. Onboarding validated a real Anthropic key. Both SDKs executed
Bash writes/reads and committed their transcripts; two agents used the same
Claude pool. Application activation took 1028–1114 ms. First text arrived in
6.3–7.1 seconds for the three new conversations. These are small acceptance
samples, not a latency benchmark. Usage recorded the four initial turns under
the test user. The key stayed on the trusted host/client side.

**Stop failed the filesystem check for Claude.** The API returned
`interrupted: true`, the stream ended, and the tool result reported exit 137.
Nevertheless, `printf STARTED > /files/stop-started.txt; sleep 30; printf
COMPLETED > /files/stop-result.txt` wrote its completion marker after the full
sleep. AI SDK's completion marker stayed absent. A cold-path early-Stop check
also executed Bash after Stop was pressed; that timing differs from the warm
in-flight case, so it does not establish the exact cause. Do not infer process
termination from an interrupted result or a closed stream. Wait beyond the
command's original duration and check storage independently. Use `&&` in any
follow-up assertions so a later successful command cannot mask a failed check.

The follow-up fix reproduces the orphaned command with SDK 0.2.119 in a local
Linux container. The runner now tracks its SDK child, freezes and kills tool
descendants before sending the SDK interrupt, and preserves startup MCP
servers. Stop stays latched through startup and an outstanding policy decision.
The native tests check a delayed write past its original deadline, reuse of the
same query, MCP tool reuse, and partial streamed text. The same four checks pass
in a restricted gVisor Pod and in a managed Agent Sandbox with a synthetic
Filestore directory. An independent Filestore scan after the command deadline
found no completion marker. Production release revision 30 runs the accepted
image for direct Agent Sandbox sessions; shared pools remain disabled. See the
[Linux evidence](gke/claude-stop-linux-acceptance-2026-10-01.json) and
[GKE evidence](gke/claude-stop-gke-acceptance-2026-10-02.json).

Transcript reads survived an isolated host restart, but automatic recovery and
reaping of live claims was not accepted. Quota refusal, sidecar application
routes, interrupted assignment, forced detach failure, and node drain/loss
remain pending. Memory extraction lacked an OpenRouter credential in this
fixture and was not accepted. Existing disk accounting measures workspaces and
uploaded/published blobs; it does not count arbitrary writes in raw `/files`.
The 16 MiB staging limit likewise does not limit attached NFS data.

Use a dedicated test node for drain/loss checks so acceptance does not
interrupt live conversations on the cluster's shared gVisor node. Provisioning
that node was blocked by Google Cloud OAuth/API DNS access in this session.
All test namespaces, database/PVCs, synthetic storage, and helper ledger were
removed after draining claims and verifying no child mounts or live records.

## Claude Stop security review

- Sandbox: Signals target descendants of the SDK child created by this runner in
  its existing PID namespace. Kernel PID/start-time checks guard reuse. Startup
  MCP processes and the SDK remain alive. No host PID access or new privilege.
- Injection: Model commands still cross the existing host policy. Process IDs
  come from the child handle and kernel metadata, never command text or
  model-writable PID files. Stop denies a pending policy allow after interruption.
- Supply chain: N/A — no dependency manifests or lockfile entries changed.
