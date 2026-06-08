import type { ServiceHandler } from '@ax/core';
import type { OpenSessionInput } from '@ax/sandbox-protocol';

// ---------------------------------------------------------------------------
// @ax/sandbox-mount-protocol — the sandbox per-agent mount contract
// (filestore-user-files epic, design §4; follows the
// @ax/workspace-bundle-protocol / @ax/sandbox-protocol precedent)
//
// This package holds the HOST-INTERNAL `sandbox:resolve-mounts` service-hook
// contract: the `MountSpec` discriminated union a mount-resolver plugin
// (`@ax/workspace-filestore`, `@ax/workspace-localdir`) emits, and the TS
// signature a sandbox provider (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`)
// realizes into a real pod/process mount. (Those consumers land in a later
// card — this package is contract-only.)
//
// Why it lives HERE and not in @ax/core: the kernel is storage- and
// backend-AGNOSTIC (architecture doc §4.5, invariant I1 — no
// nfs/server/exportPath/hostPath vocabulary). `MountSpec` carries exactly
// that backend vocabulary. Keeping it in @ax/core would make the neutral
// kernel carry NFS/dev-host field names — the very leak I1 forbids.
// Isolating it in this provider-facing protocol package keeps the kernel
// clean: a sandbox provider that doesn't support a durable mount simply
// never imports this package and never lists `sandbox:resolve-mounts` in
// its `optionalCalls`, so it never sees the vocabulary and never pays for
// the abstraction. (Mirrors exactly what ARCH-3 did for the git-vocabulary
// bundle types in @ax/workspace-bundle-protocol.)
//
// Pure TS types, NO zod: this is consumed only as an in-process hook-bus
// generic (`bus.call<In, Out>` / `registerService<In, Out>`), where the TS
// type IS the whole contract. `sandbox:resolve-mounts` is host-internal — it
// is called by the provider during pod construction and NEVER crosses the
// untrusted sandbox edge (it is deliberately NOT an IPC action; design §4),
// so there is no untrusted wire to validate and zod here would be dead
// validation. The owner shape is reused type-only from @ax/sandbox-protocol
// so the resolver's input can't drift from the real session owner; the
// handler alias is built on @ax/core's neutral `ServiceHandler` generic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MountSpec — an OPAQUE, kind-discriminated mount request.
//
// **Consumer contract (load-bearing — read before realizing a mount):**
// A consumer (sandbox provider) MUST branch on `kind` and realize only the
// members it supports; an unknown `kind` is an EXPLICIT error, never a silent
// skip (design §4 / §10). A consumer MUST NOT read a backend-specific field
// (`server`, `exportPath`, `subPath`, `hostPath`) without first narrowing on
// `kind` — those fields exist only on the member that owns them, and keying
// off them across the union (e.g. "does it have a `server`?") couples the
// consumer to one backend and breaks when another `kind` ships. The `kind`
// discriminator is the only safe thing to switch on; everything else is
// backend detail bounded behind it (the same escape hatch @ax/credentials
// uses for its own `kind` union). Adding a future backend (e.g. `gcsFuse`,
// `s3Csi`) is purely a new union member — and the `never`-exhaustiveness
// pattern (see the package test) forces every consumer to handle it.
//
// `mountPath`, `readOnly`, and the optional `role` are the only fields shared
// across every member — the backend-neutral surface a consumer can read
// without narrowing. `role: 'user-files'` tells the provider which mount to
// expose as `AX_USERFILES_ROOT` in the runner env.
// ---------------------------------------------------------------------------

/**
 * An NFS (e.g. Google Cloud Filestore) export, realized by a network-mount
 * provider. The k8s provider realizes this as an inline `nfs:` pod volume
 * (`{ nfs: { server, path: exportPath } }`) plus a `volumeMount` that pins
 * the per-agent `subPath` subtree; the kubelet auto-creates the `subPath`
 * subdir on first use. Cross-tenant isolation is the `subPath` confinement:
 * other agents' subtrees are not even mounted.
 */
