import { randomBytes } from 'node:crypto';

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

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  if (err.stack !== undefined) out.stack = err.stack;
  return out;
}

export interface WorkspaceContext {
  // Absolute path to the workspace root. Used as the cwd for sandboxed
  // tool executions. Kept as a plain string so the shape is
  // storage/transport-agnostic (no git/volume vocabulary).
  readonly rootPath: string;
}

export interface ChatContext {
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
  readonly logger: Logger;
  readonly state: Map<string, unknown>;
  readonly workspace: WorkspaceContext;
}

export interface MakeChatContextOptions {
  reqId?: string;
  sessionId: string;
  agentId: string;
  userId: string;
  /** Optional. See `ChatContext.conversationId`. */
  conversationId?: string;
  logger?: Logger;
  // Optional for dev ergonomics — defaults to process.cwd(). Real callers
  // (CLI boot, runner) should supply an explicit workspace.
  workspace?: WorkspaceContext;
}

export function makeChatContext(opts: MakeChatContextOptions): ChatContext {
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
    logger,
    state: new Map(),
    workspace,
  };
}
