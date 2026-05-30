# TASK-71 — `@ax/blob-store-s3` backend + MinIO-in-kind + GCS Workload-Identity chart

**Branch:** `auto-ship/TASK-71-blob-store-s3` · **Base:** `main` · **Epic:** out-of-git (design Part A, Phase 6)

## Problem

TASK-65 landed the storage-agnostic `blob:put/get/stat/delete` service hook + the
`@ax/blob-store-fs` backend (single-replica, RWO PVC). This card adds the SECOND
backend — `@ax/blob-store-s3` (S3-compatible: MinIO/GCS/AWS/R2) — behind the SAME
hook surface, plus the dev/prod wiring: a per-deployment fs|s3 selector in the k8s
preset, MinIO running in the kind `ax-next-dev` cluster for dev parity, and a prod
GCS+Workload-Identity path with no static keys committed. This is the real second
impl that justifies the `blob:*` abstraction (invariant I1).

## Invariants honored

- **I1 (storage-agnostic hooks):** payloads stay `{bytes}` / `{sha256}` → `{sha256,size}`
  / `{bytes}|{found:false}` / `{size}|{found:false}` / `{}`. NO `bucket`/`endpoint`/
  `region`/`s3`/`gcs`/`oid` leaks into any payload — all backend config lives in the
  plugin's `createBlobStoreS3Plugin(config)`.
- **I2 (no cross-plugin imports):** the s3 plugin imports only `@ax/core`, `zod`,
  `@aws-sdk/client-s3`. It re-declares (does NOT import) the `Blob*Output` types +
  schemas — structurally identical to fs (the two-backend pattern).
- **I3 (no half-wired):** the preset selects fs OR s3 from `AX_BLOB_BACKEND`; the
  package canary boots through `bootstrap` + round-trips `blob:put → blob:get`.
- **I5 (capabilities minimized):** the s3 client reaches exactly one bucket at one
  endpoint; creds come from the SDK default provider chain (Workload Identity) or
  explicit config (MinIO dev keys from a Secret). No static keys in the tree.

## Tasks

### Task 1 — Scaffold `@ax/blob-store-s3` package (no s3 client yet)
- `packages/blob-store-s3/{package.json,tsconfig.json,vitest.config.ts}` mirroring
  blob-store-fs, plus root `tsconfig.json` reference.
- `package.json` deps: `@ax/core` (workspace:*), `zod`, `@aws-sdk/client-s3` (EXACT pin).
- **Test:** none yet (scaffold) — verified by `pnpm -F @ax/blob-store-s3 build` after Task 2/3.
- Load-bearing: yes.

### Task 2 — `S3BlobStore` content-addressed store class (TDD)
- `src/store.ts`: `S3BlobStore` wrapping an injected `S3Client` + bucket + optional
  keyPrefix. `put`/`get`/`stat`/`delete` mirror fs semantics: sha256 content key
  `<prefix><sha[0:2]>/<sha[2:4]>/<sha>`, idempotent put (HeadObject fast-path),
  digest re-verify on get (throw `corrupt`), HeadObject stat, idempotent delete
  (swallow 404/NotFound), SHA256_REGEX gate before any key build.
- **Tests** (`src/__tests__/store.test.ts`): use `aws-sdk-client-mock` OR an in-memory
  fake `S3Client.send`. Cover: put returns sha+size; round-trip exact bytes; idempotent
  put (HeadObject hit → no PutObject); empty blob; get missing → `{found:false}`;
  get tampered → throws `corrupt`; get/stat/delete reject invalid/traversal/NUL/uppercase
  sha; stat size; delete removes + idempotent on missing.
- Decide mock strategy in Task 2: prefer a hand-rolled in-memory fake (no new dev dep)
  unless `aws-sdk-client-mock` is materially cleaner; log the choice.
- Load-bearing: yes (core logic).

### Task 3 — `@ax/blob-store-s3` plugin + index (TDD)
- `src/plugin.ts`: `createBlobStoreS3Plugin(config)` builds the `S3Client` from config
  (`endpoint`, `region`, `bucket`, `forcePathStyle`, optional `accessKeyId`/`secretAccessKey`,
  optional `keyPrefix`), registers the four `blob:*` hooks with the re-declared
  `Blob*OutputSchema` returns. Manifest `registers: ['blob:put','blob:get','blob:stat','blob:delete']`.
- `src/index.ts`: export factory + config type + Blob* types + schemas + `S3BlobStore`.
- **Tests** (`src/__tests__/plugin.test.ts`): mirror fs plugin.test (registers 4 hooks,
  manifest shape, put/get/stat/delete via the bus with a fake client) +
  `return-schemas.test.ts` (drift guard) + `canary.test.ts` (bootstrap + round-trip
  through the bus with a fake client).
