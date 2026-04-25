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
