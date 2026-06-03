# TASK-149 — credential-proxy → TCP listen + Service + CA-without-hostPath

Move the credential-proxy off its `hostPath`-mounted Unix socket onto a TCP listener
fronted by a k8s Service, and deliver the CA cert to the runner via env (no shared dir).
This is the production-gVisor root (GKE Sandbox bans `hostPath`). Legacy hostPath path
stays intact; the two are mutually exclusive.

Invariants: I9 (hostPath → TCP proxy gate). Keep I1/I5 untouched (no pod-shape change
beyond the proxy mount/env). Security-checklist: YES (IPC/transport change).

## Mode discriminator

- **hostPath mode** — `config.proxySocketHostPath` non-empty. Today's behavior:
  `proxy-socket` hostPath volume + mount at `/var/run/ax`; cert vars point at the
  mounted `/var/run/ax/proxy-ca/ca.crt`; runner reaches the proxy over the Unix
  socket via the bridge (`AX_PROXY_UNIX_SOCKET`).
- **TCP mode** — `config.proxySocketHostPath` empty AND `proxyConfig.endpoint` set
  (a `http://...` cluster Service URL from `proxy:open-session`). No `proxy-socket`
  volume/mount; cert vars point at a tmpfs path the runner writes; `AX_PROXY_CA_PEM`
  carries the PEM; runner reaches the proxy directly over TCP (`AX_PROXY_ENDPOINT` /
  `HTTPS_PROXY`).

The CA path constant in TCP mode: `/home/runner/.ax/proxy-ca/ca.crt` (HOME is
`/home/runner`, a tmpfs emptyDir already mounted — writable at runner boot).

## Tasks (independent, testable)

### T1 — sandbox-k8s config: `proxyEndpoint` knob + mutual-exclusivity (config.ts)
- Add `proxyEndpoint?: string` to `SandboxK8sConfig` and `ResolvedSandboxK8sConfig`
  (empty string = unset, mirroring `proxySocketHostPath`).
- `resolveConfig`: reject when BOTH `proxyEndpoint` and `proxySocketHostPath` are set
  (PluginError `invalid-config`, "exactly one"); accept exactly one or neither.
- Tests (config.test.ts): both-set rejects; only-endpoint accepts; only-hostPath
  accepts (existing); neither accepts (existing).
- Load-bearing: pod-spec keys the mode off these.

