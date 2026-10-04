import { z } from 'zod';

// ---------------------------------------------------------------------------
// @ax/sandbox-protocol — shared wire contract for `sandbox:open-session`.
//
// A pure schema package (zod only, no @ax/core). It is the single source of
// truth for the `sandbox:open-session` payload shapes that were structurally
// duplicated — and had begun to drift in validation strictness — across
// @ax/sandbox-k8s, @ax/sandbox-subprocess, and @ax/chat-orchestrator.
//
// Both sandbox backends import these schemas and `safeParse` the raw hook
// input at their trust boundary (each backend keeps its own PluginError
// wrapping — that's per-plugin error policy, not contract). The orchestrator
// imports the inferred TYPES to construct the payload it sends. Because every
// consumer now references one definition, a `.max`/`.regex`/`.refine` change
// is made in one place and can't silently diverge between backends.
//
// This package is on the eslint no-restricted-imports allow-list, same class
// as @ax/ipc-protocol and @ax/workspace-protocol: a pure wire-schema package
// is the sanctioned way to share a contract without a cross-plugin runtime
// coupling (invariant I2).
//
// Field naming stays backend-agnostic (invariant I1): `endpoint` (TCP) and
// `unixSocketPath` are the two transport-neutral proxy reach forms; no
// k8s/subprocess-specific vocabulary leaks across this boundary.
// ---------------------------------------------------------------------------

/** Skill / MCP-server id shape — lowercase, digit/hyphen, ≤64 chars. */
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Owner triple's agentConfig — forwarded into `session:create` so the v2
// session row is written atomically. The session-postgres / session-inmemory
// plugins declare the same shape; the orchestrator constructs it.
export const AgentConfigSchema = z.object({
  displayName: z.string(),
  systemPromptAugment: z.string(),
  /** Bootstrap-safe subset of `system-prompt:augment` contributions (currently
   * only the person's own Rules) that the runner prepends in bootstrap mode.
   * Optional: absent means '' (no bootstrap augment) — session rows persisted
   * before this field existed don't carry it. Flows into the LLM prompt like
   * `systemPromptAugment`; never interpolate into shell/paths/HTML. */
  systemPromptBootstrapAugment: z.string().optional(),
  allowedTools: z.array(z.string()),
  /** Canonical AX tool names (e.g. `Bash`, `web_search`, `mcp.<id>.<tool>`)
   * the agent's tool policy DENIES (verdict or ceiling). Catalog hygiene only:
   * the runner hides these so the model is not offered tools it will be
   * refused — enforcement stays host-side on `tool:pre-call`. Optional: absent
   * means no extra denies (session rows persisted before this field existed
   * don't carry it). Independent of `allowedTools` (empty = unrestricted). */
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
  /** Runner id (e.g. `'claude-sdk'`) the host resolves to a binary path via
   * `ChatOrchestratorConfig.runnerBinaries`. `z.string()`, not a zod enum: the
   * wire is a transport boundary and the authoritative allow-list
   * (`SUPPORTED_RUNNERS`) lives in `@ax/agents` — a second enum here would
   * need editing again in PR 3 for no safety gain. */
  runner: z.string(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// A single MCP server spec (http only — stdio was removed 2026-10-04, see
// docs/plans/2026-10-04-drop-stdio-mcp-design.md). This is the trust-boundary
// re-validation: the host built it, the sandbox re-checks it so a drifted or
// compromised host cannot smuggle a malformed spec into the runner's `.mcp.json`.
const McpServerObject = z.object({
  name: z.string().regex(ID_RE),
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/), z.string().regex(/^(Bearer )?ax-cred:[a-f0-9]{32}$/))
    .refine((headers) => Object.keys(headers).length <= 5, 'At most five credential headers')
    .refine((headers) => {
      const names = Object.keys(headers).map(name => name.toLowerCase());
      return new Set(names).size === names.length && names.every(name => !['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'upgrade', 'trailer', 'te', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(name));
    }, 'Headers must be unique and must not override the transport').optional(),
  allowedHosts: z.array(z.string()).default([]),
  credentials: z
    .array(z.object({ slot: z.string(), kind: z.literal('api-key') }))
    .default([]),
});

// The removed stdio-only fields must not ride along on an http entry: a host
// that still sends them is drifted, and the runner must never see them.
export const McpServerSchema = z.preprocess((raw, ctx) => {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['command', 'args', 'env'] as const) {
      if (key in raw) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `mcpServers entry must not set '${key}' (stdio MCP servers are not supported)`,
        });
      }
    }
  }
  return raw;
}, McpServerObject);
export type McpServerSpec = z.infer<typeof McpServerObject>;

