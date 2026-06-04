# Decision Memo — Running dev-dependency services (Kafka/Mongo) in an agent sandbox

**Date:** 2026-06-03
**Status:** Exploration + spike complete; recommendation for review. Not yet a plan.
**Author:** spike driven from a "how do we do this" question; results below are from live runs on `kind-ax-next-dev` (runc) and a GKE Autopilot cluster (gVisor).

## The use case

An agent checks out a team's **private GitLab repo** and runs its **test suite** inside
the sandbox. The suite depends on **Kafka and MongoDB**, which developers run locally
today via a `docker-compose.yml`. How do we give an ax agent those services?

## It's two problems, not one

1. **Get the repo into the sandbox** — *already solved.* ax does authenticated HTTPS git
   through the credential-proxy: a skill/agent declares the host (`gitlab.example.com`) on
   its allowlist plus a token credential, and the proxy does `url.insteadOf` placeholder
   substitution so the real token never reaches the runner. Config exercise, not new work.

2. **Provide Kafka + Mongo to the test run** — *the actual design work.* The rest of this memo.

## Constraints that rule out the obvious answers (as-built)

| Obvious idea | Why it fails |
|---|---|
| Run the team's `docker-compose.yml` in the sandbox | No container runtime in the sandbox. None. |
| Point the agent at external/shared Kafka+Mongo | The only egress path is the credential-proxy, an **HTTPS MITM** — it can't speak Kafka/Mongo binary protocols or inject creds into them. Shared mutable DBs also break test isolation. |
| Have the agent spin up the services | Runner has zero k8s API access; can't create pods. |

Useful asset: intra-pod `localhost` traffic is **not** subject to the egress NetworkPolicy
(`deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml`), and the **host**
has RBAC to create pods (the runner does not).

## Options considered

- **A — service containers in the session pod ("compose-as-a-pod").** Mongo/Kafka as
  sidecars in the runner pod; agent reaches them at `localhost`. **Recommended; pressure-tested below.**
- **B — sibling "dev-services" pod + scoped egress rule.** Decouples resourcing, but punches
  a deliberate egress hole bypassing the credential proxy (the exact thing v2's egress model
  exists to prevent) and adds cross-pod lifecycle orchestration.
- **C — services as plain processes inside the one container.** Bloats the *trusted* runner
  image or relies on large per-session downloads; Kafka-in-process forces a substitute.
- **D — external services + generic TCP egress.** Rejected: requires turning the proxy into a
  raw TCP tunnel (no cred injection, weaker SSRF posture); shared DBs break test isolation.

## Option A — pressure-test results

### Mechanics (spike 1a, kind / runc) — all passed

- **Native sidecars are mandatory.** Plain extra `containers[]` deadlock the lifecycle: with
  `restartPolicy: Never` (`packages/sandbox-k8s/src/pod-spec.ts:410`) the pod is terminal only
  when *all* containers exit, so the runner finishes but the DBs keep running → the pod never
  reaches a terminal phase → `watchPodExit` (`packages/sandbox-k8s/src/lifecycle.ts:192`) never
  resolves → cleanup never fires → the pod lingers until `activeDeadlineSeconds` (6h). **Every
  session would leak a multi-GB pod for 6 hours.** Native sidecars (`initContainers` with
  `restartPolicy: Always`) fix it: when the runner exits, the kubelet SIGTERMs the sidecars and
  the pod goes terminal. Observed: runner exit → pod **Succeeded in ~4s**, sidecars auto-`Completed`.
  Bonus: native sidecars live in `initContainerStatuses`, so `containerStatuses[0]` stays the
  runner and the existing exit-code logic is unaffected.
- **Strict securityContext is compatible.** Under the exact runner context
  (`readOnlyRootFilesystem`, uid 1000, `runAsNonRoot`, caps `drop: ALL`, `fsGroup: 1000`),
  Mongo booted clean and functional; Redpanda booted with only a *non-fatal* `perf_event_open:
  Operation not permitted` fallback. Each service needs its own writable emptyDir mounts for
  its data/log/config dirs (rootfs stays read-only).
- **localhost parity — the payoff.** The runner reached `127.0.0.1:27017` and `127.0.0.1:9092`
  (shared pod netns), and both were functionally live (created a Kafka topic, Mongo `ping ok`).
  Because the dev `docker-compose` exposes the *same* localhost ports, **the repo's existing
  test config likely runs unchanged.** This is the reason A beats B.
- **Gotchas (real design inputs):** services must bind `0.0.0.0` (kubelet probes dial the pod
  IP, not loopback) — safe because the runner pod's NetworkPolicy is `ingress: []`. Native
  sidecars start **sequentially** (each gates the next via startup probe), so cold-start times
  **add up**.

### gVisor (spike 1b, GKE Autopilot) — the runtime that actually ships

Production defaults to `runtimeClassName: gvisor` (`deploy/charts/ax-next/values.yaml`); kind
forces it off, so 1a alone wasn't enough. On a real GKE Autopilot cluster:

