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

export function createLogger(opts: CreateLoggerOptions): Logger {
  const writer = opts.writer ?? ((line: string) => process.stdout.write(line + '\n'));
  const baseBindings: Record<string, unknown> = {
    reqId: opts.reqId,
    ...(opts.bindings ?? {}),
  };

  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    const entry: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      ...baseBindings,
      msg,
    };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        entry[k] = v instanceof Error ? serializeError(v) : v;
      }
    }
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
        bindings: { ...baseBindings, ...extra },
      }),
  };
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  if (err.stack !== undefined) out.stack = err.stack;
  return out;
}

export interface ChatContext {
  readonly reqId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly userId: string;
  readonly logger: Logger;
  readonly state: Map<string, unknown>;
}

export interface MakeChatContextOptions {
  reqId?: string;
  sessionId: string;
  agentId: string;
  userId: string;
  logger?: Logger;
}

export function makeChatContext(opts: MakeChatContextOptions): ChatContext {
  const reqId = opts.reqId ?? makeReqId();
  const logger = opts.logger ?? createLogger({ reqId });
  return {
    reqId,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    userId: opts.userId,
    logger,
    state: new Map(),
  };
}
