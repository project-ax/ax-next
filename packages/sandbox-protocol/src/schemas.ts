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

// TASK-18 — env caps, identical to the runner's `validateMcpEntry`
// (MCP_ENV_MAX / MCP_ENV_LEN_MAX in @ax/agent-claude-sdk-runner's
// installed-skills.ts) AND to the upstream manifest parser
// (@ax/skills-parser's manifest.ts). The env map of an stdio MCP server flows
// into the spawned process's environment, so an unbounded record is a
// resource/abuse vector. Capping here lets the HOST reject oversize env at the
// wire boundary instead of leaning on the runner (the last gate) to catch it.
const MCP_ENV_MAX = 32;
const MCP_ENV_LEN_MAX = 256;

// Owner triple's agentConfig — forwarded into `session:create` so the v2
// session row is written atomically. The session-postgres / session-inmemory
// plugins declare the same shape; the orchestrator constructs it.
export const AgentConfigSchema = z.object({
  displayName: z.string(),
  systemPromptAugment: z.string(),
  allowedTools: z.array(z.string()),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// A single bundled MCP server spec declared by a skill's manifest
// (capabilities.mcpServers). This is the trust-boundary re-validation: the
// host orchestrator built it from the parsed manifest, but the sandbox
// re-checks it at the wire because a drifted/compromised host must not be
// able to smuggle a malformed spec into the runner's `.mcp.json`.
export const McpServerSchema = z
  .object({
    name: z.string().regex(ID_RE),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string().max(256)).max(32).optional(),
    // env keys + values are length-capped via the record's key/value schemas;
    // the entry-count cap (z.record has no `.max`) is enforced by the
    // `.superRefine` below so the failure carries a clear, field-pathed issue.
    env: z
      .record(z.string().max(MCP_ENV_LEN_MAX), z.string().max(MCP_ENV_LEN_MAX))
      .superRefine((rec, ctx) => {
        const count = Object.keys(rec).length;
        if (count > MCP_ENV_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `env may declare at most ${MCP_ENV_MAX} entries, got ${count}`,
          });
        }
      })
      .optional(),
    url: z.string().url().optional(),
    allowedHosts: z.array(z.string()).default([]),
    credentials: z
      .array(z.object({ slot: z.string(), kind: z.literal('api-key') }))
      .default([]),
  })
  // Transport-specific field invariants: stdio entries carry a non-empty
  // command and no url; http entries carry a url and none of the stdio-only
  // fields. Without this the schema accepts cross-contaminated shapes (e.g.
  // transport=stdio with a url) that the manifest parser already rejects
  // upstream — re-validating here keeps a drifted host from smuggling one
  // through to the runner's `.mcp.json`.
  .refine(
    (v) => {
      if (v.transport === 'stdio') {
        return (
          typeof v.command === 'string' &&
          v.command.length > 0 &&
          v.url === undefined
        );
      }
      // transport === 'http'
      return (
        typeof v.url === 'string' &&
        v.command === undefined &&
        v.args === undefined &&
        v.env === undefined
      );
    },
    {
      message:
        'mcpServers entry must match its transport: stdio requires command (no url); http requires url (no command/args/env)',
    },
  );
export type McpServerSpec = z.infer<typeof McpServerSchema>;

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
     * Per-session proxy token for egress attribution (TASK-52;
     * Proxy-Authorization Basic). Optional + backend-agnostic (I1) — an
     * opaque secret, no transport/storage vocabulary. The sandbox bootstrap
     * embeds it into the proxy URL userinfo so every egress client sends it
     * automatically. It is an attribution label, never an authz input.
     */
    proxyAuthToken: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
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
    })
    .optional(),
  proxyConfig: ProxyConfigSchema.optional(),
  installedSkills: z.array(InstalledSkillSchema).max(50).optional(),
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
