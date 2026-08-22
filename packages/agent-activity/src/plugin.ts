import type { AgentContext, HookBus, Plugin, ToolCall, ToolDescriptor } from '@ax/core';
import { z, type ZodType } from 'zod';
import { deriveActivity } from './derive.js';
import type {
  AgentActivity,
  AgentActivityGetInput,
  AgentActivityGetOutput,
  DeriveToolInput,
} from './types.js';

const PLUGIN_NAME = '@ax/agent-activity';
const PLUGIN_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// ARCH-13 `returns` contract. A zod object strips keys it does not declare, so
// this schema is the authoritative shape of what `agent-activity:get` emits.
// ---------------------------------------------------------------------------
const AgentActivitySchema = z.object({
  phrase: z.string(),
  counter: z
    .object({ done: z.number(), total: z.number(), unit: z.string() })
    .nullable(),
  startedAt: z.string(),
  source: z.union([z.literal('declared'), z.literal('tool'), z.literal('trigger')]),
  stale: z.boolean(),
});

export const AgentActivityGetOutputSchema = z.object({
  activity: AgentActivitySchema.nullable(),
}) as unknown as ZodType<AgentActivityGetOutput>;

export interface AgentActivityConfig {
  /** Time seam. Injected so the staleness clock is testable. */
  now?: () => number;
}

/**
 * What we know about one agent's current stretch of work.
 *
 * In memory, on purpose. This line describes *right now*, and after a host
 * restart there is no "right now" to describe — the rail then falls to the T0
 * floor or shows nothing, both of which are honest. Persisting it would let a
 * process that died three hours ago keep claiming to be reading email.
 */
interface ActivityRecord {
  startedAt: number;
  lastStepAt: number;
  /** T0 — the human-authored label for what started this, when there is one. */
  trigger: string | null;
  /** T1 — what the currently-running tool contributes. */
  tool: DeriveToolInput | null;
  /**
   * name → manifest phrase/countable, for THIS agent's scoped catalog. Filled
   * once per stretch of work and thrown away with it: the catalog seals on
   * first `tool:list` and never changes afterwards, and `tool:list` is scoped
   * to the calling agent, so a per-record cache is both correct and bounded by
   * the number of agents actually working right now.
   */
  catalog: Map<string, DeriveToolInput> | null;
}

/**
 * The "Right now" line.
 *
 * Reads the tool catalog's in-repo `activityPhrase` and the context's
 * human-authored trigger label, and answers "what is this agent doing" without
 * ever asking a model. Observe-only: it registers one read hook and subscribes
 * to four, and it never votes on anything.
 *
 * Keyed by `agentId` alone. Two conversations running on one agent share the
 * line and the later step wins — the rail this feeds is per-agent, so there is
 * one line to be right about.
 */
