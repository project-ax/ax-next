import { PluginError, type AgentContext, type HookBus, type ToolDescriptor } from '@ax/core';
import {
  AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK,
  AGENTS_IDENTITY_GET_HOOK,
  AGENTS_IDENTITY_SET_HOOK,
  type AgentIdentityRecord,
  type IdentityCompleteBootstrapOutput,
  type IdentitySetOutput,
  type SelfSection,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-989 — the agent's own host tools.
//
//   update_identity     rewrite (or edit one passage of) its identity or its
//                       soul. NEVER its Instructions: those are its people's.
//   complete_bootstrap  finish its first-run setup once both are saved.
//
// Both act on `ctx.agentId` — the session's agent, stamped by the host from
// the session record — and never on an id from the tool input (an extra input
// key is refused). Both refuse an unattended run (`ctx.source === 'routine'`:
// a routine or a task check-in, no person present); the orchestrator also
// keeps them out of such a session's catalog, so this is defence in depth.
//
// They call the `agents:identity:*` hooks on the bus — the same registered
// surface, checks and `returns` schemas a person's editor goes through — so
// the agent's writes are scanned, capped and compare-and-set exactly like a
// person's. Executors never throw: a host tool cannot mark its own result as
// an error to the model (only a throw does, and that path redacts the
// message), so every failure is an `ok: false` result whose message says, on
// its own, that nothing was saved. A hook's `forbidden`, `not-found` or
// `invalid-payload` throw is `not-allowed` (retrying cannot help); any other
// throw is `unavailable` (it may).
//
// TASK-990 — update_identity is the ONLY writer that sends `author: 'agent'`
// (a constant here, never read from the tool input). That is what puts a
// saved change on its owner's Today, as "changed its personality" or
// "changed how it describes itself".
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';

export const UPDATE_IDENTITY_TOOL = 'update_identity';
export const COMPLETE_BOOTSTRAP_TOOL = 'complete_bootstrap';
const UPDATE_IDENTITY_TOOL_HOOK = 'tool:execute:update_identity';
const COMPLETE_BOOTSTRAP_TOOL_HOOK = 'tool:execute:complete_bootstrap';

export const UPDATE_IDENTITY_DESCRIPTOR: ToolDescriptor = {
  name: UPDATE_IDENTITY_TOOL,
  description:
    'Change your own identity or soul. section "identity" is who you are: your name, your signature emoji, ' +
    'your vibe, how you present yourself. section "soul" is your values, your philosophy and the boundaries ' +
    'you hold. Send content to replace the whole section, or old and new to change one passage (old must ' +
    'appear exactly once). You cannot change your Instructions; they come from your people. A change ' +
    'applies from your next message, not this one. The result has ok: true only when it was saved; ' +
    'anything else means NOTHING was saved.',
  activityPhrase: 'Updating its own identity',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['identity', 'soul'],
        description: 'Which part of yourself to change: "identity" or "soul".',
      },
      content: {
        type: 'string',
        description: 'The full new text of the section. Replaces it entirely.',
      },
      old: {
        type: 'string',
        minLength: 1,
        description: 'A passage of the current section to replace. Must appear exactly once.',
      },
      new: {
        type: 'string',
        description: 'The text that replaces old. May be empty to delete the passage.',
      },
    },
    required: ['section'],
    additionalProperties: false,
  },
};

