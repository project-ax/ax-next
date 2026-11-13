import { randomBytes } from 'node:crypto';
import { clampCodeUnits } from './clamp.js';
import { PluginError } from './errors.js';

export function makeReqId(): string {
  return `req-${randomBytes(6).toString('hex')}`;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, bindings?: Record<string, unknown>): void;
  info(msg: string, bindings?: Record<string, unknown>): void;
  warn(msg: string, bindings?: Record<string, unknown>): void;
  error(msg: string, bindings?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  reqId: string;
  writer?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

// reqId/level/ts/msg are reserved log fields: they're set last on every entry
// so that caller-supplied bindings (including ones flowing in from plugin or
// model output) can't spoof them and break log correlation.
const RESERVED_LOG_FIELDS = ['reqId', 'level', 'ts', 'msg'] as const;

export function createLogger(opts: CreateLoggerOptions): Logger {
  const writer = opts.writer ?? ((line: string) => process.stdout.write(line + '\n'));
  const baseBindings = stripReserved(opts.bindings);

  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    const entry: Record<string, unknown> = { ...baseBindings };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (RESERVED_LOG_FIELDS.includes(k as (typeof RESERVED_LOG_FIELDS)[number])) continue;
        entry[k] = v instanceof Error ? serializeError(v) : v;
      }
    }
    entry.level = level;
    entry.ts = new Date().toISOString();
    entry.reqId = opts.reqId;
    entry.msg = msg;
    writer(JSON.stringify(entry));
  };

  return {
    debug: (msg, bindings) => emit('debug', msg, bindings),
    info: (msg, bindings) => emit('info', msg, bindings),
    warn: (msg, bindings) => emit('warn', msg, bindings),
    error: (msg, bindings) => emit('error', msg, bindings),
    child: (extra) =>
      createLogger({
        reqId: opts.reqId,
        ...(opts.writer !== undefined ? { writer: opts.writer } : {}),
        bindings: { ...baseBindings, ...stripReserved(extra) },
      }),
  };
}

function stripReserved(bindings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (bindings === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bindings)) {
    if (RESERVED_LOG_FIELDS.includes(k as (typeof RESERVED_LOG_FIELDS)[number])) continue;
    out[k] = v;
  }
  return out;
}

/**
 * An Error as a log field: name, message, `code` (when it is a string or
 * number: a PluginError code, a Node errno, a driver's SQLSTATE) and stack.
 *
 * Plus ONE level of `cause` (TASK-1028). `HookBus.call` wraps whatever a
 * service throws as `PluginError{code:'unknown', cause}`, so without the cause
 * a logged 5xx names only the hook bus. One level, not the chain: that is the
 * wrap the bus adds, and a fixed depth can't loop on a cyclic cause.
 *
 * The cause is written WITHOUT its message: `{ name, code?, plugin?,
 * hookName?, frames? }`. `frames` is its stack's `at …` lines, taken from
 * AFTER the message (a multi-line message can hold lines that look like
 * frames); when the message can't be found in the stack, no frames are
 * written. `plugin` / `hookName` are a PluginError cause's own identifiers, so
 * a fixed-text wrapper around a `bus.call` still says which hook failed. Each
 * identifier field (name, code, plugin, hookName) is capped. Some wrappers put
 * fixed text on the outside precisely because the inner message is not
 * loggable: credential-proxy's `credential-resolve-failed` carries a resolver
 * error whose message can hold an OAuth server's `error_description`. The
 * bus's own wrap already copies the inner message into its own ("service hook
 * 'x' threw: …"), so dropping it here loses nothing there. A non-Error cause
 * is dropped: it could be anything. The no-message guarantee assumes the
 * cause's `.message` is what its stack was built from; code that rewrites one
 * after the other is read can't be detected from the string.
 *
 * Reading the cause must never make the logger throw (a non-string `stack`, a
 * throwing getter): any failure while reading the cause drops the cause.
 */
function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  const code = loggableCode(err);
  if (code !== undefined) out.code = code;
  if (err.stack !== undefined) out.stack = err.stack;
  const cause = serializeCause(err);
  if (cause !== undefined) out.cause = cause;
  return out;
}

/** Cap on each identifier-like string a cause contributes to a log line. */
const CAUSE_FIELD_MAX = 100;

