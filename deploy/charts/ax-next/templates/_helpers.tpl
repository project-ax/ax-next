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
*/}}
{{- define "ax-next.hostIpcUrl" -}}
{{- $port := .Values.host.ipcServicePort | default 80 -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "ax-next.hostComponentName" .) (include "ax-next.hostNamespace" .) (int $port) -}}
{{- end }}

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
Auth-provider gates — single source of truth shared between hook-secret.yaml
and host/deployment.yaml. Each helper returns the literal string "true" when
the provider is configured for THIS render, "false" otherwise. Callers
compare with `eq` (helm has no boolean-returning template primitive).

A provider counts as "configured" when EITHER the operator passed values
this install/upgrade OR the existing chart Secret carries the lookup-stable
data key from a prior install. The lookup branch is what keeps a
`helm upgrade` that doesn't re-pass `--set` args from silently dropping the
provider's env var (which would tank boot with `no-auth-providers`).

Helm executes `lookup` against the live cluster only — it returns nil during
`helm template` / `--dry-run` / first-install. So the helper falls through
to the values-driven branch in those cases, which is exactly the semantics
hook-secret.yaml's `required` already enforces.
*/}}

{{- define "ax-next.devBootstrapEnabled" -}}
{{- $existing := lookup "v1" "Secret" (include "ax-next.hostNamespace" .) (printf "%s-secrets" (include "ax-next.fullname" .)) -}}
{{- if and .Values.auth.devBootstrap .Values.auth.devBootstrap.token -}}
true
{{- else if and $existing $existing.data (index $existing.data "dev-bootstrap-token") -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}

{{- define "ax-next.googleAuthEnabled" -}}
{{- if and .Values.auth.google .Values.auth.google.clientId -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}
{{/*
NOTE: googleAuthEnabled deliberately does NOT check the existing Secret —
unlike devBootstrap, google needs clientId/issuer/redirectUri inline in the
deployment env (only clientSecret is secret-stored). If an operator drops
clientId from values, we have nothing to stamp those non-secret env vars
with, so the cleanest behavior is "no google this render." The secret's
google-client-secret data key stays lookup-stable inside hook-secret.yaml so
re-enabling google later (re-passing clientId) doesn't require re-passing
the secret.
*/}}