export const COMPLETE_BOOTSTRAP_DESCRIPTOR: ToolDescriptor = {
  name: COMPLETE_BOOTSTRAP_TOOL,
  description:
    'Finish your first-run setup once your identity and your soul are both saved with update_identity. ' +
    'From your next message on you are yourself. Fails if either is still empty.',
  activityPhrase: 'Finishing its first-run setup',
  executesIn: 'host',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export type UpdateIdentityError =
  | 'invalid-input'
  | 'instructions-not-yours'
  | 'old-not-found'
  | 'old-not-unique'
  | 'refused'
  | 'changed'
  | 'not-available'
  | 'not-allowed'
  | 'unavailable';

export type UpdateIdentityResult =
  | { ok: true; section: 'identity' | 'soul'; content: string; note: string }
  | { ok: false; error: UpdateIdentityError; message: string; current?: string };

export type CompleteBootstrapError =
  | 'already-done'
  | 'not-bootstrapping'
  | 'needs-identity-and-soul'
  | 'not-available'
  | 'not-allowed'
  | 'unavailable'
  | 'invalid-input';

export type CompleteBootstrapResult =
  | { ok: true; message: string }
  | { ok: false; error: CompleteBootstrapError; message: string };

/** The executor input: the host hands over the whole ToolCall. */
interface ToolCallInput {
  input?: unknown;
}

type UpdateRequest =
  | { section: SelfSection; form: 'content'; content: string }
  | { section: SelfSection; form: 'edit'; old: string; replacement: string };

/** A read, a compare-and-set, and a retry on conflict — at most this many times. */
const MAX_ATTEMPTS = 3;

const UPDATE_KEYS = new Set(['section', 'content', 'old', 'new']);

const NOT_SAVED = 'NOT SAVED: ';
const SAVED_NOTE = 'Saved. This applies from your next message, not this one.';
const UNCHANGED_NOTE = 'That is already what it says, so nothing changed.';

const UPDATE_MESSAGES: Record<
  Exclude<UpdateIdentityError, 'old-not-found' | 'old-not-unique' | 'refused'>,
  string
> = {
  'invalid-input': 'Send section ("identity" or "soul") with either content, or old and new.',
  'instructions-not-yours':
    'Your Instructions come from your people, and only they can change them. ' +
    'update_identity changes only your identity or your soul.',
  changed: 'your identity kept changing while you edited it. Try again.',
  'not-available': "you can't change your identity in a run with no person present.",
  'not-allowed': "you can't change this agent's identity from here.",
  unavailable: "your identity couldn't be saved right now; you may retry later.",
};

const COMPLETE_DONE = "Done. Your first-run setup is complete; from your next message on, you're yourself.";

const COMPLETE_MESSAGES: Record<CompleteBootstrapError, string> = {
  'already-done': 'Already done: your first-run setup was completed earlier.',
  'not-bootstrapping': "You're not in first-run setup, so there's nothing to finish.",
  'needs-identity-and-soul': 'NOT DONE: save both your identity and your soul with update_identity first.',
  'not-available': "NOT DONE: first-run setup can't be finished in a run with no person present.",
  'not-allowed': "NOT DONE: you can't finish this agent's first-run setup from here.",
  unavailable: "NOT DONE: this couldn't be completed right now; you may retry later.",
  'invalid-input': 'NOT DONE: complete_bootstrap takes no input; call it with {}.',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notSaved(
  error: Exclude<UpdateIdentityError, 'old-not-found' | 'old-not-unique' | 'refused'>,
): UpdateIdentityResult {
  return { ok: false, error, message: NOT_SAVED + UPDATE_MESSAGES[error] };
}

function completeFailure(error: CompleteBootstrapError): CompleteBootstrapResult {
  return { ok: false, error, message: COMPLETE_MESSAGES[error] };
}

/**
 * The tool's own input check. Instructions are named first, whatever else the
 * input says, so the agent learns the one thing that matters about them.
 */
function parseUpdateInput(raw: unknown): UpdateRequest | 'invalid-input' | 'instructions-not-yours' {
  if (!isPlainObject(raw)) return 'invalid-input';
  if (raw.section === 'instructions') return 'instructions-not-yours';
  if (Object.keys(raw).some((key) => !UPDATE_KEYS.has(key))) return 'invalid-input';
  const section = raw.section;
  if (section !== 'identity' && section !== 'soul') return 'invalid-input';
  const { content, old } = raw;
  const replacement = raw.new;
  if (typeof content === 'string' && old === undefined && replacement === undefined) {
    return { section, form: 'content', content };
  }
  if (
    content === undefined &&
    typeof old === 'string' &&
    old.length > 0 &&
    typeof replacement === 'string'
  ) {
    return { section, form: 'edit', old, replacement };
  }
  return 'invalid-input';
}

/**
 * Where `needle` occurs in `text` — once, never, or more than once. Overlapping
 * matches count ('aa' is in 'aaa' twice, at 0 and at 1): "exactly once" means
 * the agent's passage picks out one position, and an overlap leaves which one
 * it meant ambiguous.
 */
function findOnce(text: string, needle: string): number | 'none' | 'many' {
  const first = text.indexOf(needle);
  if (first === -1) return 'none';
  return text.indexOf(needle, first + 1) === -1 ? first : 'many';
}

function errorFields(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  return err instanceof PluginError ? { name, code: err.code } : { name };
}

/**
 * The identity hooks throw only for a call that can never succeed from this
 * session — malformed input, an agent that is gone, or a user who cannot
 * reach it. Anything else (a timeout, a database error) is worth a retry.
 */
const NOT_ALLOWED_CODES = new Set(['forbidden', 'not-found', 'invalid-payload']);

function failureKind(err: unknown): 'not-allowed' | 'unavailable' {
  return err instanceof PluginError && NOT_ALLOWED_CODES.has(err.code) ? 'not-allowed' : 'unavailable';
}

async function runUpdateIdentity(
  bus: HookBus,
  ctx: AgentContext,
  call: ToolCallInput | undefined,
): Promise<UpdateIdentityResult> {
  if (ctx.source === 'routine') return notSaved('not-available');
  const request = parseUpdateInput(call?.input);
  if (typeof request === 'string') return notSaved(request);
  const { section } = request;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const record = await bus.call<{ agentId: string }, AgentIdentityRecord>(
        AGENTS_IDENTITY_GET_HOOK,
        ctx,
        { agentId: ctx.agentId },
      );
      const current = record[section];
      let next: string;
      if (request.form === 'content') {
        next = request.content;
      } else {
        const at = findOnce(current, request.old);
        if (at === 'none') {
          return {
            ok: false,
            error: 'old-not-found',
            message: `${NOT_SAVED}old does not appear in your current ${section}. Its current text is in "current".`,
            current,
          };
        }
        if (at === 'many') {
          return {
            ok: false,
            error: 'old-not-unique',
            message:
              `${NOT_SAVED}old appears more than once in your current ${section}. ` +
              'Include more of the surrounding text so it matches exactly once.',
          };
        }
        // Spliced by position, never String.replace: `new` is inserted
        // literally, so `$&`, `$1`, `$$` and friends stay as written.
        next = current.slice(0, at) + request.replacement + current.slice(at + request.old.length);
      }
      const out = await bus.call<
        {
          agentId: string;
          patch: Partial<Record<SelfSection, string>>;
          expectedRevision: number;
          author: 'agent';
        },
        IdentitySetOutput
      >(AGENTS_IDENTITY_SET_HOOK, ctx, {
        agentId: ctx.agentId,
        patch: { [section]: next },
        expectedRevision: record.revision,
        // The agent is changing itself: its owner sees it on Today (TASK-990).
        author: 'agent',
      });
      if (out.outcome === 'conflict') continue;
      if (out.outcome === 'refused') {
        // A scanner that could not answer is not a judgement on the text:
        // asking the agent to rewrite it would be wrong.
        if (out.code === 'scan-unavailable') return notSaved('unavailable');
        return {
          ok: false,
          error: 'refused',
          message: `${NOT_SAVED}the safety check refused this text (${out.reason}). Rewrite that part and try again.`,
        };
      }
      return {
        ok: true,
        section,
        content: out.record[section],
        note: out.outcome === 'saved' ? SAVED_NOTE : UNCHANGED_NOTE,
      };
    }
    return notSaved('changed');
  } catch (err) {
    ctx.logger.warn('agent_identity_tool_failed', {
      agentId: ctx.agentId,
      tool: UPDATE_IDENTITY_TOOL,
      ...errorFields(err),
    });
    return notSaved(failureKind(err));
  }
}

