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
app.kubernetes.io/name: {{ include "ax-next.fullname" .context }}-{{ .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Per-component selector labels — stable across upgrades.
Call with (dict "component" "host" "context" $).
*/}}
{{- define "ax-next.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ax-next.fullname" .context }}-{{ .component }}
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
