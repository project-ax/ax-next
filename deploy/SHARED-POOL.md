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
See the [consolidated acceptance and resume guide](SHARED-POOL-ACCEPTANCE.md).

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

## Acceptance and resume guide

The checklist, completed evidence, remaining gates, validation results, and
resume procedure live in
[SHARED-POOL-ACCEPTANCE.md](SHARED-POOL-ACCEPTANCE.md).
Update that document as acceptance proceeds; keep the sanitized JSON records
as historical evidence.

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
