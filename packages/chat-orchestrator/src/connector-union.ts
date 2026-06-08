import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// connector-union — resolve an agent's effective connector set and fold each
// connector's Capabilities into the session the SAME way skills do (TASK-97,
// connectors-first-class design Phasing step 4).
//
// THE PARALLEL TO SKILLS. The orchestrator already unions skills (attachments +
// defaults + builtins + authored drafts) and materializes their declared reach
// — allowedHosts → the proxy egress allowlist, credential slots → the proxy
// credential map, packages → registry auto-allow, mcpServers → a per-skill
// `.mcp.json` in the sandbox. A connector is the SAME `Capabilities` shape lifted
// out of the skill (design: "Connector = access… the existing SkillCapabilities
// shape, lifted out of the skill"), so it folds through the SAME path.
//
// EFFECTIVE SET. The design's effective set = catalog defaults + manager-added
// per-agent attachments + the owner's private items. ALL THREE are wired here
// (TASK-107 added the third): workspace DEFAULTS (`connectors:list-defaults`),
// the manager-added per-agent ATTACHMENTS (the connector ids the agent row's
// `connector_attachments` store carries, resolved via `connectors:resolve`), and
// the owner's PRIVATE items (`connectors:list` + `connectors:resolve`).
// `resolveEffectiveConnectors` dedupes all three by id. (TASK-97 wired defaults +
// private with the attachment slot left for TASK-107 to fill — which it now does;
// the per-agent attachment store replaced TASK-98's `mcpConfigIds` stopgap.)
//
// NON-FATAL. Connectors are ADDITIVE reach. Every resolve here fails OPEN (log +
// skip): a throwing/absent `connectors:list-defaults` or a per-connector resolve
// failure yields FEWER connectors, never wider reach, and NEVER terminates the
// session (same posture as `skills:list-defaults` / `host-grants:list`).
//
// APPROVAL. Catalog/default/private connectors are admin/owner-CURATED, so their
// caps flow into the sandbox directly — the SAME trust posture as catalog/default
// SKILL caps (which `skills:resolve` / `skills:list-defaults` return ungated). The
// approved-caps wall (TASK-93) gates MODEL-AUTHORED declarations at their resolver
// (like authored skills are gated inside @ax/agents); there is no
// authored-connector resolver yet, so this card folds only curated connectors and
// preserves that pattern.
//
// I2 — no cross-plugin import. The connector hook shapes are duplicated
// structurally here (the orchestrator mirrors EVERY peer hook this way); the
// store-side @ax/connectors types are the source of truth, drift surfaces as a
// runtime shape error at the bus call site.
// ---------------------------------------------------------------------------

import type { HookBus, AgentContext } from '@ax/core';
// I12 — the dev-SERVICE descriptor type is the CANONICAL wire shape from
// @ax/sandbox-protocol (an eslint-allow-listed pure schema package that
// chat-orchestrator already depends on type-only for AgentConfig / ProxyConfig).
// We forward each connector's parsed `services` verbatim onto the
// `sandbox:open-session` payload; the sandbox backends re-validate at the wire.
import type { ServiceDescriptorParsed } from '@ax/sandbox-protocol';

// Structural mirror of @ax/skills-parser's McpServerSpec (I2). The orchestrator
// forwards it verbatim into the sandbox; the sandbox schemas re-validate.
export interface ConnectorMcpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; description?: string; account?: string }>;
}

// Structural mirror of @ax/connectors' `CapabilitySlotSchema` (I2 — no
// cross-plugin import). A connector credential slot is a discriminated union on
// `kind`: the api-key variant (the historical shape) and the OAuth variant added
// for MCP OAuth connectors. The orchestrator's fold reads `kind` (→ the
// credential map's classification kind) + `slot`/`account`; the OAuth-only fields
// (`server`, `scopes`, …) are carried so an oauth slot type-checks through the
// fold, but the fold itself doesn't consume them (the OAuth callback + the
// `credentials:resolve:mcp-oauth` resolver own them store-side). Drift surfaces as
// a runtime shape error at the connectors:resolve bus call site.
export type ConnectorCredentialSlot =
  | { slot: string; kind: 'api-key'; description?: string; account?: string }
  | {
      slot: string;
      kind: 'oauth';
      server: string;
      scopes?: string[];
      clientId?: string;
      clientSecretRef?: string;
      authServerUrl?: string;
      tokenUrl?: string;
      description?: string;
      account?: string;
    };