- **Autopilot enables gVisor with just `runtimeClassName: gvisor`** at the pod level — no node
  pool, taint, toleration, or nodeSelector (the admission webhook injects scheduling and
  auto-provisions a gVisor node). Confirmed the pod landed on a node labeled `sandbox=gvisor`.
- **Mongo: ✅ under gVisor.**
- **Redpanda: ❌ under gVisor — control-proven gVisor-specific.** It dies at startup with
  `std::system_error: open: No such file or directory`, *before its logger initializes* (so
  `--default-log-level=trace` shows nothing and `--reactor-backend=epoll` doesn't help — it's
  not backend probing). A control experiment — the **byte-identical** pod (same image, flags,
  strict securityContext, same `/var/lib/redpanda/data` + `/etc/redpanda` + `/tmp` mounts) with
  only `runtimeClassName` removed — **boots fine on a normal node.** So it is not a mount issue;
  it is gVisor-specific (Redpanda's Seastar makes an early `open()` of a kernel pseudo-file
  gVisor's stubbed `/proc`/`/sys` doesn't expose). Redpanda does not support gVisor.
- **JVM Kafka (KRaft): ✅ under gVisor.** The JVM + KRaft startup ran fine; the only blocker
  was the image writing its GC log to `/opt/kafka/logs` on the read-only rootfs — a writable
  `LOG_DIR` mount fixed it. The recurring theme: each service needs writable mounts for its
  data/log/config dirs.
- **GKE Sandbox bans `hostPath`** in sandboxed pods — and the credential-proxy bridge is
  currently a `hostPath` mount (`pod-spec.ts` proxy-socket volume; `config.ts` already notes
  prod must move it to "TCP listen mode + Service"). So that migration is required for any
  gVisor/GKE deploy regardless of this feature.

### Verdict

| | runc / no-gVisor | gVisor (prod default) |
|---|---|---|
| **Mongo** | ✅ | ✅ |
| **Redpanda** | ✅ | ❌ (control-proven gVisor-specific) |
| **JVM Kafka (KRaft)** | ✅ | ✅ |

## The design fork

- **gVisor ON → use JVM Kafka, not Redpanda.** Heavier (more memory, slower cold-start, which
  compounds the sequential-sidecar startup), but **keeps the untrusted runner under gVisor.**
- **Redpanda → gVisor OFF for the whole pod.** You can't mix runtimes per-container, so turning
  gVisor off for Redpanda turns it off for the **untrusted runner in the same pod too** — a real
  isolation regression, not a free choice.

**Recommendation: gVisor ON + Mongo + JVM Kafka.** Pay the memory/cold-start cost to keep the
runner sandboxed. Redpanda is only on the table if a future service-pod topology (Option B-style)
lets the broker run in a *separate* pod that can drop gVisor without exposing the runner.

## What building Option A entails (it is not small)

1. **A neutral `services` capability on the shared open-session contract**
   (`packages/sandbox-protocol/src/schemas.ts` `OpenSessionInputSchema`). Per invariant #1 it must
   stay transport/storage-agnostic: a service descriptor of `{name, image, ports, env, healthcheck,
   writablePaths}` — **no** `pod`/`container`/`securityContext`/`runtimeClassName` vocabulary.
2. **Both backends honor it in the same PR** (invariant #3, no half-wired): k8s → native sidecars;
   subprocess/local → `docker compose` or processes (local dev already has Docker).
3. **`pod-spec.ts` renders native sidecars** + per-service writable emptyDir mounts + per-service
   securityContext + pod `fsGroup`.
4. **Per-service resourcing knobs** (today `cpuLimit`/`memoryLimit` size only the runner) and a
   **readiness-budget bump** — the 60s `readinessTimeoutMs` (`config.ts`) is too tight for a JVM
   broker cold-start + image pull, especially on a fresh gVisor node.
5. **credential-proxy → TCP + Service** (required for GKE Sandbox anyway).
6. **security-checklist pass:** third-party images now run adjacent to the runner — pin by digest;
   they inherit the pod's egress lock (can't phone home), which is a *plus*.
7. **Translate the team's `docker-compose.yml` as curated input**, not auto-import (compose carries
   host mounts, `privileged`, etc. that must not cross into the trusted pod).

## Open questions for the team

- **Real Kafka vs Redpanda:** gVisor forces JVM Kafka. Acceptable, or is Redpanda-specific behavior
  needed (which would force the gVisor-off / Option-B path)?
- **Service isolation grain:** per-session (clean state, default) vs. shared-per-user/team (cheaper,
  reintroduces test-isolation problems).
- **Image governance:** who pins/allowlists the service images.

## Next step (if approved)

Run `writing-plans` to decompose Option A into PR-sized slices, starting with the neutral `services`
capability + k8s native-sidecar rendering, gated behind the credential-proxy TCP migration.
