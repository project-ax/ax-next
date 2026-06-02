import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';
import { fireColdStartSubmit } from './coldstart.js';

const PLUGIN_NAME = '@ax/skill-broker';
// Re-validated independently at this trust boundary (I2/I5) — the broker never
// trusts the model's skillId shape before handing it to skills:get.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// Order-preserving dedup (first occurrence wins). Used to union the skill block's
// caps with the connector-derived caps without double-listing a shared host/pkg.
function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export const REQUEST_CAPABILITY_DESCRIPTOR: ToolDescriptor = {
  name: 'request_capability',
  description:
    'Request that a catalog skill be connected for the user. Pass a skill id from ' +
    'search_catalog results. The user will be asked to approve the hosts it reaches and ' +
    'enter any required keys. Do not narrate this step or restate any keys — the approval ' +
    'surface handles it. Once the user approves, the conversation will continue ' +
    'automatically; do not ask the user to repeat their request. ' +
    'If the result is { status: "not-found" }, the capability is not in the catalog yet ' +
    'and a request to add it is filed for the administrator automatically — tell the user ' +
    'you have asked your admin to add it and that you will be able to help once it is approved. ' +
    'That is the expected outcome, not an error.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The catalog skill id to request, taken from search_catalog results.',
      },
    },
    required: ['skillId'],
  },
};

interface RequestCapabilityResult {
  status: 'requested' | 'not-found';
  skillId: string;
}

// Mirrors the subset of @ax/skills' SkillDetail the broker reads. Re-declared
// locally — the broker reaches the catalog only through the bus (I2).
//
// TASK-100 — a skill no longer carries a capability block; the broker's approval
// card is built ENTIRELY from the connectors the skill references. So the broker
// reads only the skill's id/description (for the card body) + its `connectors[]`.
interface CatalogSkillDetail {
  id: string;
  description: string;
  // TASK-92/TASK-100 — the skill's top-level connector references. The broker
  // resolves each via connectors:resolve and builds the card from their reach.
  // Optional + `?? []` for a skills:get that predates the field.
  connectors?: string[];
}

// TASK-111 — connectors:resolve output (the subset the card folds). Structural
// mirror of @ax/connectors' ResolveOutput (I2 — no @ax/connectors import); the
// broker reaches the connector registry only through the bus. The card surfaces
// the same public manifest data (hosts / slot NAMES / packages) it already shows
// for the skill's own block — never a backing-mechanism field or a secret.
interface ConnectorsResolveOutput {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: { slot: string; kind: 'api-key'; account?: string }[];
    packages?: { npm?: string[]; pypi?: string[] };
  };
}

// Connector id grammar (re-validated at this trust boundary, I2/I5). Mirrors the
// @ax/connectors store rule — a flat opaque slug; the broker never trusts a
// skill-declared connector id's shape before handing it to connectors:resolve.
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

// credentials:list returns METADATA ONLY — refs + kinds, NEVER a secret value.
// Minimal local mirror (I2 — no @ax/credentials import). The broker only learns
// whether an `account:<service>` ref EXISTS for the user, never its value.
interface CredentialsListOutput {
  credentials: Array<{ ref: string }>;
}

// The bundled approval card payload (design §11.3, decision #6). Carries only
// public manifest data — never a secret (the card's key field posts straight to
// the host credential store, §10). The matching SSE-frame + render side
// re-declares this shape in @ax/channel-web (I2 — no shared import).
//
// `kind: 'skill'` discriminates this from the reactive egress-wall's
// `kind: 'host'` variant (TASK-37, fired by @ax/chat-orchestrator). The
// `chat:permission-request` payload is a union on `kind`; this producer always
// fires the skill variant.
interface PermissionRequestEvent {
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  // `account` (JIT P2): the service slug, present iff the manifest slot declares
  // it. `haveExisting`: the user already has the matching vault entry, so the card
  // offers "use your existing key" instead of prompting. `service`/`slotTag`
  // (TASK-124): the resolved vault-key tags the card's WRITE path uses to build
  // `{kind:'account', service, slot?}` — `service` is the slot's account (else the
  // connector id), `slotTag` is present only for a multi-slot connector's per-slot
  // `account:<service>:<slot>` ref. All per-request card hints — never persisted
  // on a manifest/store type.
  slots: {
    slot: string;
    kind: 'api-key';
    account?: string;
    service?: string;
    slotTag?: string;
    haveExisting?: boolean;
  }[];
  // Package registry egress the skill declares — shown to the user so they can
  // see which registries will be used. Empty arrays when the skill has no
  // package deps.
  packages: { npm: string[]; pypi: string[] };
}

