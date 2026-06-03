# Impl plan — dev-dependency services in the agent sandbox (Option A: compose-as-a-pod)

> **For agentic workers / auto-ship:** this is a PR-sliced epic. Each `### Slice Sn`
> below is one self-contained, PR-sized card; the `Depends on:` line is the DAG edge.
> `auto-ship --design <this file>` decomposes these into To Do cards (deps wired) and
> drains them. Each slice grows its own task-level plan when it ships (yolo-ship).

**Design (source of truth for WHY + spike evidence):**
`docs/plans/2026-06-03-dev-services-in-sandbox-decision.md`.

**Goal:** Let an ax agent check out a private repo and run its test suite against
**Kafka + MongoDB** provided as **native sidecars in the runner pod** (the
"compose-as-a-pod" model), reachable at `localhost`, under the production gVisor runtime.

**Architecture:** A new transport/storage-agnostic `services` capability on the shared
`sandbox:open-session` contract describes a list of service descriptors
(`{ name, image, ports, env, healthcheck, writablePaths }`). The **k8s backend** renders
each as a **native sidecar** (`initContainers` with `restartPolicy: Always`) with its own
writable `emptyDir` mounts; the **subprocess backend** renders each via `docker compose`.
The runner reaches every service at `127.0.0.1:<port>` (shared pod netns / shared host
loopback), so a repo's existing dev test config runs unchanged. Services are declared on
**connectors** (the post-TASK-100 capability home), folded into the open-session payload
by `connector-union.ts`, and admin-allowlisted at the capability wall.

**Tech stack:** TypeScript (pnpm monorepo), Zod wire schemas, `@kubernetes/client-node`
pod specs, Helm chart (k8s Service + NetworkPolicy), `docker compose` (local), Vitest,
shadcn/React for the declaration UI.

---

## ⚠️ Plan-vs-reality correction — capabilities live on CONNECTORS, not skills

The decision memo and the handoff prompt both say services are "declared via **agent/skill
capability**." **That wording is stale.** TASK-100 (the 2026-06-01 connectors refactor)
**removed the capability block from skill manifests** — `@ax/skills-parser`'s
`manifest.ts` now *rejects* any `capabilities:` key with: *"capabilities live on connectors
now. Reference the connector(s) this skill uses."* The neutral `Capabilities` shape
(`allowedHosts` / `credentials` / `mcpServers` / `packages`) lives in `@ax/skills-parser`
and is consumed by **`@ax/connectors`**; the orchestrator folds it via
`packages/chat-orchestrator/src/connector-union.ts`.

**Decision baked into this plan:** the `services` capability is a **new field on the shared
`Capabilities` shape**, declared on **connectors**, and folded through `connector-union.ts`
— exactly like `allowedHosts` / `mcpServers` / `packages` already are. Wherever the memo
says "skill capability," read "connector capability." (See invariant **I11**.)

---

## Decisions baked in (do NOT re-litigate — from the completed spike)

1. **Topology = Option A, native sidecars.** `initContainers` with `restartPolicy: Always`.
   Plain `containers[]` are **forbidden** — they deadlock `watchPodExit` (`lifecycle.ts:192`)
   because `restartPolicy: Never` (`pod-spec.ts:410`) makes the pod terminal only when *all*
   containers exit; the DBs never exit, so the pod leaks for `activeDeadlineSeconds` (6h).
