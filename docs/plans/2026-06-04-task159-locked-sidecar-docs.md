# TASK-159 — Locked-sidecar dev-service docs + starter examples (technique, not a catalog)

**Branch:** `auto-ship/TASK-159-locked-sidecar-docs` · **Base:** `main`

## Problem

The `services` capability (TASK-150…157) lets an approved connector declare dev services
(a DB, a broker) that run as **native sidecars** alongside the runner pod. The runner pod
is locked: `readOnlyRootFilesystem: true`, `runAsNonRoot`, caps drop ALL, `fsGroup 1000`.
A sidecar inherits that posture, so it must declare a `writablePath` for **every** directory
the image writes — or it crashes at startup with an opaque EROFS / permission error.

This is non-obvious and trips authors. The fix isn't a curated image registry (a maintenance
treadmill that teaches nothing transferable, and authors bring their own services via the
TASK-154 compose translator anyway) — it's **documenting the technique** + a couple of
**proven starter examples**, and pointing at the **admin approval wall** as the per-org
curation point.

## Approach (chosen)

1. **Technique docs** in the two existing SECURITY.md homes (project voice):
   - `deploy/charts/ax-next/SECURITY.md` — operator-facing: extend the existing
     "Dev-services require Kubernetes 1.29+" section with a **"Writable paths: the
     locked-sidecar technique"** subsection + the **org-curation/approval-wall** callout.
   - `packages/sandbox-k8s/SECURITY.md` — the in-pod sidecar posture already lives here
     (cross-ref at chart SECURITY.md:229-231); add the full technique + gotchas + the
     JVM-Kafka cautionary tale + the starter examples table here.
2. **Starter-examples constant** `STARTER_SERVICE_EXAMPLES` in
   `packages/channel-web/src/lib/connector-form.ts`, surfaced in `ServicesSection`
   (ConnectorEditDialog) as an "Examples" affordance (one click fills a row) so it's
   reachable from the connector services-declaration surface AND not half-wired.
3. **No backend/descriptor code change** (the schema is image-agnostic and already shipped).

## Tasks (independent, testable)

### Task 1 — `STARTER_SERVICE_EXAMPLES` constant + tests (load-bearing)
`packages/channel-web/src/lib/connector-form.ts`: export a small typed array of
`{ label, description, service: ServiceDescriptor }` framed in a comment as "examples,
not an exhaustive list." Entries:
- **MongoDB** — `docker.io/library/mongo@sha256:4b5bf3c2bb7516164f6dcb44acce4fdcb428abfe5771a1128304a0f34ab9ff7c`, writablePaths `[/data/db, /tmp]`, port 27017.
- **Kafka (GraalVM native)** — `docker.io/apache/kafka-native@sha256:c20b97f0a3990771f52bf7855ccb9ae82ac683a357a101482ba349dfb2ae0cdb`, writablePaths `[/var/lib/kafka/data, /tmp, /opt/kafka/config, /opt/kafka/logs, /mnt/shared/config]`, port 9092.
- **Postgres** + **Redis** — trivially-derivable extras (digest-pinned), clearly framed as examples.

Test (`connector-form.test.ts`): every example's `image` is digest-pinned (matches the
descriptor regex), every `writablePaths` entry is absolute, and the Mongo/Kafka-native
refs + writablePaths match the proven values exactly.

### Task 2 — Surface examples in `ServicesSection` (load-bearing — avoids half-wired)
`ConnectorEditDialog.tsx`: add an "Examples (not an exhaustive list)" row of shadcn
`Button variant="outline" size="sm"` chips; clicking one appends that example's descriptor
as a service row. Compose existing primitives only (invariant #6). No new shadcn primitive
needed (Button already installed).

### Task 3 — Technique docs (project voice)
- `packages/sandbox-k8s/SECURITY.md`: new section **"Dev-service sidecars: declare every
  writable path"** — the locked posture a sidecar inherits, how to find the paths (run it,
  watch for EROFS/permission failures, add the path; TASK-160 will self-diagnose), the
  common gotchas (`/tmp` unix sockets, PID/lock files, cache dirs, JVM-CDS / install-dir
  writes → prefer rootless/native builds), the proven starter examples table, and the
  JVM-`apache/kafka` cautionary tale (CDS `.jsa` write into `/opt/kafka` on a read-only
  rootfs → use `apache/kafka-native`).
- `deploy/charts/ax-next/SECURITY.md`: extend the dev-services section with a short
  operator-facing **"Writable paths: the locked-sidecar technique"** pointer to the package
  note + the **org-curation** callout (the admin approval wall is where each org curates its
  own blessed image set — we ship mechanism + technique + starters, not a central registry).

## YAGNI pass
- Task 1 const: load-bearing (the deliverable). ✅
- Task 2 UI wiring: load-bearing — without it the const is half-wired dead code (invariant #3). ✅
- Task 3 docs: load-bearing (the deliverable). ✅
- Postgres/Redis extras: trivially derivable, framed as examples — kept minimal, not a catalog.

## Invariants / boundary review
- No new hook, no hook-surface change → no boundary review needed.
- Invariant #6: UI composes existing shadcn primitives + semantic tokens.
- security-checklist **N/A**: docs + a static examples constant; no untrusted input,
  no process/network/sandbox/IPC/plugin-loading change.

## Gate
`pnpm build && pnpm test --filter @ax/channel-web && pnpm lint` (+ chart vitest if touched).
The chart SECURITY.md is docs-only (no template change) so no helm-render needed, but
run `pnpm test --filter ax-next-chart` if the chart package has doc-asserting tests.
