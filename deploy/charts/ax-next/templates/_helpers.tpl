{{/*
Expand the name of the chart.
*/}}
{{- define "ax-next.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We allow it to be overridden via `fullnameOverride`. Truncated to 63 chars
because some Kubernetes name fields are limited to that length.
*/}}
{{- define "ax-next.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version label value.
*/}}
{{- define "ax-next.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource in the chart.
*/}}
{{- define "ax-next.labels" -}}
helm.sh/chart: {{ include "ax-next.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ax-next
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{/*
Per-component labels — call with (dict "component" "host" "context" $)
*/}}
{{- define "ax-next.componentLabels" -}}
{{ include "ax-next.labels" .context }}
app.kubernetes.io/name: {{ printf "%s-%s" (include "ax-next.fullname" .context) .component | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Per-component selector labels — stable across upgrades.
Call with (dict "component" "host" "context" $).
*/}}
{{- define "ax-next.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-%s" (include "ax-next.fullname" .context) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Namespace — chart-installed resources land in Release.Namespace.
Runner pods land in .Values.namespace.runner (created out-of-band today).
*/}}
{{- define "ax-next.hostNamespace" -}}
{{- .Release.Namespace -}}
{{- end }}

{{- define "ax-next.runnerNamespace" -}}
{{- .Values.namespace.runner | default .Release.Namespace -}}
{{- end }}

{{/*
Container image string for the host/runner pod.
*/}}
{{- define "ax-next.image" -}}
{{- $repo := .Values.image.repository -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end }}

{{/*
Storage-tier image (Phase 1 of workspace redesign) — separate from
host/runner image because the storage tier ships with the git binary.
*/}}
{{- define "ax-next.gitServerImage" -}}
{{- $repo := .Values.gitServerImage.repository -}}
{{- $tag := .Values.gitServerImage.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end }}

{{/*
Host-component name. ax-next.fullname truncates to 63 chars; appending
"-host" can push the label past the DNS limit for long release names.
This helper produces the truncated, DNS-safe host name and is the source
of truth for every host-side resource (Service, Deployment, etc).
*/}}
{{- define "ax-next.hostComponentName" -}}
{{- printf "%s-host" (include "ax-next.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Cluster-internal URL the runner pods use to reach the host's IPC listener
(@ax/ipc-http). Computed from the host Service's name + namespace + port.
@ax/sandbox-k8s reads this via the preset's hostIpcUrl config and stamps
it onto every runner pod's AX_RUNNER_ENDPOINT env var so the runner knows
where to phone home.

NOTE the TRAILING DOT on `svc.cluster.local.` — it makes this an absolute
(fully-qualified) name so the resolver does NOT walk the pod's `search`
domains first. Without it, a 4-dot name under the default `ndots:5` is
treated as relative: every search-domain permutation is queried before the
real name, and on GKE Sandbox (gVisor) those search-miss lookups go over
gVisor's UDP netstack to kube-dns and can take ~1s each (~6s total). That
exceeds the runner's 5s `session.get-config` IPC timeout, so the runner
dies at boot with `session.get-config failed: timeout` — even though the
name itself resolves fine. The trailing dot collapses resolution to a
single fast query. (Harmless everywhere else; absolute names resolve
identically on Autopilot / kind.)
*/}}
{{- define "ax-next.hostIpcUrl" -}}
{{- $port := .Values.host.ipcServicePort | default 80 -}}
{{- printf "http://%s.%s.svc.cluster.local.:%d" (include "ax-next.hostComponentName" .) (include "ax-next.hostNamespace" .) (int $port) -}}
{{- end }}

{{/*
Credential-proxy Service component name (TASK-149). <release>-<chart>-proxy,
truncated to 63 chars. The ClusterIP Service that fronts the proxy's TCP
listener in production-gVisor mode. Selects the HOST pod (the proxy listens
inside the host container).
*/}}
{{- define "ax-next.credentialProxyComponentName" -}}
{{- $base := include "ax-next.fullname" . | trunc 57 | trimSuffix "-" -}}
{{- printf "%s-proxy" $base | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Cluster-internal `tcp://host:port` URL the credential-proxy advertises to
runner pods in TCP mode. Computed from the proxy Service name + namespace +
TCP port. The proxy plugin returns this from proxy:open-session so runner
pods (in another namespace) get a dialable address — the bind address
0.0.0.0:<port> isn't reachable cross-pod. Analogous to ax-next.hostIpcUrl.
Trailing dot on `svc.cluster.local.` for the same reason as ax-next.hostIpcUrl
(absolute name → no ndots search-domain walk; matters on gVisor).
*/}}
{{- define "ax-next.credentialProxyAdvertisedEndpoint" -}}
{{- $port := .Values.credentialProxy.tcp.port | default 8888 -}}
{{- printf "tcp://%s.%s.svc.cluster.local.:%d" (include "ax-next.credentialProxyComponentName" .) (include "ax-next.hostNamespace" .) (int $port) -}}
{{- end }}

{{/*
Same proxy Service URL with an `http://` scheme — what the sandbox plugin
stamps as K8S_PROXY_ENDPOINT (the orchestrator routes HTTPS_PROXY through it).
Trailing dot on `svc.cluster.local.` for the same reason as ax-next.hostIpcUrl
(absolute name → no ndots search-domain walk; matters on gVisor).
*/}}
{{- define "ax-next.credentialProxyServiceUrl" -}}
{{- $port := .Values.credentialProxy.tcp.port | default 8888 -}}
{{- printf "http://%s.%s.svc.cluster.local.:%d" (include "ax-next.credentialProxyComponentName" .) (include "ax-next.hostNamespace" .) (int $port) -}}
{{- end }}

{{/*
Fail-fast guard (TASK-149): the two proxy transports are mutually exclusive.
hostPath (sandbox.proxySocketHostPath) is the kind / single-node Unix-socket
posture; TCP (credentialProxy.tcp.enabled) is the production-gVisor Service
posture. Setting both is a config error — the runner can't key off an
ambiguous transport.
*/}}
{{- define "ax-next.validateProxyTransport" -}}
{{- if and .Values.sandbox.proxySocketHostPath .Values.credentialProxy.tcp.enabled -}}
{{- fail "credential-proxy: sandbox.proxySocketHostPath (hostPath) and credentialProxy.tcp.enabled (TCP Service) are mutually exclusive — pick exactly one proxy transport. hostPath is kind/single-node; TCP is the production-gVisor posture (GKE Sandbox bans hostPath)." -}}
{{- end -}}
{{- end -}}

{{/*
Fail-fast guard (TASK-157): dev-services in the runner sandbox require k8s 1.29+.

The dev-services feature (TASK-149..155) renders each declared service (a DB, a
broker) as a NATIVE k8s sidecar — an `initContainer` with `restartPolicy: Always`.
That restartPolicy-on-an-init-container shape is the SidecarContainers feature,
which only went GA (on by default) in Kubernetes 1.29.

On an older kubelet the `restartPolicy: Always` is SILENTLY IGNORED. The service
then runs as a plain, BLOCKING init container: the kubelet waits for it to finish
before starting the runner — but a database never finishes. The pod hangs in
`Init` until `activeDeadlineSeconds` (6h) reaps it, and the session never starts.
No error, no event, just a runner that never comes up. A genuine production
footgun, so we'd rather catch it at `helm install` than at 3am.

So: when an operator declares intent to run dev-services on this cluster
(`sandbox.devServices.enabled=true`), we check the cluster's reported version
and fail the render/install if it can't be confirmed 1.29+.

IMPORTANT — what `.Capabilities.KubeVersion` actually reflects:
  - `helm install` / `helm upgrade` (live cluster): the REAL apiserver version.
    This is where the guard does its job — it blocks a bad install.
  - `helm template` (no cluster): helm's BUILT-IN stub version, NOT your cluster.
    So a bare `helm template` with devServices.enabled can fail on a perfectly
    fine cluster (and vice versa). Pass `--kube-version <your-cluster-version>`
    to template the way the cluster will see it.

Escape hatch: `sandbox.devServices.skipKubeVersionCheck=true` bypasses the gate
for operators who've confirmed 1.29+ out of band (or who run a vendor distro
whose reported version doesn't sort cleanly under semver). Use it deliberately —
it turns a hard stop back into the silent-hang footgun above.

The `-0` suffix on the constraint makes pre-release versions (e.g. a `1.29.0-rc.1`
kubelet) satisfy `>=1.29.0`; without it semver excludes pre-releases.

Invoked from host/deployment.yaml, which always renders.
*/}}
{{- define "ax-next.validateDevServicesKubeVersion" -}}
{{- if .Values.sandbox.devServices.enabled -}}
{{- if not .Values.sandbox.devServices.skipKubeVersionCheck -}}
{{- if not (semverCompare ">=1.29.0-0" .Capabilities.KubeVersion.Version) -}}
{{- fail (printf "sandbox.devServices.enabled=true requires Kubernetes 1.29+ (SidecarContainers GA), but this cluster reports %s. On older kubelets the service sidecar's `restartPolicy: Always` is ignored, so the service runs as a BLOCKING init container and the runner pod hangs in Init until the 6h deadline reaps it — silently. Upgrade the cluster to 1.29+, or (if you've confirmed 1.29+ another way) set sandbox.devServices.skipKubeVersionCheck=true. NOTE: `helm template` reports helm's built-in stub version, not your cluster — pass --kube-version <your-cluster-version> to template as the cluster sees it." .Capabilities.KubeVersion.Version) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
git-server component name. <release>-<chart>-git-server, truncated to 63
chars (DNS label limit). Source of truth for the Deployment, Service,
ServiceAccount, and the PVC name prefix.
*/}}
{{- define "ax-next.gitServerComponentName" -}}
{{- printf "%s-git-server" (include "ax-next.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Cluster-internal URL the host plugin uses to reach the git-server.
http://<svc>.<ns>.svc.cluster.local:<port>. Mirrors hostIpcUrl's
fully-qualified shape so a future cluster-DNS suffix change moves both in
lockstep. The host deployment stamps this onto AX_WORKSPACE_GIT_HTTP_URL
when workspace.backend == "http".
*/}}
{{- define "ax-next.gitServerServiceUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "ax-next.gitServerComponentName" .) (include "ax-next.hostNamespace" .) (int .Values.gitServer.service.port) -}}
{{- end -}}

{{/*
Name of the Secret holding the git-server's bearer token.
<release>-<chart>-git-server-auth.
*/}}
{{- define "ax-next.gitServerAuthSecretName" -}}
{{- printf "%s-git-server-auth" (include "ax-next.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Experimental git-server (Phase 1 of workspace redesign) component name.
<release>-<chart>-git-server-experimental, truncated to 63 chars (DNS
label limit). DELIBERATELY distinct from ax-next.gitServerComponentName
so the new StatefulSet/Service/NetworkPolicy can sit alongside the legacy
Deployment/Service during the parallel-canary phase without colliding.

CRUCIALLY, the suffix is reserved BEFORE the 63-char truncation. The
naive "<fullname>-git-server-experimental | trunc 63" form would, on a
sufficiently long release name, drop the "-experimental" part and
collide with ax-next.gitServerComponentName — quietly aliasing the new
StatefulSet onto the legacy Deployment's labels. Instead we truncate
the base to 39 chars (63 - 24 for "-git-server-experimental") so the
suffix is always preserved.
*/}}
{{- define "ax-next.gitServerExperimentalComponentName" -}}
{{- $base := include "ax-next.fullname" . | trunc 39 | trimSuffix "-" -}}
{{- printf "%s-git-server-experimental" $base | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Cluster-internal URL the host plugin uses to reach the EXPERIMENTAL git-server
tier. Mirrors `ax-next.gitServerServiceUrl` for the legacy tier; routes traffic
to the regular ClusterIP Service in front of the new StatefulSet (NOT the
headless one — at N=1 they land on the same pod, but the ClusterIP form is
the simpler, future-proof shape for the host plugin's URL config).

The host deployment stamps this onto AX_WORKSPACE_GIT_SERVER_URL when
workspace.backend == "git-protocol".
*/}}
{{- define "ax-next.gitServerExperimentalServiceUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "ax-next.gitServerExperimentalComponentName" .) (include "ax-next.hostNamespace" .) (int .Values.gitServer.service.port) -}}
{{- end -}}

{{/*
Validate workspace.backend=git-protocol prerequisites. Fails fast at template
time if the operator picked the new backend without enabling the experimental
git-server tier — otherwise the host pod boots with AX_WORKSPACE_GIT_SERVER_URL
pointing at a Service that doesn't render, and we'd discover the misconfiguration
at first workspace op instead of at install. Belt-and-suspenders for the values
schema, since helm has no native enum-with-prereqs validator.

Invoked from `host/deployment.yaml`, which always renders.
*/}}
{{- define "ax-next.validateWorkspaceBackend" -}}
{{- if eq .Values.workspace.backend "git-protocol" -}}
{{- if not .Values.gitServer.enabled -}}
{{- fail "workspace.backend=git-protocol requires gitServer.enabled=true" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
ax-next.validateHostReplicas — fail-fast guard for the single-replica chat
constraint (ARCH-1).

The web chat surface is single-replica-only: @ax/channel-web streams SSE over
an IN-PROCESS per-reqId chunk ring buffer (packages/channel-web/src/server/
chunk-buffer.ts), and the chat:stream-chunk fan-in is replica-local. With
replicas > 1, an SSE reconnect can land on a replica that never buffered the
turn, and the live chunk subscriber on a different replica never fires — chat
silently breaks. The host PVC (workspace.backend=local) is also RWO and the
Deployment strategy is Recreate, so multi-replica isn't supported at the
storage tier either.

So we refuse to render a multi-replica host until a distributed stream broker
(and a multi-replica workspace backend) lands. Better to fail the `helm
template` than to ship a valid-looking Deployment that drops chat streams.

Invoked from host/deployment.yaml, which always renders.
*/}}
{{- define "ax-next.validateHostReplicas" -}}
{{- $replicas := .Values.replicas | default 1 | int -}}
{{- if gt $replicas 1 -}}
{{- fail (printf "replicas must be 1: the web chat surface is single-replica-only (in-process SSE chunk buffer); got %d. Multi-replica chat needs a distributed stream broker — pin replicas to 1 until that ships." $replicas) -}}
{{- end -}}
{{- end -}}

{{/*
Auth providers are DB-driven via @ax/auth-better (Phase 3 onboarding).
Provider rows live in the `auth_providers` table managed by
/admin/auth/providers/* CRUD; nothing in the chart's env stamping speaks
about google / dev-bootstrap / OIDC anymore. The first-run flow is:
operator sets onboarding.bootstrapToken (or scrapes one from stdout),
walks /setup/*, and adds providers from the admin UI.

The previous helpers — `ax-next.devBootstrapEnabled` and
`ax-next.googleAuthEnabled` — gated env stamping for the previous auth
plugin and are gone.
*/}}

{{/*
MinIO component name (out-of-git design Part A — dev/test blob backend).
<release>-<chart>-minio, truncated to 63 chars (DNS label limit). Source of
truth for the MinIO Deployment, Service, and Secret. Only rendered when
minio.enabled=true (the kind-dev path).
*/}}
{{- define "ax-next.minioComponentName" -}}
{{- printf "%s-minio" (include "ax-next.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
MinIO image (out-of-git design Part A). Separate pin from the host/runner +
git-server images — MinIO is its own upstream. Only used in the dev/test path.
*/}}
{{- define "ax-next.minioImage" -}}
{{- printf "%s:%s" .Values.minio.image.repository .Values.minio.image.tag -}}
{{- end -}}

{{/*
Cluster-internal S3 endpoint URL the host's @ax/blob-store-s3 plugin uses to
reach the in-cluster MinIO. http://<svc>.<ns>.svc.cluster.local:<port>.
Mirrors gitServerServiceUrl's fully-qualified shape so a future cluster-DNS
suffix change moves them in lockstep. Stamped onto AX_BLOB_S3_ENDPOINT when
the blob backend is s3 AND minio.enabled (the kind-dev path); prod GCS sets
blob.s3.endpoint explicitly instead.
*/}}
{{- define "ax-next.minioEndpointUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "ax-next.minioComponentName" .) (include "ax-next.hostNamespace" .) (int .Values.minio.service.port) -}}
{{- end -}}

{{/*
Name of the Secret holding the MinIO root (and host-side access) credentials.
<release>-<chart>-minio-auth. DEV / kind only — these are the MinIO root user
+ password, used by both the MinIO server and the host's blob-store-s3 client.
Never committed: the values default is empty and the chart generates a random
password (lookup-stable) when minio.enabled and the operator didn't supply one.
*/}}
{{- define "ax-next.minioAuthSecretName" -}}
{{- printf "%s-minio-auth" (include "ax-next.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Validate blob.backend wiring (out-of-git design Part A). Fails fast at template
time on two misconfigurations the operator can't recover from at runtime:
  - blob.backend=s3 with neither an explicit blob.s3.endpoint NOR minio.enabled
    → the host pod boots with no endpoint and no in-cluster MinIO to fall back
    to; the SDK would try AWS's real endpoint, which is never what a self-host /
    kind / GCS deploy wants.
  - blob.backend=s3 with an empty blob.s3.bucket AND minio.enabled=false → the
    preset's loader throws `AX_BLOB_S3_BUCKET is required` at boot.
Belt-and-suspenders for the values schema (helm has no native enum-with-prereqs
validator). Invoked from host/deployment.yaml, which always renders.
*/}}
{{- define "ax-next.validateBlobBackend" -}}
{{- if eq .Values.blob.backend "s3" -}}
{{- if and (not .Values.blob.s3.endpoint) (not .Values.minio.enabled) -}}
{{- fail "blob.backend=s3 requires either blob.s3.endpoint (e.g. https://storage.googleapis.com for GCS) or minio.enabled=true (in-cluster dev MinIO)" -}}
{{- end -}}
{{- if and (not .Values.blob.s3.bucket) (not .Values.minio.enabled) -}}
{{- fail "blob.backend=s3 requires blob.s3.bucket to be set" -}}
{{- end -}}
{{- end -}}
{{- end -}}