### T2 — pod-spec TCP mode (pod-spec.ts)
- When TCP mode (proxyConfig present, `proxySocketHostPath` empty, `endpoint` set):
  - cert vars (`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`GIT_SSL_CAINFO`/`DENO_CERT`)
    point at the tmpfs CA path (`/home/runner/.ax/proxy-ca/ca.crt`).
  - stamp `AX_PROXY_CA_PEM=<proxyConfig.caCertPem>`.
  - NO `proxy-socket` volume or mount (already gated on `proxySocketHostPath` — the
    empty-string branch skips them, so this is automatic once the cert path is split).
  - `AX_PROXY_ENDPOINT`/`HTTPS_PROXY`/`HTTP_PROXY` from `proxyConfig.endpoint`
    (existing `pc.endpoint` branch — unchanged).
- hostPath mode unchanged: cert vars → `/var/run/ax/proxy-ca/ca.crt`, no
  `AX_PROXY_CA_PEM`.
- Tests (pod-spec.test.ts): TCP spec has NO `proxy-socket` volume/mount, HAS
  `AX_PROXY_ENDPOINT` + `AX_PROXY_CA_PEM`, cert vars at the tmpfs path; hostPath spec
  unchanged (still `/var/run/ax/...` + has the volume, no `AX_PROXY_CA_PEM`).

### T3 — runner CA-from-env at boot (agent-claude-sdk-runner)
- New module `proxy-ca-from-env.ts`: if `AX_PROXY_CA_PEM` is set and the target CA
  file (`NODE_EXTRA_CA_CERTS` or a fixed path) does NOT already exist, write the PEM
  there (mkdir -p + 0600) before the SDK spawns. No-op when the file already exists
  (hostPath mode wins) or when the env is unset.
- Wire it into `main.ts` right after `setupProxy` (before any SDK use). Failure to
  write is bootstrap-fatal (return 2) — same posture as the subprocess CA-write.
- Tests: writes the PEM when env set + file absent; no-ops when file already exists;
  no-ops when env unset.
- Mirror the subprocess backend's CA-write (`open-session.ts:506`).

### T4 — credential-proxy advertised endpoint (plugin.ts)
- Add `advertisedEndpoint?: string` to `CredentialProxyConfig` (analogous to
  `hostIpcUrl`). When set AND TCP listen, `proxy:open-session` returns it as
  `proxyEndpoint` (the cluster-reachable Service URL) instead of `tcp://<bindhost>:<port>`.
- `buildEndpointString`: when `advertisedEndpoint` present + TCP, return it verbatim
  (must already be `tcp://...` so the orchestrator's `endpointToProxyConfig` parses it).
- Tests (plugin.test.ts): TCP + advertisedEndpoint → open-session returns the
  advertised URL; TCP without it → `tcp://<host>:<port>` (existing); unix unchanged.

### T5 — k8s preset wiring (presets/k8s/src/index.ts)
- Config: add `credentialProxy.advertisedEndpoint?` and `credentialProxy.tcpPort?`;
  add `sandbox.proxyEndpoint?`.
- When `credentialProxy.tcpPort` set (TCP mode): build `listen: { kind: 'tcp', host:
  '0.0.0.0', port }` + `advertisedEndpoint`; else keep the unix default. Mutually
  exclusive with `socketPath`.
- Thread `sandbox.proxyEndpoint` into `createSandboxK8sPlugin`.
- Env loader: read `AX_PROXY_TCP_PORT` + `AX_PROXY_ADVERTISED_ENDPOINT` (proxy) and
  `K8S_PROXY_ENDPOINT` (sandbox).
- Tests (preset.test.ts): env → config mapping for the new vars; mutual-exclusivity
  surfaces (both socketPath + tcpPort is a config error or the loader picks one).

### T6 — chart: TCP block + Service + NetworkPolicy egress (deploy/charts)
- `values.yaml`: add `credentialProxy.tcp` block (`enabled` + `port` +
  advertised Service URL helper). Keep `sandbox.proxySocketHostPath` as legacy. The
  two are mutually exclusive (document; a validate helper fails on both).
- `templates/host/deployment.yaml`: in TCP mode stamp `K8S_PROXY_ENDPOINT` +
  `AX_PROXY_TCP_PORT` + `AX_PROXY_ADVERTISED_ENDPOINT`, add the proxy containerPort,
  drop the hostPath socket volume (gated on the legacy path being empty — already is).
- New `templates/credential-proxy-service.yaml`: ClusterIP Service fronting the proxy
  TCP port, selecting the host pod, rendered only in TCP mode.
- `sandbox-restrict.yaml`: add an egress rule allowing `ax.io/plane: execution` pods →
  the proxy Service port, rendered only in TCP mode.
- `_helpers.tpl`: `ax-next.credentialProxyServiceUrl` (analogous to `hostIpcUrl`).
- Tests (render.test.ts): TCP values render the Service + the NetworkPolicy egress
  rule + the host env; default (hostPath) values render neither (back-compat).

## Half-wired window

T1–T5 ship the code path; T6 ships the chart that turns it on. All in ONE PR — the
TCP path is fully wired (preset reads chart env → plugin TCP listen + advertised URL →
pod-spec TCP env → runner CA-from-env) and reachable via a TCP-mode chart render. The
existing kind goldenpath (hostPath) stays the default and is unchanged. No window
left open.

## YAGNI pass

- T4 advertisedEndpoint: load-bearing — without it the runner gets `127.0.0.1:<port>`,
  unreachable cross-pod. KEEP.
- T6 NetworkPolicy egress: load-bearing — without it the runner can't reach the proxy
  Service under enforced policy. KEEP.
- A `credentialProxy.tcp.enabled` bool vs deriving from `port`: keep an explicit
  `enabled` flag for operator clarity (mirrors `gitServer.enabled`). KEEP.