// JIT Phase 1a — a skill bundle is a FILE TREE, not a single SKILL.md string.
// `files` carries SKILL.md (the root file at THIS hop — it's a legitimate
// bundle file here, reconstructed by the orchestrator from the manifest
// columns) plus zero-or-more extra files (scripts, data, templates). The
// per-path charset/traversal rules are re-validated at the wire (trust
// boundary re-validation, the validateMcpEntry pattern) so a drifted or
// compromised host can't smuggle a path-traversal or an absolute path into
// the sandbox; the runner materializers re-validate AGAIN at extract time.
//
// Caps: ≤24 files (16 extra + SKILL.md + headroom; the 16-extra cap is the
// upstream @ax/skills rule), 256-char paths, 256 KiB per file. A SKILL.md
// file is required — it's the root the SDK discovers.
// Extra-file charset: relative, lowercase, dot/dash/underscore only, no `..`.
// `SKILL.md` is the ONE allowed uppercase exception (the bundle root, matched
// literally) — every other path must satisfy this.
const SKILL_FILE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
// Reserved names vetoed BOTH as an exact path and as a directory prefix.
// `.mcp.json` is generated from mcpServers; `.claude`/`.git` are SDK/git
// auto-config. (`SKILL.md` is NOT here — it's the bundle root, legitimately
// present at this hop. The upstream @ax/skills layer reserves SKILL.md as an
// EXTRA-file name; here it's required.)
const RESERVED_WIRE_NAMES = ['.mcp.json', '.claude', '.git'];
const isReservedWirePath = (p: string): boolean =>
  RESERVED_WIRE_NAMES.some((r) => p === r || p.startsWith(r + '/'));
const isValidSkillFilePath = (p: string): boolean =>
  !p.includes('..') &&
  !p.startsWith('/') &&
  // Reject `.` / `..` path SEGMENTS — the charset allows a bare `.`, but
  // path.join normalizes it (`.` → the dir itself; `a/./b` → `a/b`).
  !p.split('/').some((seg) => seg === '.' || seg === '..') &&
  // Veto reserved/generated/SDK-config paths so a direct (non-@ax/skills)
  // sandbox caller can't smuggle one through — the extractors re-check too.
  !isReservedWirePath(p) &&
  (p === 'SKILL.md' || SKILL_FILE_PATH_RE.test(p));

export const InstalledSkillSchema = z.object({
  id: z.string().regex(ID_RE, 'invalid skill id shape'),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(256)
          .refine(isValidSkillFilePath, 'invalid file path (traversal/absolute/charset)'),
        contents: z.string().min(0).max(256 * 1024),
      }),
    )
    .min(1)
    .max(24)
    .refine((fs) => fs.some((f) => f.path === 'SKILL.md'), 'files must include SKILL.md'),
  mcpServers: z.array(McpServerSchema).max(8).default([]),
  // TASK-14 (CLI-1 part 2) — the skill's top-level allowedHosts + credential
  // slots, forwarded so the runner can wire skill-declared credentials into
  // `git`'s HTTP Basic auth (a host-scoped `url.<base>.insteadOf` rewrite
  // carrying the `ax-cred:<hex>` placeholder). Trust-boundary re-validation:
  // the host orchestrator built these from the parsed manifest, but the
  // sandbox re-checks at the wire. Default `[]` for back-compat with
  // pre-TASK-14 callers (tests, ad-hoc CLI) that don't set them.
  allowedHosts: z.array(z.string().max(256)).max(64).default([]),
  // TASK-86 — `slot` is the BARE env-var name; the optional `placeholder` is the
  // skill's OWN `ax-cred:<hex>` token, so per-skill git HTTP-Basic wiring uses
  // the skill's own credential even when another skill won the flat-env stamp for
  // the same bare slot name. Re-validated to the placeholder shape at the wire so
  // a regressed host can never smuggle a real secret here (only the opaque token
  // is ever embedded into a git URL). Optional + back-compat: pre-TASK-86 callers
  // omit it and git wiring falls back to `envMap[slot]`.
  credentials: z
    .array(
      z.object({
        slot: z.string().max(64),
        kind: z.literal('api-key'),
        placeholder: z
          .string()
          .regex(/^ax-cred:[0-9a-f]{32}$/)
          .optional(),
      }),
    )
    .max(32)
    .default([]),
});
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;