export function createAgentActivityPlugin(cfg: AgentActivityConfig = {}): Plugin {
  const now = cfg.now ?? (() => Date.now());
  const byAgent = new Map<string, ActivityRecord>();
  let busRef: HookBus | null = null;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['agent-activity:get'],
      calls: [],
      // `tool:list` supplies T1's phrases, and its absence is survivable by
      // construction: a deployment without a tool catalog has no tool activity
      // to describe, so the line resolves to its T0 floor — which is the whole
      // point of having a floor. Required-`calls` would force every preset
      // that wires the status line to also wire a tool catalog.
      optionalCalls: [
        {
          hook: 'tool:list',
          degradation:
            'without a tool catalog the activity line cannot read a tool\'s activityPhrase, so it resolves to its T0 floor (the trigger label, else "Working on your request") instead of naming the running tool',
        },
      ],
      subscribes: ['chat:start', 'chat:end', 'chat:turn-error', 'tool:pre-call'],
    },

    async init({ bus }) {
      busRef = bus;
      // Read-only, and deliberately NOT an ACL boundary: it answers for the
      // `agentId` it is handed. Every caller reaches an agent through
      // `agents:resolve` first, and adding a second, weaker check here would
      // just be a second place for the real one to be forgotten. Nothing it
      // returns is a secret — it is one short phrase and a start time — but
      // whoever mounts this on a route still owes that route an ACL.
      bus.registerService<AgentActivityGetInput, AgentActivityGetOutput>(
        'agent-activity:get',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const record = byAgent.get(input.agentId);
          if (record === undefined) return { activity: null };
          return { activity: snapshot(record, now()) };
        },
        { returns: AgentActivityGetOutputSchema },
      );

      // A turn begins: this is the only moment the trigger label is knowable.
      // `@ax/routines` stamps it on the context it mints for a scheduled fire;
      // nothing recovers it afterwards, because the routine's fire row is not
      // written until the turn has already ended.
      bus.subscribe<unknown>('chat:start', PLUGIN_NAME, async (ctx) => {
        observe(ctx, () => {
          const at = now();
          byAgent.set(ctx.agentId, {
            startedAt: at,
            lastStepAt: at,
            trigger: ctx.triggerLabel ?? null,
            tool: null,
            catalog: null,
          });
        });
        return undefined;
      });

      // Every tool call crosses here. We read the tool's own in-repo
      // `activityPhrase` — never its model-facing `description`, which is
      // written to steer an LLM and which for an MCP tool is third-party text.
      bus.subscribe<ToolCall>('tool:pre-call', PLUGIN_NAME, async (ctx, call) => {
        // Observe only. Returning anything other than `undefined` would make a
        // status line capable of modifying or vetoing a tool call, which is
        // absurd. `HookBus.fire` would swallow a throw from here anyway, so we
        // swallow our own errors deliberately and loudly rather than relying
        // on that.
        try {
          await recordToolCall(bus, ctx, call);
        } catch (err) {
          ctx.logger.error('agent_activity_record_failed', {
            plugin: PLUGIN_NAME,
            tool: call?.name,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
        return undefined;
      });

      // The work is over. No "right now" to describe, so we say nothing rather
      // than leaving the last phrase standing. A turn that ERRORED is the same
      // answer here: the error state belongs to the surface that renders the
      // status dot, not to a line that claims the agent is doing something.
      const forget = async (ctx: AgentContext): Promise<undefined> => {
        observe(ctx, () => {
          byAgent.delete(ctx.agentId);
        });
        return undefined;
      };
      bus.subscribe<unknown>('chat:end', PLUGIN_NAME, forget);
      bus.subscribe<unknown>('chat:turn-error', PLUGIN_NAME, forget);
    },

    // Idempotent: unsubscribing twice is a no-op, and clearing an already
    // empty map is too.
    shutdown() {
      if (busRef !== null) {
        for (const hook of ['chat:start', 'chat:end', 'chat:turn-error', 'tool:pre-call']) {
          busRef.unsubscribe(hook, PLUGIN_NAME);
        }
        busRef = null;
      }
      byAgent.clear();
    },
  };

  function snapshot(record: ActivityRecord, at: number): AgentActivity {
    return deriveActivity({
      tool: record.tool,
      trigger: record.trigger,
      startedAt: record.startedAt,
      lastStepAt: record.lastStepAt,
      now: at,
    });
  }

  async function recordToolCall(bus: HookBus, ctx: AgentContext, call: ToolCall): Promise<void> {
    const at = now();
    // A pre-call can arrive with no `chat:start` behind it — the IPC boundary
    // rebuilds the context, and a canary may drive the hook directly. Start a
    // record rather than dropping the step; the line still resolves, just from
    // its floor.
    const record: ActivityRecord = byAgent.get(ctx.agentId) ?? {
      startedAt: at,
      lastStepAt: at,
      trigger: ctx.triggerLabel ?? null,
      tool: null,
      catalog: null,
    };
    // Record the STEP before looking anything up. A catalog read that fails
    // should cost us the phrase, not the fact that the agent is alive — the
    // line then falls to its floor instead of drifting into a false "no
    // activity for 4 minutes".
    record.lastStepAt = at;
    record.tool = null;
    byAgent.set(ctx.agentId, record);

    record.tool = await lookupPhrase(bus, ctx, record, call?.name);
  }

  async function lookupPhrase(
    bus: HookBus,
    ctx: AgentContext,
    record: ActivityRecord,
    name: string | undefined,
  ): Promise<DeriveToolInput | null> {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (record.catalog === null) {
      if (!bus.hasService('tool:list')) return null;
      const { tools } = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
        'tool:list',
        ctx,
        {},
      );
      const map = new Map<string, DeriveToolInput>();
      for (const tool of tools) {
        // No phrase, no entry. A tool that did not author one falls to T0
        // rather than borrowing prose from somewhere it does not belong —
        // notably its `description`, which for an MCP tool is third-party
        // text that must never be rendered as our own claim.
        if (typeof tool.activityPhrase !== 'string') continue;
        map.set(tool.name, {
          phrase: tool.activityPhrase,
          ...(typeof tool.countable === 'string' ? { countable: tool.countable } : {}),
          // No `reported`: nothing in the system reports tool progress yet, and
          // a counter we estimated ourselves would be a number we made up.
        });
      }
      record.catalog = map;
    }
    return record.catalog.get(name) ?? null;
  }
}

/**
 * Run a bookkeeping side-effect that must never be able to affect the hook it
 * rides on. Synchronous twin of the try/catch in the `tool:pre-call`
 * subscriber.
 */
function observe(ctx: AgentContext, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    ctx.logger.error('agent_activity_record_failed', {
      plugin: PLUGIN_NAME,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