export async function registerRequestCapability(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, REQUEST_CAPABILITY_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, RequestCapabilityResult>(
    'tool:execute:request_capability',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { skillId?: unknown };
      const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
      if (skillId.length === 0 || !SKILL_ID_RE.test(skillId)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:request_capability',
          message: 'request_capability requires a valid catalog "skillId"',
        });
      }

      // Validate the id resolves in the GLOBAL catalog. skills:get throws
      // skill-not-found when absent — translate to a structured result the
      // model can act on rather than surfacing a tool error.
      let detail: CatalogSkillDetail;
      try {
        detail = await bus.call<{ skillId: string; scope: 'global' }, CatalogSkillDetail>(
          'skills:get',
          toolCtx,
          { skillId, scope: 'global' },
        );
      } catch (err) {
        if (err instanceof PluginError && err.code === 'skill-not-found') {
          // Cold-start (design §13): the requested capability isn't in the
          // catalog, so file a deduped admit-queue request — "a user needed X" —
          // for the admin to source. The skillId is already SKILL_ID_RE-validated
          // above, so it doubles as the dedup slug; the description is a fixed
          // host template (no free model text on this path). Best-effort: a
          // failed/absent submit never changes this not-found result.
          await fireColdStartSubmit(bus, toolCtx, {
            skillId,
            description: `A user requested the '${skillId}' capability, which isn't in the catalog yet.`,
          });
          return { status: 'not-found', skillId };
        }
        throw err;
      }

      // Vault lookup (JIT P2): which `account:<service>` refs does this user
      // already have? Metadata-only (credentials:list, user scope) — the secret
      // NEVER crosses this boundary; we only learn EXISTENCE so the card can
      // offer "use your existing <service> key". Gated by hasService so
      // credential-less presets degrade to always-prompt; best-effort so a failed
      // lookup just prompts rather than blocking the card.
      const vaulted = new Set<string>();
      if (bus.hasService('credentials:list')) {
        try {
          const list = await bus.call<{ scope: 'user'; ownerId: string }, CredentialsListOutput>(
            'credentials:list',
            toolCtx,
            { scope: 'user', ownerId: toolCtx.userId },
          );
          for (const c of list.credentials) vaulted.add(c.ref);
        } catch {
          // A failed lookup just means the card prompts. Never block the card.
        }
      }

      // TASK-100 / TASK-111 — the card surface comes ENTIRELY from the connectors
      // a skill references via its top-level `connectors[]` (TASK-92). A skill no
      // longer carries a capability block of its own (TASK-100 closed that path),
      // so reach is the connectors', resolved via connectors:resolve and gated by
      // the TASK-93 wall (connectorId subject — the kind:'skill' card is reused,
      // not forked). The card shows the SAME public manifest data (hosts / slot
      // NAMES / packages) the connector declares — never a backing-mechanism field
      // or a secret.
      //
      // Best-effort + hasService-gated: a stripped/credential-less preset (no
      // connectors:resolve) yields an empty card surface; a per-connector resolve
      // failure just omits that connector's reach — it NEVER blocks the card. A
      // pending authored draft is never returned by connectors:resolve (it reads
      // only the live human-approved/curated table — TASK-94), so an unapproved
      // connector contributes ZERO reach here (the security invariant TASK-111
      // established and TASK-100 must preserve).
      const connectorHosts: string[] = [];
      // TASK-124 — each accumulated slot carries the RESOLVED vault-key tags
      // (service / slotTag / ref) computed AT resolve time, where the connector id
      // + its slot count are in hand. The per-slot ref rule keys on the resolved
      // connector's slot COUNT (mirrors @ax/connectors' deriveCredentialPlan):
      // exactly 1 slot keeps `account:<service>`, ≥2 slots expand to
      // `account:<service>:<slot>` per slot.
      const connectorSlots: {
        slot: string;
        kind: 'api-key';
        account?: string;
        service: string;
        slotTag?: string;
        ref: string;
      }[] = [];
      const connectorNpm: string[] = [];
      const connectorPypi: string[] = [];
      if (bus.hasService('connectors:resolve')) {
        // Dedup the reference list + drop any id with a bad shape before resolving.
        const refs = new Set((detail.connectors ?? []).filter((c) => CONNECTOR_ID_RE.test(c)));
        for (const connectorId of refs) {
          try {
            const resolved = await bus.call<
              { userId: string; connectorId: string },
              ConnectorsResolveOutput
            >('connectors:resolve', toolCtx, { userId: toolCtx.userId, connectorId });
            for (const h of resolved.capabilities.allowedHosts) connectorHosts.push(h);
            const isMulti = resolved.capabilities.credentials.length >= 2;
            for (const c of resolved.capabilities.credentials) {
              // service = the connector id (mirrors @ax/connectors' serviceTagForSlot:
              // each connector owns its own key, no share-by-service). The
              // `c.account ?? resolved.id` is VESTIGIAL — `connectors:resolve` returns
              // store-validated capabilities with `account` stripped, so it is always
              // `resolved.id` here.
              const service =
                c.account !== undefined && c.account.length > 0 ? c.account : resolved.id;
              const ref = isMulti ? `account:${service}:${c.slot}` : `account:${service}`;
              connectorSlots.push({
                slot: c.slot,
                kind: 'api-key',
                ...(c.account !== undefined ? { account: c.account } : {}),
                service,
                ...(isMulti ? { slotTag: c.slot } : {}),
                ref,
              });
            }
            for (const p of resolved.capabilities.packages?.npm ?? []) connectorNpm.push(p);
            for (const p of resolved.capabilities.packages?.pypi ?? []) connectorPypi.push(p);
          } catch {
            // A failed resolve just omits this connector's reach. Never block the card.
          }
        }
      }

      // The card surface is purely connector-derived now, deduped: a host or
      // package declared by multiple connectors appears once; a slot is keyed by
      // name (first declaration wins its account/service/slotTag/haveExisting).
      const allHosts = dedup(connectorHosts);
      const slotByName = new Map<string, (typeof connectorSlots)[number]>();
      for (const c of connectorSlots) {
        if (!slotByName.has(c.slot)) slotByName.set(c.slot, c);
      }
      const allNpm = dedup(connectorNpm);
      const allPypi = dedup(connectorPypi);

      // A skill that references no connectors (or whose connectors resolve to no
      // reach) has nothing to gate — it's a free-path instruction skill. Fire no
      // card; request_capability is a no-op approval surface in that case.
      if (allHosts.length === 0 && slotByName.size === 0 && allNpm.length === 0 && allPypi.length === 0) {
        return { status: 'requested', skillId };
      }

      // Surface the ONE bundled approval card (design §11.3, decision #6) — the
      // open-mode security boundary. Public manifest data only: hostnames + slot
      // NAMES (never values). request_capability still returns the minimum to the
      // model (it must NOT narrate hosts/keys; §7). Match key is the conversation
      // (toolCtx carries the real conversationId; the runner-driven IPC ctx has a
      // fresh reqId — see ipc-server/listener.ts). Firing a subscriber hook needs
      // no manifest declaration (the orchestrator fires chat:turn-error undeclared).
      //
      // The card both collects/binds the key and (TASK-36) attaches + resumes;
      // the binding ref is minted in chat-orchestrator's applyCapabilityGrant,
      // where the `account`-vs-`skill` decision lives. For an account-tagged slot
      // the card offers the user's existing vaulted key (haveExisting) — one tap,
      // no re-entry.
      const card: PermissionRequestEvent = {
        kind: 'skill',
        skillId,
        description: detail.description,
        hosts: allHosts,
        slots: [...slotByName.values()].map((c) => ({
          slot: c.slot,
          kind: 'api-key' as const,
          ...(c.account !== undefined ? { account: c.account } : {}),
          service: c.service,
          ...(c.slotTag !== undefined ? { slotTag: c.slotTag } : {}),
          // TASK-124 — presence is checked against the RESOLVED per-slot ref so a
          // multi-slot connector offers "use existing" only when THAT slot's row
          // is vaulted (not a collapsed sibling).
          haveExisting: vaulted.has(c.ref),
        })),
        packages: { npm: allNpm, pypi: allPypi },
      };
      await bus.fire('chat:permission-request', toolCtx, card);

      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