// ---------------------------------------------------------------------------
// ServiceDescriptor (TASK-150) — a dev SERVICE the unit of work wants alongside
// its sandbox (a database, a cache, …). The CANONICAL shape lives in
// @ax/skills-parser (`ServiceDescriptorSchema`, on the `Capabilities` shape the
// connector store owns). Re-declared LOCALLY here for trust-boundary
// re-validation at the wire — the SAME defense-in-depth as McpServerSchema
// above: the host orchestrator built the descriptor from a connector's parsed
// capabilities, but a drifted/compromised host must not be able to smuggle a
// malformed (or backend-vocabulary-laden) service spec through to a sandbox
// backend. Both packages are eslint-allow-listed pure schema packages (I12); a
// drift between the two surfaces as a runtime parse failure here.
//
// I1/I2 — backend-agnostic. `.strict()` rejects any key not named here,
// including a smuggled `pod`/`securityContext`/`runtimeClassName`/`volume`/… —
// no scheduler vocabulary crosses this boundary. I8 — `image` MUST be
// digest-pinned (`…@sha256:<64 hex>`); a floating tag is mutable and is both a
// reproducibility and a supply-chain hole.
const SERVICE_PORT = z.number().int().min(1).max(65535);

const HealthcheckSchema = z.union([
  z.object({ kind: z.literal('tcp'), port: SERVICE_PORT }).strict(),
  z
    .object({
      kind: z.literal('exec'),
      command: z.array(z.string().max(256)).min(1).max(16),
    })
    .strict(),
]);

export const ServiceDescriptorSchema = z
  .object({
    name: z.string().regex(ID_RE, 'invalid service name shape'),
    image: z
      .string()
      .regex(/.+@sha256:[0-9a-f]{64}$/, 'image must be digest-pinned (…@sha256:<64 hex>)'),
    ports: z.array(SERVICE_PORT).max(16),
    env: z
      .record(z.string().max(256), z.string().max(2048))
      .superRefine((rec, ctx) => {
        const count = Object.keys(rec).length;
        if (count > 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `env may declare at most 32 entries, got ${count}`,
          });
        }
      }),
    healthcheck: HealthcheckSchema.optional(),
    writablePaths: z
      .array(z.string().regex(/^\//, 'writablePaths entries must be absolute').max(256))
      .max(16)
      .default([]),
  })
  .strict();
export type ServiceDescriptorParsed = z.infer<typeof ServiceDescriptorSchema>;