const COMPLETE_OUTCOMES = {
  completed: { ok: true, message: COMPLETE_DONE },
  'already-done': completeFailure('already-done'),
  'not-pending': completeFailure('not-bootstrapping'),
  'needs-identity-and-soul': completeFailure('needs-identity-and-soul'),
} as const satisfies Record<string, CompleteBootstrapResult>;

async function runCompleteBootstrap(
  bus: HookBus,
  ctx: AgentContext,
  call: ToolCallInput | undefined,
): Promise<CompleteBootstrapResult> {
  if (ctx.source === 'routine') return completeFailure('not-available');
  const input = call?.input;
  // No input is the only input: absent, null or {}.
  if (!(input === undefined || input === null || (isPlainObject(input) && Object.keys(input).length === 0))) {
    return completeFailure('invalid-input');
  }
  try {
    const out = await bus.call<{ agentId: string }, IdentityCompleteBootstrapOutput>(
      AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK,
      ctx,
      { agentId: ctx.agentId },
    );
    return { ...COMPLETE_OUTCOMES[out.outcome] };
  } catch (err) {
    ctx.logger.warn('agent_identity_tool_failed', {
      agentId: ctx.agentId,
      tool: COMPLETE_BOOTSTRAP_TOOL,
      ...errorFields(err),
    });
    return completeFailure(failureKind(err));
  }
}

/**
 * Register both executors, and — when a tool catalog is loaded — both
 * descriptors. The executors are always registered: without `tool:register`
 * no agent is offered the tools, but the services still answer. Register them
 * after the `agents:identity:*` hooks they call.
 */
export async function registerIdentityTools(bus: HookBus, initCtx: AgentContext): Promise<void> {
  bus.registerService<ToolCallInput | undefined, UpdateIdentityResult>(
    UPDATE_IDENTITY_TOOL_HOOK,
    PLUGIN_NAME,
    async (ctx, call) => runUpdateIdentity(bus, ctx, call),
  );
  bus.registerService<ToolCallInput | undefined, CompleteBootstrapResult>(
    COMPLETE_BOOTSTRAP_TOOL_HOOK,
    PLUGIN_NAME,
    async (ctx, call) => runCompleteBootstrap(bus, ctx, call),
  );
  if (bus.hasService('tool:register')) {
    await bus.call('tool:register', initCtx, UPDATE_IDENTITY_DESCRIPTOR);
    await bus.call('tool:register', initCtx, COMPLETE_BOOTSTRAP_DESCRIPTOR);
  }
}
