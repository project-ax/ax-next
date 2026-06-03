import { z } from 'zod';

// ---------------------------------------------------------------------------
// ServiceDescriptor — the neutral, transport/storage-agnostic description of a
// dev SERVICE a unit of work wants alongside its sandbox (a database, a cache,
// a vector store, …). It is the canonical capability shape: defined ONCE here
// in the dependency-free @ax/skills-parser parser package, then re-validated at
// the wire boundary in @ax/sandbox-protocol and round-tripped through the
// @ax/connectors store — exactly the way `McpServerSpec` is the interface here
// and `McpServerSchema` is re-declared in @ax/sandbox-protocol (I2/I12: both
// packages are eslint-allow-listed pure schema packages, no cross-plugin
// runtime coupling).
//
// I1/I2 — the descriptor is BACKEND-agnostic. It names WHAT the service is
// (image, ports, env, healthcheck, writable scratch paths), never HOW a backend
// schedules it. No `pod` / `container` / `securityContext` / `runtimeClassName`
// / `volume` / `emptyDir` / `initContainers` / `restartPolicy` vocabulary leaks
// across this boundary. `.strict()` makes that structural: any extra key —
// including a smuggled k8s field — fails the parse. (@ax/validator-service
// re-asserts the forbidden-vocab rejection with a named reason, defense in
// depth.)
//
// I8 — `image` MUST be digest-pinned (`…@sha256:<64 hex>`). A floating tag
// (`postgres:16`) is mutable: the bytes behind it can change under us, which is
// both a reproducibility hole and a supply-chain hole. We pin to the immutable
// content digest and re-validate it at every hop.
// ---------------------------------------------------------------------------

/** Service name shape — lowercase, digit/hyphen, ≤64 chars. Doubles as the
 *  container name a backend derives, and the diagnostics label. */
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Digest-pinned image reference: any repository ref ending in `@sha256:<64 hex>`
 *  (I8). Floating tags are rejected — the digest is the immutable identity. */
const DIGEST_PINNED_IMAGE_RE = /.+@sha256:[0-9a-f]{64}$/;

// Caps — bounded so an oversize descriptor can't become a resource/abuse vector
// at any hop (the same posture as the MCP env caps in @ax/sandbox-protocol).
const ENV_MAX = 32;
const ENV_KEY_LEN_MAX = 256;
const ENV_VAL_LEN_MAX = 2048;
const PORTS_MAX = 16;
const WRITABLE_PATHS_MAX = 16;
const HEALTHCHECK_CMD_MAX = 16;
const PATH_LEN_MAX = 256;
const HEALTHCHECK_ARG_LEN_MAX = 256;

const PortSchema = z.number().int().min(1).max(65535);

/** Healthcheck — a TCP port probe or an in-container exec probe. Discriminated
 *  on `kind` so a backend maps it onto whatever readiness mechanism it has
 *  without the descriptor naming that mechanism. */
export const HealthcheckSchema = z.union([
  z.object({ kind: z.literal('tcp'), port: PortSchema }).strict(),
  z
    .object({
      kind: z.literal('exec'),
      command: z.array(z.string().max(HEALTHCHECK_ARG_LEN_MAX)).min(1).max(HEALTHCHECK_CMD_MAX),
    })
    .strict(),
]);
export type Healthcheck = z.infer<typeof HealthcheckSchema>;

/** The canonical neutral service descriptor. `.strict()` rejects any key not
 *  named here — including smuggled backend vocabulary (I2). */
export const ServiceDescriptorSchema = z
  .object({
    name: z.string().regex(SERVICE_NAME_RE, 'invalid service name shape'),
    image: z
      .string()
      .regex(DIGEST_PINNED_IMAGE_RE, 'image must be digest-pinned (…@sha256:<64 hex>)'),
    ports: z.array(PortSchema).max(PORTS_MAX),
    // env keys/values are length-capped via the record schemas; the entry-count
    // cap (z.record has no `.max`) is enforced by the `.superRefine` so the
    // failure carries a clear, field-pathed issue.
    env: z
      .record(z.string().max(ENV_KEY_LEN_MAX), z.string().max(ENV_VAL_LEN_MAX))
      .superRefine((rec, ctx) => {
        const count = Object.keys(rec).length;
        if (count > ENV_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `env may declare at most ${ENV_MAX} entries, got ${count}`,
          });
        }
      }),
    healthcheck: HealthcheckSchema.optional(),
    // Scratch paths the service may write to (e.g. a data dir). Absolute only —
    // a relative path is meaningless to a backend and a `../` escape vector.
    writablePaths: z
      .array(z.string().regex(/^\//, 'writablePaths entries must be absolute').max(PATH_LEN_MAX))
      .max(WRITABLE_PATHS_MAX)
      .default([]),
  })
  .strict();

export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;

/** Carrier cap — at most this many services per unit of work. */
export const SERVICES_MAX = 8;

/** The `services` array as it rides on a `Capabilities` / `OpenSessionInput`.
 *  Defaults to `[]` so an absent block round-trips as "no services". */
export const ServicesArraySchema = z
  .array(ServiceDescriptorSchema)
  .max(SERVICES_MAX)
  .default([]);