export interface NfsMountSpec {
  /** Discriminator — consumers switch on this and NOTHING else. */
  kind: 'nfs';
  /** Where the mount appears inside the sandbox, e.g. `/workspace`. */
  mountPath: string;
  /** NFS server address — Filestore IP or DNS name. */
  server: string;
  /** Export path on the server, e.g. `/vol1/agents`. */
  exportPath: string;
  /** Per-tenant subtree within the export, e.g. the `agentId`. */
  subPath: string;
  /** Mount the export read-only. The runner uses `false`; a future host-read realization uses `true`. */
  readOnly: boolean;
  /** When set, the provider exports this mount's path as `AX_USERFILES_ROOT`. */
  role?: 'user-files';
}

/**
 * A real persistent directory on the host filesystem, realized by a provider
 * that shares the host FS (the subprocess/dev provider). It realizes this by
 * `mkdir -p hostPath` — there is no container mount; the path is simply made
 * to exist. Gives the canary + local dev loop a durable per-agent mount
 * without real NFS.
 */
export interface LocalDirMountSpec {
  /** Discriminator — consumers switch on this and NOTHING else. */
  kind: 'localDir';
  /** Where the mount appears inside the sandbox, e.g. `/workspace`. */
  mountPath: string;
  /** Real persistent directory on the dev host, e.g. `<root>/<agentId>`. */
  hostPath: string;
  /** Mount the directory read-only. The runner uses `false`. */
  readOnly: boolean;
  /** When set, the provider exports this mount's path as `AX_USERFILES_ROOT`. */
  role?: 'user-files';
}

/**
 * A per-agent durable mount request. Opaque discriminated union — see the
 * consumer contract above: branch on `kind`, error on an unknown member,
 * never key off a backend-specific field without narrowing first.
 */
export type MountSpec = NfsMountSpec | LocalDirMountSpec;

// ---------------------------------------------------------------------------
// `sandbox:resolve-mounts` (host-internal service hook)
//
//   sandbox:resolve-mounts (ctx, { owner }) → { mounts: MountSpec[] }
//
// A mount-resolver plugin registers this; a sandbox provider lists it in
// `optionalCalls` and calls it during session open to learn which durable
// per-agent mounts to realize. When no resolver is loaded, the provider
// degrades to the default emptyDir tiers (no durable user-files mount). A
// resolver returns `[]` when it has nothing to contribute (e.g. an anonymous
// CLI session with no `agentId`) — that is a no-mount, not an error.
// ---------------------------------------------------------------------------

/**
 * Input to `sandbox:resolve-mounts`. `owner` is the session owner, reused
 * verbatim from `@ax/sandbox-protocol`'s `OpenSessionInput` so the resolver's
 * input cannot drift from the real session-owner shape (invariant I4 — one
 * source of truth). The resolver keys the per-agent subtree off
 * `owner.agentId`.
 */
export interface ResolveMountsInput {
  owner: NonNullable<OpenSessionInput['owner']>;
}

/**
 * Output of `sandbox:resolve-mounts`: the durable per-agent mounts the
 * provider should realize. May be empty (the resolver has nothing to
 * contribute — a graceful no-mount, never an error).
 */
export interface ResolveMountsOutput {
  mounts: MountSpec[];
}

/**
 * The full `sandbox:resolve-mounts` handler signature — the in-process
 * hook-bus contract a resolver plugin satisfies via
 * `registerService<ResolveMountsInput, ResolveMountsOutput>` and a sandbox
 * provider invokes via `bus.call<ResolveMountsInput, ResolveMountsOutput>`.
 * Built on `@ax/core`'s neutral `ServiceHandler` so the `(ctx, input) =>
 * Promise<output>` shape stays identical to every other service hook.
 */
export type ResolveMountsHandler = ServiceHandler<ResolveMountsInput, ResolveMountsOutput>;