// Structural mirror of @ax/skills-parser's Capabilities (I2).
export interface ConnectorCapabilities {
  allowedHosts: string[];
  credentials: ConnectorCredentialSlot[];
  mcpServers: ConnectorMcpServerSpec[];
  packages?: { npm?: string[]; pypi?: string[] };
  /**
   * TASK-153 — dev SERVICES the connector wants alongside the sandbox (a
   * database, a cache, …). The CANONICAL `ServiceDescriptorParsed` wire shape
   * (@ax/sandbox-protocol), forwarded verbatim onto `sandbox:open-session`.
   * OPTIONAL: a connector resolve / capabilities literal that predates the
   * field (and the existing connector test fixtures) carries no `services`,
   * which folds as "no services". `@ax/skills-parser`'s `CapabilitiesSchema`
   * `.default([])`s it, so a store round-trip always yields an array.
   */
  services?: ServiceDescriptorParsed[];
}

// Structural mirror of @ax/connectors' ResolveOutput / list-defaults connector
// (I2 — no @ax/connectors import). Only the fields the union folds.
export interface ResolvedConnectorForOrch {
  id: string;
  capabilities: ConnectorCapabilities;
  /** Light "how to use me" blurb — becomes the synthetic SKILL.md body so the
   *  model knows the connector exists and how to drive it. Optional for
   *  back-compat with a resolve impl that predates the field. */
  usageNote?: string;
}

// connectors:list-defaults — registered by @ax/connectors (TASK-97). Returns
// FULL connectors (capabilities included). Structural mirror per I2.
interface ConnectorsListDefaultsOutput {
  connectors: Array<{ id: string; capabilities: ConnectorCapabilities; usageNote?: string }>;
}
// connectors:list — owner's connector summaries (no capabilities). Structural
// mirror per I2.
interface ConnectorsListOutput {
  connectors: Array<{ id: string }>;
}
// connectors:resolve — the mechanism-agnostic spec descriptor. Structural mirror.
interface ConnectorsResolveOutput {
  id: string;
  capabilities: ConnectorCapabilities;
  usageNote?: string;
}

/**
 * Resolve the agent's effective connector set (workspace defaults ∪ the agent's
 * per-agent ATTACHMENTS ∪ the owner's own connectors), deduped by id. All reads
 * are hasService-gated and NON-FATAL — a failure logs + yields fewer connectors,
 * never terminates.
 *
 * Defaults come first so they win the dedupe on an id collision; the attachments
 * and the owner's own connectors of the same id carry the same capabilities (the
 * store keys by (owner, id)), so precedence here only affects which copy is
 * folded, not the resulting reach.
 *
 * `attachmentIds` is the agent row's `connector_attachments` store (TASK-107):
 * the connector ids a manager attached to THIS agent. Resolved via
 * `connectors:resolve` under the chat user, deduped against the defaults. This
 * replaced TASK-98's stopgap that overloaded `mcpConfigIds`; an empty/absent
 * list contributes nothing.
 */
