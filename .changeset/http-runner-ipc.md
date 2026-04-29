---
"@ax/ipc-core": minor
"@ax/ipc-http": minor
"@ax/ipc-server": patch
"@ax/ipc-protocol": minor
"@ax/sandbox-k8s": patch
"@ax/preset-k8s": minor
"@ax/chat-orchestrator": patch
---

HTTP runner-IPC is now wired end-to-end. `@ax/ipc-core` extracted from
`@ax/ipc-server` (transport-agnostic dispatcher, auth, body, response,
errors, handlers). `@ax/ipc-http` is the new TCP listener that mirrors
`@ax/ipc-server` for the k8s-mode preset; the host pod binds it at init.
The runner-side IPC client now supports `http://` end-to-end.
`parseRunnerEndpoint` lives in `@ax/ipc-protocol` (single source of truth
for the URI grammar). `@ax/sandbox-k8s` returns the host's cluster
Service URL as the runner endpoint; runner pods no longer have a
`containerPort: 7777` (they don't bind anything — runners are pure IPC
clients in both transports).
