import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';
import { fireColdStartSubmit } from './coldstart.js';

const PLUGIN_NAME = '@ax/skill-broker';
// Re-validated independently at this trust boundary (I2/I5) — the broker never
// trusts the model's skillId shape before handing it to skills:get.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const REQUEST_CAPABILITY_DESCRIPTOR: ToolDescriptor = {
  name: 'request_capability',
  description:
    'Request that a catalog skill be connected for the user. Pass a skill id from ' +
    'search_catalog results. The user will be asked to approve the hosts it reaches and ' +
    'enter any required keys. Do not narrate this step or restate any keys — the approval ' +
    'surface handles it. Once the user approves, the conversation will continue ' +
    'automatically; do not ask the user to repeat their request.',
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
// locally — the broker reaches the catalog only through the bus (I2). Kept
// structurally in sync with SkillDetail.capabilities by the broker tests.
interface CatalogSkillDetail {
  id: string;
  description: string;
  capabilities: {
    allowedHosts: string[];
    // `account` (JIT P2/P7.2): a service slug tagging the slot to the user's
    // shared `account:<service>` vault entry instead of a per-skill ref.
    credentials: { slot: string; kind: 'api-key'; account?: string }[];
  };
}

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
  // it. `haveExisting`: the user already has the `account:<service>` vault entry,
  // so the card offers "use your existing key" instead of prompting. Both are
  // per-request card hints — never persisted on a manifest/store type.
  slots: { slot: string; kind: 'api-key'; account?: string; haveExisting?: boolean }[];
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
        hosts: detail.capabilities.allowedHosts,
        slots: detail.capabilities.credentials.map((c) => ({
          slot: c.slot,
          kind: 'api-key' as const,
          ...(c.account !== undefined ? { account: c.account } : {}),
          haveExisting: c.account !== undefined && vaulted.has(`account:${c.account}`),
        })),
      };
      await bus.fire('chat:permission-request', toolCtx, card);

      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