- Load-bearing: yes.

### Task 4 — SECURITY.md for the s3 plugin
- Three-threat-model walk (security-checklist): sandbox/capability (one bucket/endpoint,
  key is content-hash gated, creds via provider chain), prompt injection (opaque bytes,
  digest re-verify on read), supply chain (the ONE new dep @aws-sdk/client-s3, exact-pinned,
  `pnpm audit` clean; Workload Identity = no static keys).
- Load-bearing: yes (card requires the security note + repo convention; fs has one).

### Task 5 — Wire fs|s3 selection into the k8s preset (TDD)
- `presets/k8s/src/index.ts`: add `blob` to `K8sPresetConfig` (discriminated
  `{backend:'fs', root} | {backend:'s3', endpoint, region, bucket, forcePathStyle, accessKeyId?, secretAccessKey?, keyPrefix?}`).
  `createK8sPlugins` pushes exactly one of the two factories. Add `blobConfigFromEnv`
  reading `AX_BLOB_BACKEND` (default `fs`) + the per-backend env vars; fold into
  `loadK8sConfigFromEnv`. Throw loudly on missing required s3 vars; never echo secrets
  in errors.
- **Tests** (`presets/k8s/src/__tests__/preset.test.ts` or a new `blob-config.test.ts`):
  default → fs registrar present, s3 absent; `AX_BLOB_BACKEND=s3` + required vars →
  s3 present, fs absent; missing s3 bucket/endpoint throws; error messages don't
  contain the secret-key literal.
- Add eslint allowlist entry only if needed (preset is already on the cross-import allowlist).
- Load-bearing: yes (I3 — the selectable seam).

### Task 6 — MinIO in kind + GCS prod chart wiring (TDD via env-shape + render)
- `deploy/charts/ax-next/values.yaml`: add a `blob:` block (`backend: fs`, plus `fs.*`
  and `s3.*` sub-keys) and a `minio:` block (`enabled: false`, image pin, storage,
  bucket, credentials Secret keys).
- `deploy/charts/ax-next/templates/host/deployment.yaml`: stamp `AX_BLOB_BACKEND` +
  the per-backend env (fs root, or s3 endpoint/region/bucket/forcePathStyle +
  accessKey/secretKey from a Secret when MinIO; NONE for GCS Workload Identity).
- `deploy/charts/ax-next/templates/minio/{deployment,service,secret}.yaml`: gated on
  `minio.enabled`; single-replica emptyDir MinIO + a bucket-create init; Secret holds
  dev access/secret keys (random-generated lookup-stable, never committed).
- `deploy/charts/ax-next/kind-dev-values.yaml`: `minio.enabled: true`, `blob.backend: s3`
  pointed at the in-cluster MinIO Service; dev access keys from the Secret.
- Prod GCS path: documented in values.yaml comments — `blob.backend: s3`,
  `blob.s3.endpoint: https://storage.googleapis.com`, Workload-Identity SA annotation,
  no static keys.
- **Tests** (`deploy/charts/ax-next/__tests__/env-shape.test.ts` additions +/or a new
  `blob-backend.test.ts`): default render stamps `AX_BLOB_BACKEND=fs` + `AX_BLOB_FS_ROOT`;
  `blob.backend=s3` render stamps the s3 env; `minio.enabled=true` renders the MinIO
  Deployment+Service+Secret; kind-dev render selects s3+MinIO; the env-shape orphan/required
  assertions stay green (every new `env.*` read in the preset is stamped, and vice versa).
- Load-bearing: yes (card: MinIO in kind + GCS prod chart).

## YAGNI cuts (NOT doing)

- Presigned direct browser↔bucket transfer — design marks Optional/later; card says skip.
- A real consumer of `blob:*` (artifact_publish/attachments → blob:put) — that's
  TASK-68's lane (a sibling card already in flight). This card's reachability proof is
  the package canary + the preset selection, not a chat-path consumer.
- Multi-bucket / lifecycle / GC policy on the bucket — caller's responsibility per the
  fs SECURITY note; not this substrate.
- Bitnami MinIO subchart — a hand-rolled dev Deployment is lighter and avoids the
  flaky Bitnami index.

## Phase-3 gates
- security-checklist (Task 4) — new dep + network reach + plugin loading.
- ax-conventions boundary review — NO new hook (reuses TASK-65's `blob:*`), so the
  boundary review is "no hook-surface change; second registrar of an existing surface."