2. **Runtime + broker = gVisor ON + JVM Kafka (KRaft) + Mongo.** Redpanda is
   control-proven gVisor-incompatible (dies on an early `open()` of a pseudo-file gVisor's
   stubbed `/proc`/`/sys` doesn't expose). We pay the JVM memory/cold-start cost to keep the
   untrusted runner sandboxed.
3. **Services bind `0.0.0.0`** (kubelet probes dial the pod IP, not loopback) — safe because
   the runner pod's NetworkPolicy is `ingress: []` and they inherit the pod's egress lock.
4. **Each service needs writable `emptyDir` mounts** for its data/log/config dirs (rootfs
   stays read-only) + pod `fsGroup: 1000`.
5. **credential-proxy must move `hostPath` → TCP-listen + Service** (GKE Sandbox bans
   `hostPath`). This is the dependency root for any gVisor/GKE deploy.
6. **Open-question defaults (stated, not blocked):** per-session services (clean state) by
   default; images digest-pinned + declared on a connector capability + admin-allowlisted;
   a team `docker-compose.yml` is *translated as curated input*, never auto-imported.

---

## Invariants (I1..I12) — fold every spike finding + ax convention

- **I1 — Native sidecars only (lifecycle, spike F1).** k8s service containers render as
  `initContainers` with `restartPolicy: Always`, never plain `containers[]`. The runner
  stays `containers[0]` (sidecars live in `initContainerStatuses`), so the existing
  exit-code logic in `lifecycle.ts` / `watchPodExit` is untouched. Regression test: a
  rendered services pod has zero extra `containers[]` entries and N `initContainers` with
  `restartPolicy: Always`.
- **I2 — Transport/storage-agnostic descriptor (CLAUDE.md invariant #1).** The `services`
  field carries only `{ name, image, ports, env, healthcheck, writablePaths }`. **No**
  `pod` / `container` / `securityContext` / `runtimeClassName` / `volume` / `emptyDir` /
  `initContainers` / `restartPolicy` vocabulary crosses the hook boundary. Each backend
  translates internally. (Boundary review below.)
- **I3 — Both backends in one half-wired window (invariant #3).** k8s → native sidecars
  (S3); subprocess → docker compose (S4). The capability is reachable from the canary (S7)
  before the window closes. Every slice that adds plumbing loads it in **both** the CLI
  preset and the k8s preset in the same PR.
- **I4 — Services bind `0.0.0.0` and inherit the egress lock (spike gotcha).** The
  descriptor never encodes a bind address (I2); the k8s backend documents the `0.0.0.0`
  requirement via the image's own config/env, and the NetworkPolicy (`ingress: []`)
  guarantees nothing external can reach a sidecar. Sidecars get the same `egress` allowlist
  as the runner — they cannot phone home.
- **I5 — Per-service writable mounts; rootfs read-only; `fsGroup: 1000` (spike F4).** Each
  descriptor's `writablePaths[]` becomes a per-service `emptyDir` mount. Sidecars keep
  `readOnlyRootFilesystem: true`, `runAsNonRoot`, uid/gid 1000, `capabilities.drop: [ALL]`.
  The pod gains `securityContext.fsGroup: 1000` so the `emptyDir`s are group-writable.
- **I6 — Readiness budget covers JVM cold-start + image pull + sequential startup (spike
  F2).** Native sidecars start **sequentially** (each gates the next via startup probe), so
  cold-start times add up; a JVM broker on a fresh gVisor node also pays a multi-hundred-MB
  image pull. When `services` are present the k8s readiness budget is raised (config knob +
  a per-service-count scaling factor), and each service may declare its own readiness
  probe. Default 60s `readinessTimeoutMs` stays for service-less sessions.
- **I7 — gVisor ON; JVM Kafka, not Redpanda.** The descriptor is broker-agnostic, but the
  canary and docs use JVM Kafka (KRaft) + Mongo because Redpanda is gVisor-incompatible.
  Nothing in the descriptor or backends bakes in a specific broker.
- **I8 — Images digest-pinned + admin-allowlisted (supply chain).** Third-party images now
  run adjacent to the untrusted runner. The descriptor's `image` MUST be digest-pinned
  (`…@sha256:<64hex>`), validated at the wire boundary; the orchestrator only forwards
  services from an **admin-approved** connector capability. They inherit the pod egress lock
  (can't exfiltrate). **Invoke `security-checklist` on S2, S3, S4, S5.**
- **I9 — hostPath → TCP proxy gate.** GKE Sandbox forbids `hostPath`; the credential-proxy
  must listen on TCP behind a Service, and the CA cert must reach the runner without a shared
  dir, before any pod runs under gVisor/GKE. **S1 is the production-gVisor root.**
- **I10 — Curated compose translation, never auto-import.** A team `docker-compose.yml` is
  translated into descriptors by an explicit, reviewed helper (S6) that *drops* host mounts,
  `privileged`, `cap_add`, host networking, and bind-mounted sockets. Untrusted compose
  never crosses into the trusted pod verbatim.
- **I11 — Capabilities live on connectors (plan-vs-reality, see top).** `services` is a new
  field on the shared `Capabilities` shape in `@ax/skills-parser`, declared on connectors,
  folded by `connector-union.ts`.
- **I12 — No cross-plugin imports (invariant #2).** Backends import the descriptor type from
  `@ax/sandbox-protocol`; the capability shape from `@ax/skills-parser`. Both are
  eslint-allow-listed pure schema/parser packages. No runtime cross-plugin import.

---

## Slice DAG

```
        S1 (proxy → TCP + Service)        [prod-gVisor root]
        S2 (services descriptor + grammar + validator)
                 │
        ┌────────┴────────┐
        ▼                 ▼
   S3 (k8s sidecars)   S4 (subprocess/docker-compose parity)
        └────────┬────────┘
                 ▼
        S5 (orchestrator: connector services fold → open-session)
                 │
        ┌────────┴────────┐
        ▼                 ▼
   S6 (declare UI +     S7 (canary: automated + (walk))
   compose translate)
```

| Slice | Title | Depends on |
|---|---|---|
| S1 | credential-proxy → TCP listen + Service + CA-without-hostPath | none |
| S2 | neutral `services` descriptor + `Capabilities.services` grammar + validator | none |
| S3 | k8s backend: native-sidecar rendering + mounts + fsGroup + readiness budget | S2 |
| S4 | subprocess backend parity (docker compose) | S2 |
| S5 | orchestrator: fold connector `services` capability → `sandbox:open-session` | S2, S3, S4 |
| S6 | declaration surface: connector admin UI + curated compose→descriptor translation | S2, S5 |
| S7 | canary/acceptance: automated CI canary (closes window) + `(walk)` kind walk | S3, S4, S5 |

**Half-wired window:** opens at **S2** (the schema field exists but nothing renders it),
closes at **S7** (the automated canary exercises the full path). Every slice in between
loads the new plumbing in **both** presets in the same PR and carries an explicit
"window still OPEN" note in its PR description.

---

## Boundary review — the new `services` field on `sandbox:open-session`

Required by CLAUDE.md › Boundary review (new service-hook payload field).

- **Alternate impl this could have:** yes, two concrete ones — k8s native sidecars (S3) and
  the subprocess `docker compose` backend (S4). Genuine second impl exists → the abstraction
  is earned, not premature.
- **Payload field names that might leak:** reviewed each —
  - `name` — generic. ✅
  - `image` — a container-image reference is genuinely cross-backend (k8s pulls it, docker
    pulls it). Not k8s-specific. ✅ (digest pin is policy, not vocabulary.)
  - `ports` — neutral (`number[]`). ✅
  - `env` — neutral `Record<string,string>`. ✅
  - `healthcheck` — modeled as `{ kind: 'tcp', port } | { kind: 'exec', command: string[] }`,
    NOT as a k8s `readinessProbe`/`startupProbe` shape. Each backend maps it (k8s → a
    startupProbe on the sidecar; docker → a `healthcheck:` block / TCP poll). ✅
  - `writablePaths` — a list of in-container dirs that need to be writable. Neutral: k8s maps
    each to an `emptyDir` mount; docker maps each to a tmpfs/volume. **Renamed away from**
    `emptyDirs`/`volumeMounts` deliberately so no k8s vocabulary leaks. ✅
  - **Rejected names** (would leak): `initContainer`, `restartPolicy`, `securityContext`,
    `fsGroup`, `runtimeClassName`, `emptyDir`, `volumeMounts`, `containerPort`, `sidecar`.
    None appear in the descriptor.
- **Subscriber risk:** the only consumers are the two sandbox backends (they `safeParse` the
  envelope at their trust boundary). No subscriber keys off a service field. A backend that
  can't honor a descriptor (e.g. a future backend with no container runtime) must reject the
  session loudly, not silently drop services.
- **Wire surface (IPC):** `sandbox:open-session` is host-internal (orchestrator → sandbox
  plugin); it is **not** a runner→host IPC action, so the untrusted runner can never inject
  a `services` descriptor. The schema lives in `@ax/sandbox-protocol` (already the single
  source of truth for this envelope), not a central file.

---

## Slice details

### Slice S1 — credential-proxy → TCP listen + Service + CA-without-hostPath
**Depends on:** none · **Window:** independent (production-gVisor root, I9) · **security-checklist: YES** (IPC/transport change)

**Why:** GKE Sandbox bans `hostPath`; today the host proxy listens on a Unix socket shared
into runner pods via a `hostPath` mount (`config.ts proxySocketHostPath`, `pod-spec.ts`
`proxy-socket` volume, chart `host/deployment.yaml` + `kind-dev-values.yaml`). Under gVisor
this fails. The proxy already supports `listen: { kind: 'tcp', host, port }`
(`listener.ts:167`, `plugin.ts buildEndpointString`), so the host side is mostly config; the
work is the chart Service + NetworkPolicy egress + delivering the CA cert to the runner
without a shared dir.

**Scope / files:**
- `deploy/charts/ax-next/values.yaml` + `kind-dev-values.yaml`: add a `credentialProxy.tcp`
  block (enable + port + advertised cluster Service URL). Keep `proxySocketHostPath` as the
  legacy/kind path; the two are mutually exclusive.
- `deploy/charts/ax-next/templates/host/deployment.yaml`: when TCP mode, run the proxy with
  `listen: { kind: 'tcp', host: '0.0.0.0', port }`; drop the hostPath socket volume.
- New `deploy/charts/ax-next/templates/credential-proxy-service.yaml` (or fold into host
  service): a `Service` fronting the proxy TCP port, selecting the host pod.
- `deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml`: add an `egress`
  rule allowing `ax.io/plane: execution` pods → the proxy Service port (today they reach
  only host IPC + DNS). This is the only new hole, and it goes to the *proxy* (the egress
  chokepoint), not the internet.
- `packages/sandbox-k8s/src/config.ts`: add a `proxyEndpoint?: string` (cluster Service URL)
  knob, mutually exclusive with `proxySocketHostPath`. Resolve + validate "exactly one".
- `packages/sandbox-k8s/src/pod-spec.ts`: in TCP mode, stamp `AX_PROXY_ENDPOINT` /
  `HTTPS_PROXY` / `HTTP_PROXY` from the per-session `proxyConfig.endpoint` (this branch
  already exists at `pod-spec.ts:327`) and **deliver the CA cert without the hostPath
  mount** — stamp `proxyConfig.caCertPem` as an env var (`AX_PROXY_CA_PEM`) and point
  `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `GIT_SSL_CAINFO` / `DENO_CERT` at the path the
  runner writes it to. Skip the `proxy-socket` volume + mount entirely in TCP mode.
- `packages/agent-claude-sdk-runner`: at boot, if `AX_PROXY_CA_PEM` is set and the CA file
  doesn't already exist (hostPath mode still wins when present), write the PEM to a tmpfs
  path (e.g. `$HOME/.ax/proxy-ca/ca.crt`) before the SDK spawns. Mirror the subprocess
  backend, which already writes `caCertPem` to a per-session file (`open-session.ts:506`).
- `packages/credential-proxy/src/plugin.ts`: the per-session `proxyEndpoint` returned from
  `proxy:open-session` must be the **cluster-reachable Service URL** in TCP mode, not
  `127.0.0.1:<port>`. Add an "advertised endpoint" config knob (analogous to `hostIpcUrl`)
  the host preset reads from the chart.

**Invariants:** I9. Keep I1/I5 untouched (no pod-shape change beyond proxy mount/env).

**Tests (TDD):**
- `pod-spec.test.ts`: TCP-configured spec has **no** `proxy-socket` volume/mount, **has**
  `AX_PROXY_ENDPOINT` + `AX_PROXY_CA_PEM` env; hostPath-configured spec unchanged.
- `config.test.ts`: rejects both `proxyEndpoint` and `proxySocketHostPath` set; accepts
  exactly one.
- runner test: writes CA PEM from env to disk at boot when set, no-ops when the hostPath CA
  file already exists.
- chart render test (if the repo has helm-template tests; else a `chart-shape` unit test like
  the issue-#39 listener-split contract): Service + NetworkPolicy egress rendered when TCP.

**Acceptance:** existing kind MANUAL-ACCEPTANCE chat walk still passes with `proxySocketHostPath`
(legacy path unchanged); a TCP-mode render produces a self-consistent spec. The real GKE/gVisor
proof is the spike (already done) + the S7 `(walk)` card.

---

### Slice S2 — neutral `services` descriptor + `Capabilities.services` grammar + validator
**Depends on:** none · **Window:** OPENS the half-wired window · **security-checklist: YES** (untrusted-input schema at a trust boundary)

**Scope / files:**
- `packages/sandbox-protocol/src/schemas.ts`: add `ServiceDescriptorSchema` and a
  `services: z.array(ServiceDescriptorSchema).max(N).optional()` field on
  `OpenSessionInputSchema`. Shape (I2):
  ```ts
  ServiceDescriptorSchema = z.object({
    name: z.string().regex(ID_RE),                       // diagnostics + container name
    image: z.string().regex(/.+@sha256:[0-9a-f]{64}$/),  // I8 digest pin, re-validated at wire
    ports: z.array(z.number().int().min(1).max(65535)).max(16),
    env: z.record(z.string().max(256), z.string().max(2048)).superRefine(/* ≤32 entries */),
    healthcheck: z.union([
      z.object({ kind: z.literal('tcp'), port: z.number().int().min(1).max(65535) }),
      z.object({ kind: z.literal('exec'), command: z.array(z.string().max(256)).min(1).max(16) }),
    ]).optional(),
    writablePaths: z.array(z.string().regex(/^\//).max(256)).max(16).default([]),
  });
  ```
  Cap the array (e.g. `.max(8)`); reuse the existing `ID_RE`/env-cap patterns in this file.
- `packages/skills-parser/src/capabilities.ts`: add `services?: ServiceDescriptor[]` to the
  neutral `Capabilities` interface + its Zod `CapabilitiesSchema`, using the SAME descriptor
  shape (defined once in `@ax/skills-parser`, re-validated in `@ax/sandbox-protocol` — both
  are pure allow-listed packages, I12). Default `[]`.
- New validator following the `@ax/validator-*` plugin pattern (see `validator-skill`,
  `validator-routine`, `validator-identity`): a `services:validate` (or a subscriber on the
  connector-capability validation path) that enforces digest-pin (I8), the descriptor caps,
  and **rejects** any forbidden vocabulary smuggled in. Wire it into both presets.

**Invariants:** I2, I8, I11, I12.

**Tests (TDD):**
- schema accepts a well-formed descriptor; rejects a non-digest image, an absolute-less
  writablePath, an over-cap env, a forbidden extra key.
- capability grammar round-trips `services` through parse/serialize.
- validator rejects a non-pinned image and a descriptor whose `writablePaths` isn't absolute.

**Acceptance:** `pnpm build && pnpm test --filter @ax/sandbox-protocol --filter @ax/skills-parser`
green; `pnpm lint` clean. Window is now OPEN — note it in the PR.

---

### Slice S3 — k8s backend: native-sidecar rendering + mounts + fsGroup + readiness budget
**Depends on:** S2 · **Window:** OPEN · **security-checklist: YES** (sandbox boundary)

**Scope / files:**
- `packages/sandbox-k8s/src/pod-spec.ts`: for each `input.services[]`, append an
  `initContainers[]` entry with `restartPolicy: 'Always'` (native sidecar, I1), the locked
  `containerSecurity` context (I5), `image`, `env`, `ports` → `containerPort`s, a
  `startupProbe` derived from `healthcheck` (I6), and per-service `volumeMounts` for each
  `writablePaths` entry. Add a matching `emptyDir` `volume` per writable path. Set
  `spec.securityContext.fsGroup = 1000` (I5) when services are present. The runner stays
  `containers[0]` (I1) — sidecars go in `initContainers` AFTER the existing `sdk-scaffold`
  init container (ordering: scaffold → service sidecars → runner). **Confirm** the kubelet
  treats `restartPolicy: Always` initContainers as sidecars and starts the main container
  once their startup probes pass.
- `packages/sandbox-k8s/src/config.ts`: add per-service resourcing defaults
  (`serviceCpuLimit` / `serviceMemoryLimit` / requests) and a readiness-budget policy:
  when services are present, `readinessTimeoutMs` scales (e.g. base + per-service-cold-start
  allowance) to cover JVM cold-start + image pull + sequential startup (I6).
- Load `@ax/sandbox-k8s` with services support in the **k8s preset** (it already loads
  there); no preset wiring change beyond confirming the rendered spec.

**Invariants:** I1, I4, I5, I6, I7, I8.

**Tests (TDD):**
- N services → N `initContainers` (plus `sdk-scaffold`), each `restartPolicy: Always`,
  locked securityContext, one `emptyDir` mount per `writablePaths` entry; **zero** extra
  `containers[]`; runner still `containers[0]`.
- `fsGroup: 1000` present iff services present.
- healthcheck `{kind:'tcp',port}` → a `startupProbe.tcpSocket`; `{kind:'exec',command}` →
  `startupProbe.exec`.
- readiness budget scales with service count; service-less sessions keep 60s.
- **Bug-fix-policy regression for I1:** a 2-service render keeps `containerStatuses[0]`
  semantics — assert no service lands in `containers[]` (the leak path the spike found).

**Acceptance:** `pnpm test --filter @ax/sandbox-k8s` green; lint clean.

---

### Slice S4 — subprocess backend parity (docker compose)
**Depends on:** S2 · **Window:** OPEN · **security-checklist: YES** (process spawn / untrusted input)

**Scope / files:**
- `packages/sandbox-subprocess/src/open-session.ts`: when `input.services` is non-empty,
  bring the services up via `docker compose` (local dev already has Docker — see the memo)
  on a per-session project name keyed by `sessionId`; map each descriptor to a compose
  service (`image`, `environment`, `ports` published on `127.0.0.1`, tmpfs/volumes for
  `writablePaths`, a `healthcheck` from the descriptor). Wait for health before returning.
  Tear them down (`docker compose down -v`) in the existing `child.once('close')` cleanup
  alongside the tempdir `fs.rm`.
- Keep the same locked posture as k8s where docker allows (no host mounts, no `privileged`,
  no host networking). Fail loud if Docker is unavailable and services were requested.
- Load in the **CLI preset** (subprocess is the CLI/local backend); confirm parity.

**Invariants:** I2, I3, I4 (publish only on loopback), I7, I8, I10.

**Tests (TDD):**
- descriptor → compose project shape (unit-test the translation function with no real
  Docker): image/env/ports/healthcheck/writablePaths mapped; no host mount, no privileged.
- services requested + Docker unavailable → loud `PluginError`, session not half-opened.
- cleanup path issues `compose down` on close (mock the spawn).

**Acceptance:** `pnpm test --filter @ax/sandbox-subprocess` green; lint clean. (A real
`docker compose` up is an opt-in/integration test, not CI-gating.)

---

### Slice S5 — orchestrator: fold connector `services` capability → `sandbox:open-session`
**Depends on:** S2, S3, S4 · **Window:** OPEN · **security-checklist: YES** (capability → privileged payload)

**Scope / files:**
- `packages/chat-orchestrator/src/connector-union.ts`: in `foldConnectors`, collect
  `c.capabilities.services` across the agent's approved connectors into a `services[]` list
  on the fold result (mirror how `allowedHosts` / `packages` / `mcpServers` are folded today,
  lines ~363-411). Dedupe by `name`; on a name collision across connectors, reject loudly
  (one service name = one descriptor — a collision is a misconfiguration, not a silent merge).
- `packages/chat-orchestrator/src/orchestrator.ts`: thread the folded `services` onto the
  `OpenSessionInput` constructed at ~`orchestrator.ts:2150`. Only services from
  **admin-approved** connectors reach here (the connector capability wall already gates
  approval — confirm the fold reads only active/approved connectors, I8). Soft-couple via
  `hasService` where a stripped preset wouldn't carry the capability.
- Update `@ax/chat-orchestrator` manifest if a new call edge appears (none expected — this is
  payload construction, not a new hook).

**Invariants:** I3, I8, I11, I12.

**Tests (TDD):**
- a connector with a `services` capability → `services` present on the constructed
  open-session payload; no connectors → field omitted.
- name collision across two connectors → loud error.
- **no-synthetic-actor regression** (per `.claude/memory` `feedback_no_synthetic_actors…`):
  the fold runs under the real owner ctx; don't spy a fake fire.

**Acceptance:** `pnpm test --filter @ax/chat-orchestrator` green; lint clean. With S3+S4
merged, a declared service now renders end-to-end in both backends (window can close at S7).

---

### Slice S6 — declaration surface: connector admin UI + curated compose→descriptor translation
**Depends on:** S2, S5 · **Window:** can land before or after window close (additive UI) · **shadcn skill: YES**

**Scope / files:**
- `packages/connectors/src/admin-routes.ts` + `types.ts`: accept + persist a `services`
  block on the connector capability proposal (it rides the opaque `capability_proposal`
  JSONB, re-validated against `CapabilitiesSchema` on read — the S2 grammar already covers
  it). Surface declared services (name/image/ports only — never secrets) in the connector
  detail response.
- `packages/channel-web` (invoke the **`shadcn`** skill, `-c packages/channel-web`): a
  "Services" section in the connector editor — declare `name`, digest-pinned `image`,
  `ports`, `env`, `writablePaths`. Compose existing shadcn primitives (`Field`/`FieldGroup`,
  `Input`, `Button`, `Card`, `Alert`); no hand-rolled forms (invariant #6).
- New curated **compose→descriptor translation** helper (a pure function, well-tested): parse
  a pasted `docker-compose.yml`, map `services.<name>.{image,environment,ports,healthcheck}`
  to descriptors, and **drop** `volumes` host mounts, `privileged`, `cap_add`,
  `network_mode: host`, and bind-mounted sockets (I10). Surface dropped fields to the author
  ("we removed these because they can't cross into the sandbox") in the project's voice.
  Digest-pin enforcement: flag un-pinned images for the author to pin.

**Invariants:** I8, I10, invariant #6 (shadcn).

**Tests (TDD):**
- compose translation: a compose with a host mount + `privileged` → descriptors with those
  stripped + a reported list of drops; an un-pinned image → flagged.
- admin route round-trips a `services` capability proposal through the store.
- UI component test: the Services section renders + validates digest-pin.

**Acceptance:** `pnpm test --filter @ax/connectors --filter @ax/channel-web` green; lint
clean; shadcn rule-check clean.

---

### Slice S7 — canary/acceptance (closes the half-wired window)
**Depends on:** S3, S4, S5 · **Window:** CLOSES it · adds a `(walk)` follow-up card

**Scope / files:**
- **Automated canary (CI-gating, closes the window):** extend the canary acceptance test
  (the `@ax/core` `acceptance.test.ts` pattern, or a dedicated package canary like
  `web-tools`/`routines` use) to exercise: a connector declaring a `services` capability →
  orchestrator fold (S5) → `sandbox:open-session` with `services` → the backend renders it.
  Use the mock/subprocess backend with the translation function (no real cluster) so it runs
  in CI. Assert the descriptor reaches the backend and renders (k8s pod-spec shape; or a
  subprocess compose-project shape) without smuggling forbidden vocabulary.
- **`(walk)`-tagged manual-acceptance card** (drained by the `k8s-acceptance-loop` lane, not
  yolo-shippable): on `kind-ax-next-dev`, declare a connector with Kafka + Mongo services,
  start a chat, have the agent `git clone` a small repo and run a test that connects to
  `127.0.0.1:9092` (Kafka) and `127.0.0.1:27017` (Mongo). Document the kind run is **runc**
  (gVisor forced off on kind); the gVisor proof is the spike (already done on GKE Autopilot).
  This walk's full gVisor+declared path additionally exercises **S1** and **S6**.

**Invariants:** I3 (closes the window), I7.

**Tests:** the automated canary IS the test. The `(walk)` card is manual.

**Acceptance:** full `pnpm build && pnpm test && pnpm lint` green with the canary; PR note
declares the **half-wired window CLOSED**. The `(walk)` card moves to Done after a clean kind
walk.

---

## Security review (planning-level)

Per the `security-checklist` skill. This is the epic-level walk; **each slice that touches
the sandbox boundary / IPC / untrusted input pastes its own note reflecting the *implemented*
state** (flagged "security-checklist: YES" on S1–S5).

```
## Security review
- Sandbox: NEW capability — third-party service containers run ADJACENT to the untrusted runner (same pod / compose siblings). Bounded by: digest-pinned images (I8), services come ONLY from an admin-approved connector capability, sandbox:open-session is host-internal (runner can NOT inject a descriptor — not an IPC action), sidecars keep the locked securityContext (readOnlyRootFilesystem, non-root, caps drop ALL, no SA token), per-pod emptyDir mounts (no hostPath), and the pod egress lock (ingress:[] + proxy-only egress) means a service can't phone home. S1's only new NetworkPolicy hole is runner→proxy-Service (the chokepoint), never the internet.
- Injection: service descriptors are untrusted-until-admin-approved connector input rendered into a pod-spec / compose file — never interpolated into a host shell, SQL, or an LLM prompt; image is a regex-validated digest ref; env values land in the SERVICE container's env (not the runner); writablePaths are validated-absolute mountPaths; healthcheck.exec runs as a probe INSIDE the already-sandboxed service container. The pasted docker-compose.yml (S6) is parsed as DATA and curated — host mounts / privileged / cap_add / network_mode:host / socket mounts are DROPPED (I10) — never `docker compose -f`'d verbatim. All descriptors re-validated at the wire (S2) AND the backend boundary (S3/S4, defense in depth).
- Supply chain: container images are the real surface — pinned by @sha256 digest (the version-pin analogue), admin-allowlisted (human-in-the-loop), egress-locked at runtime. No new npm dep is expected; S6's compose parse MUST reuse the repo's existing YAML parser (the one @ax/skills-parser uses), not add a new one. Any slice that does touch package.json runs its own supply-chain check.
```

**If implementation surfaces a real risk** (e.g. a backend that joins `writablePaths` into a
host path, or a compose translation that shells out): fix in the same PR, tighten the
capability, and update that slice's note to the fixed state.

## Out of scope (YAGNI — stated, not built)

- Shared-per-user/team services (the memo's alt isolation grain) — per-session is the
  default; revisit only if cold-start cost demands it.
- A sibling "dev-services" pod (Option B) + scoped egress hole — explicitly rejected in the
  memo (defeats the egress model). Only revisit if a future need wants Redpanda under a
  gVisor-off broker pod.
- Auto-importing a `docker-compose.yml` verbatim — forbidden (I10); only curated translation.
- Generic TCP egress to external brokers (Option D) — rejected (no cred injection, weaker
  SSRF posture, shared-DB test-isolation loss).

## Self-review (against the decision memo)

- Memo "two problems": repo checkout is *already solved* (credential-proxy git auth) — not a
  slice here, correctly. Service provisioning = S2–S7. ✅
- Every spike finding mapped to an invariant: F1→I1, securityContext→I5, localhost→canary S7,
  `0.0.0.0`→I4, sequential cold-start→I6, gVisor verdict→I7, hostPath ban→I9. ✅
- "What building Option A entails" (memo §7): neutral capability→S2; both backends→S3/S4;
  pod-spec sidecars→S3; per-service resourcing + readiness bump→S3; proxy TCP→S1;
  security-checklist→I8 callouts; compose translation→S6. ✅
- Plan-vs-reality correction (capabilities on connectors) surfaced, not silently followed. ✅