export async function resolveEffectiveConnectors(
  bus: HookBus,
  ctx: AgentContext,
  attachmentIds: readonly string[] = [],
): Promise<ResolvedConnectorForOrch[]> {
  const byId = new Map<string, ResolvedConnectorForOrch>();

  // 1. Workspace DEFAULTS — admin-curated default-on connectors.
  if (bus.hasService('connectors:list-defaults')) {
    try {
      const r = await bus.call<{ userId?: string }, ConnectorsListDefaultsOutput>(
        'connectors:list-defaults',
        ctx,
        { userId: ctx.userId },
      );
      for (const c of r.connectors) {
        if (!byId.has(c.id)) {
          byId.set(c.id, { id: c.id, capabilities: c.capabilities, ...(c.usageNote !== undefined ? { usageNote: c.usageNote } : {}) });
        }
      }
    } catch (err) {
      // Same convention as skills_list_defaults_failed — non-fatal, additive reach.
      ctx.logger.warn('connectors_list_defaults_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. The manager-added per-agent ATTACHMENTS (TASK-107) — the connector ids
  //    this agent's `connector_attachments` store carries. Resolve each id (skip
  //    ones already folded as a default). A per-connector resolve failure skips
  //    that one connector (non-fatal): a dangling/unapproved attachment id grants
  //    NO reach (connectors:resolve reads only the LIVE owner-scoped table).
  if (attachmentIds.length > 0 && bus.hasService('connectors:resolve')) {
    for (const connectorId of attachmentIds) {
      if (byId.has(connectorId)) continue; // already folded as a default
      try {
        const resolved = await bus.call<
          { userId: string; connectorId: string },
          ConnectorsResolveOutput
        >('connectors:resolve', ctx, { userId: ctx.userId, connectorId });
        byId.set(resolved.id, {
          id: resolved.id,
          capabilities: resolved.capabilities,
          ...(resolved.usageNote !== undefined ? { usageNote: resolved.usageNote } : {}),
        });
      } catch (err) {
        ctx.logger.warn('connector_attachment_resolve_failed', {
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 3. The owner's PRIVATE items — every connector they own. `connectors:list`
  //    is metadata-only, so resolve each id for its capabilities. A per-connector
  //    resolve failure skips that one connector (non-fatal), never the session.
  if (bus.hasService('connectors:list') && bus.hasService('connectors:resolve')) {
    try {
      const listed = await bus.call<{ userId: string }, ConnectorsListOutput>(
        'connectors:list',
        ctx,
        { userId: ctx.userId },
      );
      for (const summary of listed.connectors) {
        if (byId.has(summary.id)) continue; // already folded as a default
        try {
          const resolved = await bus.call<
            { userId: string; connectorId: string },
            ConnectorsResolveOutput
          >('connectors:resolve', ctx, { userId: ctx.userId, connectorId: summary.id });
          byId.set(resolved.id, {
            id: resolved.id,
            capabilities: resolved.capabilities,
            ...(resolved.usageNote !== undefined ? { usageNote: resolved.usageNote } : {}),
          });
        } catch (err) {
          ctx.logger.warn('connector_resolve_failed', {
            connectorId: summary.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      ctx.logger.warn('connectors_list_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return [...byId.values()];
}

/**
 * Resolve the connectors a SKILL declares via its top-level `connectors[]`
 * reference list (TASK-92) into the SAME `ResolvedConnectorForOrch` shape the
 * agent effective set uses, so the caller can fold them through the EXISTING
 * `foldConnectorCaps` path (TASK-111 — the skill→connector cap-resolution
 * bridge). This is the skill-driven twin of `resolveEffectiveConnectors`: the
 * agent path resolves the agent's effective set (defaults ∪ owner's private),
 * THIS path resolves the connectors a skill in the spawn union references.
 *
 * `connectorIds` is the union of every materialized skill's `connectors[]`;
 * `alreadyResolved` is the id set the agent effective resolution already
 * produced, so an id reachable BOTH ways is folded exactly once (dedup by id,
 * matching `resolveEffectiveConnectors`'s own dedup). Duplicate ids within the
 * skill reference list itself are also collapsed (a Set drives the loop).
 *
 * NON-FATAL, same posture as the agent path: a per-id `connectors:resolve`
 * failure logs (`skill_connector_resolve_failed`) + skips THAT connector, never
 * terminates the session (connectors are additive reach — a failure yields fewer
 * connectors, never wider reach). A stripped preset without `connectors:resolve`
 * yields [].
 *
 * ZERO-REACH for unapproved/pending connectors comes for free: `connectors:resolve`
 * reads ONLY the LIVE connectors table (TASK-94), so a pending authored draft a
 * skill references is never resolved here — an unapproved connector grants no
 * reach even when a skill names it.
 */
export async function resolveSkillReferencedConnectors(
  bus: HookBus,
  ctx: AgentContext,
  connectorIds: Iterable<string>,
  alreadyResolved: Set<string>,
): Promise<ResolvedConnectorForOrch[]> {
  if (!bus.hasService('connectors:resolve')) return [];

  // Collapse duplicate references AND drop any id the agent effective set already
  // folded, so each remaining id is resolved exactly once.
  const toResolve = new Set<string>();
  for (const id of connectorIds) {
    if (!alreadyResolved.has(id)) toResolve.add(id);
  }
  if (toResolve.size === 0) return [];

  const out: ResolvedConnectorForOrch[] = [];
  for (const connectorId of toResolve) {
    try {
      const resolved = await bus.call<
        { userId: string; connectorId: string },
        ConnectorsResolveOutput
      >('connectors:resolve', ctx, { userId: ctx.userId, connectorId });
      out.push({
        id: resolved.id,
        capabilities: resolved.capabilities,
        ...(resolved.usageNote !== undefined ? { usageNote: resolved.usageNote } : {}),
      });
    } catch (err) {
      // Same convention as connector_resolve_failed — non-fatal, additive reach.
      ctx.logger.warn('skill_connector_resolve_failed', {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Per-connector credential env-name scheme — the connector twin of
 * `skillCredentialEnvName`. `connector:<id>:<slot>`. Namespacing connector slots
 * keeps them from colliding with a skill's same-named slot OR a trusted base
 * credential: two subjects' `LINEAR_API_KEY` become two distinct keys → two
 * distinct proxy placeholders → they COEXIST. The bare env-var name the
 * connector reads is restored later by `projectEnvMapToBareNames`.
 */
export function connectorCredentialEnvName(connectorId: string, slot: string): string {
  return `connector:${connectorId}:${slot}`;
}

// A connector id is a slug `^[a-z0-9][a-z0-9_-]*$` up to 128 chars; the sandbox
// skill-dir id is the STRICTER `^[a-z][a-z0-9-]{0,63}$` (no `_`, must start with
// a letter, ≤ 64 chars). So a connector materialized as an installed-skill entry
// (for its mcpServers' per-dir `.mcp.json`) needs a derived, sandbox-safe,
// COLLISION-FREE dir id.
const SANDBOX_DIR_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Map a connector id to a sandbox-safe, deterministic, collision-free
 * installed-skill dir id: `cx-<sanitized-id>` truncated, with a short hash of
 * the ORIGINAL id appended so two connectors whose sanitized/truncated forms
 * would coincide (e.g. `my_drive` vs `my-drive`, or two long ids sharing a
 * 64-char prefix) still get distinct dirs. The `cx-` prefix guarantees the
 * leading-letter rule; `_` → `-` and any other stray char → `-` guarantees the
 * charset. Always ≤ 64 chars.
 */
export function connectorSandboxDirId(connectorId: string): string {
  const sanitized = connectorId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // 8 hex chars of a sha-256 of the original id — enough to make a collision
  // between two distinct connector ids astronomically unlikely while keeping the
  // dir id short and stable.
  const hash = createHash('sha256').update(connectorId).digest('hex').slice(0, 8);
  // `cx-` (3) + hash (8) + `-` (1) = 12 reserved; 64 total → 52 chars for the body.
  const body = sanitized.slice(0, 52);
  const id = `cx-${body}-${hash}`;
  // Defensive: the construction always satisfies the regex, but assert so a
  // future edit can't silently produce an invalid id the sandbox would reject.
  if (!SANDBOX_DIR_ID_RE.test(id)) {
    // Fall back to the hash-only form (always valid) if sanitization somehow
    // produced an out-of-shape body (e.g. all chars stripped → empty body left a
    // double dash). `cx-<hash>` is ≤ 11 chars and always matches.
    return `cx-${hash}`;
  }
  return id;
}

/**
 * TASK-153 — thrown by `foldConnectorCaps` when two DIFFERENT connectors both
 * declare a dev service with the SAME `name`. One service name = one descriptor;
 * a cross-connector collision is a misconfiguration we refuse LOUDLY rather than
 * silently merging two (possibly different) images/ports under one name. The
 * orchestrator catches this and maps it to a terminated outcome (it never
 * propagates uncaught — `runAgentInvoke` must always return an AgentOutcome).
 */
export class ConnectorServiceCollisionError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly firstConnectorId: string,
    public readonly secondConnectorId: string,
  ) {
    super(
      `dev service name "${serviceName}" is declared by two connectors ` +
        `("${firstConnectorId}" and "${secondConnectorId}") — a service name ` +
        `must be unique across the agent's connectors`,
    );
    this.name = 'ConnectorServiceCollisionError';
  }
}

/** What `foldConnectorCaps` mutates / returns — the same objects the skill union
 *  built, plus the connector-specific outputs the orchestrator threads onward. */
export interface FoldConnectorResult {
  /** Sandbox installed-skill entries carrying each connector's synthetic SKILL.md
   *  (usageNote body) + its mcpServers, so the EXISTING materialization writes the
   *  per-dir `.mcp.json`. Connectors with no mcpServers still get an entry so the
   *  model sees the usage note (the design's "working out of the box" blurb). */
  installedEntries: Array<{
    id: string;
    files: { path: string; contents: string }[];
    mcpServers: ConnectorMcpServerSpec[];
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: 'api-key'; placeholder?: string | undefined }>;
    /** The connector id (NOT the sandbox dir id) — used to stamp per-connector
     *  credential placeholders after proxy:open-session. */
    connectorId: string;
  }>;
  /** Connector credential slots in fold order, for the bare-env projection. */
  connectorSlotEnvNames: Array<{ envName: string; bareSlot: string }>;
  needsNpmRegistry: boolean;
  needsPypiRegistry: boolean;
  /**
   * TASK-153 — the union of every connector's declared dev services, deduped by
   * `name`. The orchestrator threads this onto `sandbox:open-session.services`
   * (after a `services:validate` pass) so both backends render it. A
   * cross-connector name collision throws `ConnectorServiceCollisionError`
   * instead of landing here. Empty when no connector declares a service.
   */
  services: ServiceDescriptorParsed[];
}

/**
 * Fold each effective connector's Capabilities into the session, mutating the
 * SAME `baseAllowSet` / `baseCreds` / `slotOwners` the skill union built (deduped
 * by construction — hosts are a Set, slots are namespaced per-connector). Returns
 * the connector installed-entries + slot env-names + registry-need flags for the
 * orchestrator to thread into the sandbox call.
 *
 * Dedup against skill caps: hosts land in the shared `baseAllowSet` (idempotent).
 * Credential slot env-NAMES are keyed `connector:<id>:<slot>` so they never
 * collide with a skill's `skill:<id>:<slot>` or a trusted bare name; the bare-env
 * projection's trusted-name-wins + first-writer-wins rules (connectors appended
 * AFTER skills) keep skill precedence on a shared bare name. The credential REF
 * is the `account:<service>` vault key (matching @ax/connectors' connect flow).
 */
export function foldConnectorCaps(
  connectors: ResolvedConnectorForOrch[],
  baseAllowSet: Set<string>,
  baseCreds: Record<string, { ref: string; kind: string }>,
  slotOwners: Map<string, string>,
): FoldConnectorResult {
  const installedEntries: FoldConnectorResult['installedEntries'] = [];
  const connectorSlotEnvNames: Array<{ envName: string; bareSlot: string }> = [];
  let needsNpmRegistry = false;
  let needsPypiRegistry = false;
  // TASK-153 — dev services, deduped by `name`. The map value remembers which
  // connector contributed the descriptor so a cross-connector collision can name
  // BOTH connectors in the loud error.
  const servicesByName = new Map<string, { connectorId: string; descriptor: ServiceDescriptorParsed }>();

  for (const c of connectors) {
    // Hosts → shared egress allowlist (idempotent dedup vs skill hosts).
    for (const host of c.capabilities.allowedHosts) baseAllowSet.add(host);

    // Credential slots → namespaced host-side credential map. The env-NAME key
    // stays per-connector (`connector:<id>:<slot>`) so two subjects' same-named
    // slots coexist and the env projection can restore the bare name; but the
    // REF is the `account:<service>[:<slot>]` vault key TASK-96's connect flow
    // WRITES, so the orchestrator resolves the SAME row the user's connect stored.
    //
    // ONE SOURCE OF TRUTH (invariant #4): the service tag + per-slot rule MUST
    // match @ax/connectors' `serviceTagForSlot` / `deriveCredentialPlan` — the
    // service tag is the connector id (credentials-into-connectors: each connector
    // owns its own key, no share-by-service); and (TASK-124) the ref COLLAPSES to
    // `account:<service>` for a single-slot connector but EXPANDS to
    // `account:<service>:<slot>` per slot for a ≥2-slot connector. The
    // `slotDef.account ?? c.id` below is VESTIGIAL for connectors — the connectors
    // store strips `account` from a connector's slots on read, so it is always
    // `c.id` here — but it's retained because a SKILL slot (foldAuthoredSkillCaps,
    // which DOES carry `account`) flows through the same shape elsewhere. Re-derived
    // locally (I2 — no @ax/connectors runtime import). `connector-union.test.ts`
    // pins the shape; a drift here would silently address an empty/colliding row.
    const isMulti = c.capabilities.credentials.length >= 2;
    for (const slotDef of c.capabilities.credentials) {
      const envName = connectorCredentialEnvName(c.id, slotDef.slot);
      if (slotOwners.has(envName)) continue; // idempotent on a duplicate slot
      const service =
        slotDef.account !== undefined && slotDef.account.length > 0
          ? slotDef.account
          : c.id;
      const ref = isMulti ? `account:${service}:${slotDef.slot}` : `account:${service}`;
      // An `oauth` connector slot folds to the `mcp-oauth` credential kind —
      // the vault envelope kind the OAuth callback STORES (so resolve/refresh
      // dispatches to `credentials:resolve:mcp-oauth`) AND the kind the proxy
      // CLASSIFIES as `'mcp'` traffic + flags for per-turn rotation. The credential
      // VALUE is resolved later by `credentials:get(ref)`; this `kind` is for
      // classification/materialization, not resolution. The `api-key` path is
      // unchanged (identity map).
      const credKind = slotDef.kind === 'oauth' ? 'mcp-oauth' : slotDef.kind;
      baseCreds[envName] = { ref, kind: credKind };
      slotOwners.set(envName, `connector:${c.id}`);
      connectorSlotEnvNames.push({ envName, bareSlot: slotDef.slot });
    }

    // Packages → registry auto-allow detection (the orchestrator adds the
    // registry hosts to baseAllowSet alongside the skill detection).
    const pkgs = c.capabilities.packages;
    if (pkgs?.npm?.length) needsNpmRegistry = true;
    if (pkgs?.pypi?.length) needsPypiRegistry = true;

    // TASK-153 — dev services → the `sandbox:open-session.services` payload.
    // Dedup by `name` across connectors. WITHIN one connector a repeated name is
    // the same author's concern (last-wins, idempotent); ACROSS two DIFFERENT
    // connectors a shared name is a misconfiguration we refuse LOUDLY (one
    // service name = one descriptor — silently merging two possibly-different
    // images/ports under one name would be a footgun). The orchestrator catches
    // the throw and maps it to a terminated outcome.
    for (const svc of c.capabilities.services ?? []) {
      const existing = servicesByName.get(svc.name);
      if (existing !== undefined && existing.connectorId !== c.id) {
        throw new ConnectorServiceCollisionError(svc.name, existing.connectorId, c.id);
      }
      servicesByName.set(svc.name, { connectorId: c.id, descriptor: svc });
    }

    // mcpServers → an installed-skill entry so the EXISTING per-dir `.mcp.json`
    // materialization runs. Always emit an entry (even with no mcpServers) so the
    // usage note reaches the model as a SKILL.md — that's the connector's "how to
    // use me" blurb the design wants surfaced out of the box. The dir id is the
    // sandbox-safe derived id; the body is the usage note (admin/owner-authored,
    // bounded text — NOT model output).
    const body =
      c.usageNote !== undefined && c.usageNote.length > 0
        ? c.usageNote
        : `Connector "${c.id}" is available. Its access (network reach, credentials, MCP servers) is wired into this session.`;
    const synthManifest = `name: ${connectorSandboxDirId(c.id)}\ndescription: Connector ${c.id}`;
    installedEntries.push({
      id: connectorSandboxDirId(c.id),
      connectorId: c.id,
      files: [
        {
          path: 'SKILL.md',
          contents: `---\n${synthManifest}\n---\n${body}`,
        },
      ],
      mcpServers: c.capabilities.mcpServers,
      allowedHosts: c.capabilities.allowedHosts,
      // The installed-entry `kind` stays `'api-key'` even for an oauth slot — it
      // is NOT the resolution/classification kind (that's the `baseCreds` entry
      // above). This field rides the `installedSkills[].credentials[]` wire shape
      // (@ax/sandbox-protocol `InstalledSkillSchema`), which is `z.literal('api-key')`
      // and whose ONLY consumer (`buildGitCredentialEnv`) reads `slot`/`placeholder`
      // and ignores `kind`. So it's a fixed wire placeholder here; mapping it to
      // `mcp-oauth` would fail the wire schema without any resolution benefit.
      credentials: c.capabilities.credentials.map((cr) => ({
        slot: cr.slot,
        kind: 'api-key' as const,
      })),
    });
  }

  const services = [...servicesByName.values()].map((v) => v.descriptor);
  return { installedEntries, connectorSlotEnvNames, needsNpmRegistry, needsPypiRegistry, services };
}
