{{/*
Expand the chart name.
*/}}
{{- define "cardano-wallet-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | toString | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "cardano-wallet-backend.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | toString | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride | toString -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Create chart labels.
*/}}
{{- define "cardano-wallet-backend.labels" -}}
helm.sh/chart: {{ include "cardano-wallet-backend.chart" . | quote }}
{{ include "cardano-wallet-backend.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "cardano-wallet-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cardano-wallet-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cardano-wallet-backend.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{/*
Create the service account name.
*/}}
{{- define "cardano-wallet-backend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cardano-wallet-backend.fullname" .) .Values.serviceAccount.name | toString -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name | toString -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the container image.
*/}}
{{- define "cardano-wallet-backend.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