// Per-session credential-proxy blob threaded from the orchestrator. The
// orchestrator's `endpointToProxyConfig` guarantees exactly one of
// `endpoint` / `unixSocketPath` at construction; this schema documents AND
// enforces that invariant. (The former k8s variant accepted neither/both;
// converging up to the strict form tightens the k8s boundary.)
export const ProxyConfigSchema = z
  .object({
    /** TCP endpoint (e.g. subprocess loopback), e.g. 'http://127.0.0.1:54321'. */
    endpoint: z.string().min(1).optional(),
    /** Unix socket path (e.g. k8s), e.g. '/var/run/ax/proxy.sock'. */
    unixSocketPath: z.string().min(1).optional(),
    /** MITM CA certificate PEM bytes. The sandbox owns where on disk to write it. */
    caCertPem: z.string().min(1),
    /** env-var name → `ax-cred:<hex>` placeholder map the proxy recognizes. */
    envMap: z.record(z.string(), z.string()),
    /**
     * Per-session proxy token (TASK-52; Proxy-Authorization Basic). REQUIRED
     * since TASK-784, and backend-agnostic (I1) — an opaque secret, no
     * transport/storage vocabulary. The sandbox bootstrap embeds it into the
     * proxy URL userinfo so every egress client sends it automatically. Since
     * TASK-158 it is the credential the proxy AUTHENTICATES the caller with: a
     * request without it is refused, and the request is gated on the allowlist
     * of the session it belongs to. The runner refuses to boot without one
     * (TASK-704), so a config that omits it is rejected here — host-side,
     * before a sandbox is spawned — rather than surfacing as a runner exit 2.
     * Stub proxies (test harness) mint a dummy 32-hex token.
     */
    proxyAuthToken: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .refine((v) => (v.endpoint !== undefined) !== (v.unixSocketPath !== undefined), {
    message: 'proxyConfig must set exactly one of endpoint or unixSocketPath',
  });
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// The full `sandbox:open-session` input envelope. Both backends `safeParse`
// this at their boundary. `owner`, `proxyConfig`, and `installedSkills` are
// optional for back-compat with non-orchestrator paths (tests, ad-hoc CLI).
export const OpenSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  workspaceRoot: z.string().regex(/^\//, 'workspaceRoot must be absolute'),
  runnerBinary: z.string().regex(/^\//, 'runnerBinary must be absolute'),
  owner: z
    .object({
      userId: z.string().min(1),
      agentId: z.string().min(1),
      agentConfig: AgentConfigSchema,
      // Ties this session to a persisted conversation row so the runner's
      // bind-on-resume path can choose resume vs fresh-spawn from
      // session:get-config alone. Forwarded verbatim into session:create.
      conversationId: z.string().min(1).optional(),
      // TASK-181 — origin of the session, derived HOST-SIDE from who opened
      // it: `'routine'` for a scheduled @ax/routines fire, `'user'`/absent for
      // an interactive turn. Forwarded into session:create so the session
      // record carries it and the IPC server can stamp it onto the happy-path
      // runner-completed chat:end ctx (@ax/memory reads it there to store a
      // routine turn's rows with no conversation — TASK-616). SECURITY: this
      // rides the
      // HOST-INTERNAL `sandbox:open-session` hook (orchestrator → sandbox
      // plugin → session:create), NEVER the runner wire (@ax/ipc-protocol). An
      // untrusted runner has no way to set it — it is sourced only from
      // ctx.source on the host. Do NOT move this onto the runner-facing IPC
      // protocol.
      source: z.enum(['routine', 'user']).optional(),
    })
    .optional(),
  proxyConfig: ProxyConfigSchema.optional(),
  installedSkills: z.array(InstalledSkillSchema).max(50).optional(),
  // TASK-150 — dev SERVICES the orchestrator folded from the agent's connector
  // capabilities. Optional + back-compat with non-orchestrator callers (tests,
  // ad-hoc CLI) that don't set it. Each entry is re-validated at the wire
  // (digest-pin, caps, no smuggled backend vocab). Carrier capped at 8.
  services: z.array(ServiceDescriptorSchema).max(8).optional(),
});

export type OpenSessionInput = z.input<typeof OpenSessionInputSchema>;
export type OpenSessionParsed = z.infer<typeof OpenSessionInputSchema>;

// ---------------------------------------------------------------------------
// `sandbox:open-session` RETURN contract (ARCH-6).
//
// The hook result is `{ runnerEndpoint: string; handle: OpenSessionHandle }`,
// where `handle` is a LIVE object carrying functions + a Promise
// (`kill(): Promise<void>`, `exited: Promise<ExitInfo>`) — the orchestrator's
// session-lifecycle capability. The HookBus's `returns` validation strips
// undeclared keys by default (see @ax/core hook-bus.ts), so a strict object
// schema would SILENTLY DELETE `handle` and break teardown. We therefore use
// `.passthrough()`: the schema asserts only the one storage-/transport-
// agnostic serializable field that crosses the I1 boundary
// (`runnerEndpoint`, an opaque URI) while letting the live handle ride
// through untouched.
//
// Both sandbox backends register their own `OpenSessionResult` interface (each
// declares its own `handle` shape) but share this return assertion — the
// shape that matters at the bus boundary is identical, and the handle is
// deliberately NOT modeled (a capability object is not a data contract).
// ---------------------------------------------------------------------------
export const OpenSessionResultSchema = z
  .object({
    runnerEndpoint: z.string().min(1),
  })
  .passthrough();