function serializeCause(err: Error): Record<string, unknown> | undefined {
  try {
    if (!('cause' in err) || !(err.cause instanceof Error)) return undefined;
    const cause = err.cause;
    const c: Record<string, unknown> = {};
    const name = cappedString(cause.name);
    if (name !== undefined) c.name = name;
    const code = loggableCode(cause);
    if (code !== undefined) {
      c.code = typeof code === 'string' ? clampCodeUnits(code, CAUSE_FIELD_MAX) : code;
    }
    if (cause instanceof PluginError) {
      const plugin = cappedString(cause.plugin);
      if (plugin !== undefined) c.plugin = plugin;
      const hookName = cappedString(cause.hookName);
      if (hookName !== undefined) c.hookName = hookName;
    }
    const frames = stackFrames(cause.stack, cause.message, cause.name);
    if (frames !== undefined) c.frames = frames;
    return c;
  } catch {
    return undefined;
  }
}

function cappedString(v: unknown): string | undefined {
  return typeof v === 'string' ? clampCodeUnits(v, CAUSE_FIELD_MAX) : undefined;
}

function loggableCode(err: Error): string | number | undefined {
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

/**
 * A stack's `at …` lines, never its header (`Name: message`, where the
 * message may span lines). Reads only what follows the message's text; if the
 * message isn't a string, or isn't in the stack (a rewritten stack), returns
 * nothing rather than guess where the header ends.
 */
function stackFrames(stack: unknown, message: unknown, name: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  // A non-string message (an array or object merged onto an Error) was
  // stringified into the header in a shape we can't locate reliably: no frames.
  if (typeof message !== 'string') return undefined;
  let body: string;
  if (message.length > 0) {
    const at = stack.indexOf(message);
    if (at === -1) return undefined;
    body = stack.slice(at + message.length);
  } else {
    // An empty message makes V8 write the bare name as the whole header (Node
    // does, with or without --enable-source-maps). Anything else in the first
    // line means the stack wasn't built from this message. That includes a
    // `Name: ` header: some formatters (vite's module runner) write one for an
    // empty message, but it is also exactly what a message that began with
    // `\n` leaves once blanked, and its next lines could pass for frames.
    // The two can't be told apart from the string, so neither gets frames
    // (TASK-1031).
    // An empty name is refused too: V8 then writes the message itself as the
    // header, so a blanked `\n…` message leaves an empty first line.
    const nl = stack.indexOf('\n');
    if (nl === -1 || typeof name !== 'string' || name.length === 0) return undefined;
    const header = stack.slice(0, nl);
    if (header !== name) return undefined;
    body = stack.slice(nl + 1);
  }
  const frames = body.split('\n').filter((line) => /^\s+at /.test(line));
  return frames.length > 0 ? frames.join('\n') : undefined;
}

export interface WorkspaceContext {
  // Absolute path to the workspace root. Used as the cwd for sandboxed
  // tool executions. Kept as a plain string so the shape is
  // storage/transport-agnostic (no git/volume vocabulary).
  readonly rootPath: string;
}

export type AgentContextSource = 'routine' | 'user' | 'external';
export type AgentContextAudience = 'private' | 'shared';

/** True only when a present owner is driving the turn. Fails closed. */
export function isAttendedTurn(ctx: Pick<AgentContext, 'source'>): boolean {
  const source: AgentContextSource | undefined = ctx.source;
  switch (source) {
    case undefined:
    case 'user':
      return true;
    case 'routine':
    case 'external':
      return false;
    default: {
      const _exhaustive: never = source;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * True when someone with no access to the agent may be present: `'external'`,
 * or a source this build doesn't know. Fails closed, so a gate that keeps an
 * outsider from acting for the owner (proposal tools, attended approvals)
 * refuses a value it can't place. Not the inverse of `isAttendedTurn`: a
 * routine is unattended but has no outsider in it.
 */
export function isOutsiderTurn(ctx: Pick<AgentContext, 'source'>): boolean {
  const source: AgentContextSource | undefined = ctx.source;
  switch (source) {
    case undefined:
    case 'user':
    case 'routine':
      return false;
    case 'external':
      return true;
    default: {
      const _exhaustive: never = source;
      void _exhaustive;
      return true;
    }
  }
}

/** `'private'` only when absent or exactly `'private'`; else `'shared'`. */
export function audienceOf(
  ctx: Pick<AgentContext, 'audience'>,
): AgentContextAudience {
  return ctx.audience === undefined || ctx.audience === 'private'
    ? 'private'
    : 'shared';
}

export interface AgentContext {
  readonly reqId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly userId: string;
  /**
   * Conversation this chat belongs to, when one exists. Optional because
   * not every chat-flow runs inside a persistent conversation (canary
   * acceptance tests, ephemeral admin probes). Set by chat-orchestrator in
   * Task 16 of Week 10–12; consumed today by the @ax/conversations
   * `chat:turn-end` subscriber, which gracefully no-ops when unset.
   */
  readonly conversationId?: string;
  /**
   * Origin of this context — who/what initiated the work it represents.
   * `'routine'` marks a context minted by a scheduled @ax/routines fire (a
   * hidden, non-user turn); `'user'` marks an interactive user turn. Optional
   * because most callers don't need to distinguish, and an unset value means
   * "unspecified" (treated the same as `'user'` by consumers). A subscriber
   * that must NOT act on internally-generated turns would key off this.
   * @ax/memory-strata did (it skipped its `chat:end` extraction on routine
   * fires) and was deleted in TASK-608. @ax/memory still stores routine
   * turns, but stores their rows with no conversation (TASK-616): a routine's
   * hidden conversation is not one the person had, and must not count
   * toward the skill-reflection recurrence gate. It skips a pass a
   * `memory:pre-capture` subscriber refuses (a task check-in's conversation,
   * which @ax/routines refuses whatever the pass's source, TASK-908).
   *
   * `'external'`: a person is present who has no access to the agent. The
   * turn runs as a real user who answers for it (for a channel agent,
   * whoever connected the channel). It is unattended (see
   * `isAttendedTurn`), and may make no identity or skill edits. The gates
   * that refuse it ask `isOutsiderTurn`, which refuses an unknown source too.
   *
   * Origin label only — no transport/storage vocabulary, so it stays
   * transport-agnostic per Invariant 1.
   */
  readonly source?: AgentContextSource;
  /**
   * Whose memory this turn may read and write. `'private'` (or absent) is
   * the owner's own conversation. `'shared'` is a turn other people are
   * part of (e.g. a channel): it recalls only shared statements and stores
   * no speaker facts. Host-stamped only: never taken from an IPC payload.
   * It decides memory, not approvals; instructions and files are not
   * governed by it. Must stay constant for a conversation, because memory
   * extracts a conversation in batches under the latest turn's audience.
   * An unknown value is treated as `'shared'` (see `audienceOf`).
   */
  readonly audience?: AgentContextAudience;
  /**
   * A short, human-authored label naming what initiated this work — a
   * scheduled @ax/routines fire's own `name` (e.g. "Morning email pass"),
   * for example. Set right next to `source` by whoever mints the context.
   * Optional; absent means "unlabelled" — consumers must fall back to their
   * own floor (e.g. a generic default phrase) rather than inventing a label.
   *
   * This is a display label only, never an identifier: nothing may key off
   * its value, and it carries no transport/storage vocabulary (Invariant
   * 1). It is authored by a human at creation time (a routine's name is
   * typed by the person who wrote the routine) — never generated by a
   * model, and never recoverable after the fact once the turn has started.
   */
  readonly triggerLabel?: string;
  readonly logger: Logger;
  readonly state: Map<string, unknown>;
  readonly workspace: WorkspaceContext;
}

export interface MakeAgentContextOptions {
  reqId?: string;
  sessionId: string;
  agentId: string;
  userId: string;
  /** Optional. See `AgentContext.conversationId`. */
  conversationId?: string;
  /** Optional. See `AgentContext.source`. */
  source?: AgentContextSource;
  /** Optional. See `AgentContext.audience`. */
  audience?: AgentContextAudience;
  /** Optional. See `AgentContext.triggerLabel`. */
  triggerLabel?: string;
  logger?: Logger;
  // Optional for dev ergonomics — defaults to process.cwd(). Real callers
  // (CLI boot, runner) should supply an explicit workspace.
  workspace?: WorkspaceContext;
}

export function makeAgentContext(opts: MakeAgentContextOptions): AgentContext {
  const reqId = opts.reqId ?? makeReqId();
  const logger = opts.logger ?? createLogger({ reqId });
  const workspace = opts.workspace ?? { rootPath: process.cwd() };
  return {
    reqId,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    userId: opts.userId,
    ...(opts.conversationId !== undefined
      ? { conversationId: opts.conversationId }
      : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    ...(opts.triggerLabel !== undefined ? { triggerLabel: opts.triggerLabel } : {}),
    logger,
    state: new Map(),
    workspace,
  };
}

// ---------------------------------------------------------------------------
// Owner-less sessions (TASK-411)
//
// `AgentContext.agentId` / `.userId` are required non-empty strings, but a
// session does not always have an owner: the canary and `ax serve` mint
// sessions with no (user, agent) pair, and pre-9.5 rows predate the column.
// Something still has to go in those two fields.
//
// What used to go in them was a per-transport CONSTANT — `'ipc-http'` /
// `'ipc-server'`, substituted by each listener. That is the bug this section
// exists to make unrepeatable. Agent-partitioned stores key on `agentId`
// (`sha256(JSON.stringify([agentId]))` in both @ax/memory-facts-* backends), so ONE
// literal means ONE partition shared by every owner-less session in the
// deployment, across every user. A null check does not catch it: the value is
// a perfectly good non-empty string. It just isn't anybody's.
//
// Two properties, and the reason both are needed:
//
//   1. UNIQUENESS — `ownerlessIdFor(sessionId)` is derived from the session,
//      so two owner-less sessions never collide in ANY store that partitions
//      on the id, including stores that have never heard of this helper. That
//      is the part that does not depend on a census of gates.
//   2. RECOGNISABILITY — `isOwnerlessId` lets a store that requires a real
//      owner refuse outright rather than mint a private-but-pointless
//      partition. The refusing guards listed below do exactly that.
//
// This lives in the kernel on purpose. It was previously impossible to check
// for without hard-coding another plugin's constant (Invariant 2), which is
// why some stores declined to and why two of the three guards that
// did check named `'ipc-server'` and not `'ipc-http'`. A kernel concept has
// one spelling and every package may import it.
//
// VOCABULARY: `ownerless` is ownership vocabulary, not transport or storage
// vocabulary — it says nothing about sockets, HTTP, git or SQL, so it does
// not leak a backend into the hook surface (Invariant 1).
//
// ⚠ NOT AN ACCESS CONTROL. This marks the ABSENCE of an owner; it does not
// establish the presence of one. A caller carrying a real-looking `agentId`
// is not thereby authorized to reach that agent — the `agents:resolve` ACL
// the per-agent routes run before every per-agent read is the barrier that
// decides that, and it stays load-bearing.
//
// ⚠ WHO ACTUALLY REFUSES — because "owner-less gets nothing"
// is true of the callers below and NOT of everything. (TASK-411 listed the git
// workspace backends here too; TASK-995 deleted them.)
//
//   - REFUSE: `skill.propose` and `connector_propose`, and `@ax/memory`.
//   - MERELY PARTITION: both `@ax/memory-facts-*` backends hash `agentId`
//     the same way with no gate of their own. An owner-less caller that
//     reached them directly would get a private, per-session key rather than
//     an error. Their one in-tree consumer, `@ax/memory`, refuses first
//     (`access.ts` / `owner.ts`). (The `@ax/memory-strata-index-*` backends
//     that used to sit here were deleted in TASK-608.)
//
// Partitioning is enough to stop POOLING, which is what this helper's
// uniqueness buys and why it holds in stores nobody edited. It is not enough
// to stop an owner-less caller from accumulating rows. One caveat worth
// stating rather than discovering: uniqueness is only as good as the
// sessionId, and `ax serve` lets a client CHOOSE one — two owner-less callers
// inside that one trust domain who pick the same sessionId get the same key.
// Strictly better than the single deployment-wide bucket this replaced, and
// the refusing callers fail closed regardless, but it is the reason the
// memory-index gate is a live follow-up and not a decoration.
// ---------------------------------------------------------------------------

/**
 * Reserved prefix marking an id that stands in for an owner that does not
 * exist. Minted ids never start with it: agents are `agt_<base64url>`
 * (`mintAgentId`) and users come from the auth provider, so the namespaces
 * cannot collide.
 */
export const OWNERLESS_ID_PREFIX = 'ownerless:';

/**
 * The `agentId` / `userId` to stamp on a context whose session resolved with
 * no owner. Derived from the sessionId so it is stable for the life of the
 * session (a session's own writes and reads must land in the same place) and
 * distinct between sessions (no two owner-less sessions share a partition).
 */
export function ownerlessIdFor(sessionId: string): string {
  return `${OWNERLESS_ID_PREFIX}${sessionId}`;
}

/**
 * True when `id` is a stand-in minted by `ownerlessIdFor` — i.e. the caller
 * has no owner at all. Stores that need a real owner should refuse; stores
 * that merely partition may treat it as an ordinary (private, empty) key.
 */
export function isOwnerlessId(id: string): boolean {
  return id.startsWith(OWNERLESS_ID_PREFIX);
}
