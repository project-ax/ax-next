---
'@ax/sandbox-k8s': minor
'@ax/preset-k8s': minor
---

Add a selectable Agent Sandbox lifecycle backend using fresh Sandbox resources
and the existing runner/session hooks. Preserve AX proxy-only networking,
non-root runners, sidecars and mounts; prepare writable NFS ownership in a fixed
host-managed pod. Revoke sessions before parent deletion and detect backing Pod
replacement. Add Helm wiring, namespaced RBAC, configuration guards and a GKE
staging overlay. Warm pools and snapshots are not enabled in this stage.
