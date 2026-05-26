# Kernel: Hook Bus + Chat Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up `@ax/core` (hook bus, `ChatContext`, error types, bootstrap, orchestration loop registered as `chat:run`) and `@ax/test-harness` (`createTestHarness`, `MockServices.basics`), such that calling `chat:run` with no LLM plugin loaded returns a clean, structured `{ kind: 'terminated', reason: 'no-service:llm:call' }` outcome. Fully tested.

**Architecture:** Two packages: `@ax/core` owns the hook bus (two flavors), `ChatContext`, `PluginError`, a `Plugin` manifest type, `Bootstrap` (load + init + validate), and the orchestration loop itself registered as `chat:run`. `@ax/test-harness` owns `createTestHarness` (spins up a bus + runs bootstrap in-memory) and `MockServices.basics` (reusable no-op fakes). Deferred to a later slice: IPC primitives, structured logger (stub with console for now), real plugins.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, zod (for plugin manifest validation and future hook return validation), pnpm workspaces, tsconfig project refs, changesets.

**Resolved ambiguities from the design doc:**

1. **Two hook primitives on the bus:** `hooks.call(hookName, ctx, payload)` for service hooks (single producer; error if zero or more-than-one registered), `hooks.fire(hookName, ctx, payload)` for subscriber hooks (many-to-many; chain of subscribers).
2. **Subscriber chaining:** each subscriber returns the (possibly-modified) payload, `undefined` (meaning pass-through), or `reject({ reason })`. `fire` returns a `FireResult<P>`: `{ rejected: false; payload: P } | { rejected: true; reason: string; source: string }`. `source` is the plugin name that rejected. Rejection short-circuits the chain.
3. **Observer vs transformer subscribers:** same primitive. Observers just don't return a payload (pass-through). No separate "observer" API.
4. **Subscriber exceptions are isolated:** caught, logged, chain continues with the prior payload. (Design doc Section 10 failure table.)
5. **Service-hook exceptions propagate:** wrapped in `PluginError` with `cause`, thrown from `hooks.call`.
6. **Missing service hook error shape:** `hooks.call('llm:call', ...)` when no plugin is registered throws `PluginError` with `code: 'no-service'`; the orchestration loop catches this and returns `{ kind: 'terminated', reason: 'no-service:llm:call' }`.
7. **`chat:run` is registered by core itself** (Section 7), so the orchestration loop is reached via `hooks.call('chat:run', ...)` uniformly whether the caller is a channel plugin or a test.
8. **Logger:** stub for this slice — a thin `createLogger({ reqId })` that wraps `console` with structured JSON. Real pino-style logger deferred.
9. **IPC primitives:** explicitly deferred. Not required to achieve the Week 1–2 goal. Will be added when the first sandbox plugin needs them.
10. **Plugin manifest:** a Zod schema validated at load. Fields: `name`, `version`, `registers: string[]`, `calls: string[]`, `subscribes: string[]`. A `Plugin` exports both a manifest and an `init(ctx)` function that registers hooks.

**Invariants enforced by this slice (per CLAUDE.md):**
- Hook surface is transport- and storage-agnostic. (Nothing in this slice names a storage or transport.)
- No cross-plugin imports. (This slice has no plugins other than the core-internal `chat:run` producer.)
- No half-wired plugins. (All code lands wired and tested, or doesn't land.)
- One source of truth per concept. (Hook registry is the sole inter-plugin channel.)

**Branch policy:** this plan must be executed on a feature branch (e.g., `feat/kernel-hook-bus`), not `main`. The executor will create it before Task 1.

---

## Layout after this plan

```
ax-next/
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── src/
│   │   │   ├── index.ts                  — re-exports public API
│   │   │   ├── errors.ts                 — PluginError, reject()
│   │   │   ├── context.ts                — ChatContext, makeReqId, createLogger
│   │   │   ├── hook-bus.ts               — HookBus class: register, subscribe, call, fire
│   │   │   ├── plugin.ts                 — Plugin type, manifest Zod schema
│   │   │   ├── bootstrap.ts              — loadPlugins: validates manifests, runs init, cycle + missing-service checks
│   │   │   ├── chat-loop.ts              — orchestration loop, registered as chat:run
│   │   │   └── types.ts                  — ChatMessage, ToolCall, ChatOutcome, LlmRequest, LlmResponse, FireResult
│   │   └── src/__tests__/
│   │       ├── errors.test.ts
│   │       ├── context.test.ts
│   │       ├── hook-bus.test.ts
│   │       ├── bootstrap.test.ts
│   │       ├── chat-loop.test.ts
│   │       └── acceptance.test.ts        — the "no llm registered" end-to-end check
│   └── test-harness/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── src/
│       │   ├── index.ts
│       │   ├── harness.ts                — createTestHarness
│       │   └── mock-services.ts          — MockServices.basics
│       └── src/__tests__/
│           └── harness.test.ts
├── tsconfig.json                          — updated references
└── pnpm-workspace.yaml                    — already includes packages/*
```

---

## Task 1: Feature branch + `@ax/core` package scaffold

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Create feature branch**

```bash
git checkout -b feat/kernel-hook-bus
```

**Step 2: Write `packages/core/package.json`**

```json
{
  "name": "@ax/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 3: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"]
}
```

**Step 4: Write `packages/core/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

**Step 5: Stub `packages/core/src/index.ts`**

```ts
export {};
```

**Step 6: Add reference in root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [{ "path": "packages/core" }]
}
```

**Step 7: Install + build + verify**

```bash
pnpm install
pnpm --filter @ax/core build
```

Expected: builds without error, produces `packages/core/dist/index.js`.

**Step 8: Commit**

```bash
git add packages/core tsconfig.json pnpm-lock.yaml
git commit -m "feat(core): scaffold @ax/core package"
```

---

## Task 2: `PluginError` + `reject` helper

**Files:**
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/__tests__/errors.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test** (`packages/core/src/__tests__/errors.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { PluginError, reject, isRejection } from '../errors.js';

describe('PluginError', () => {
  it('captures code, plugin, and cause', () => {
    const cause = new Error('underlying');
    const err = new PluginError({
      code: 'no-service',
      plugin: 'core',
      message: 'no plugin registered for llm:call',
      cause,
    });
    expect(err.code).toBe('no-service');
    expect(err.plugin).toBe('core');
    expect(err.message).toBe('no plugin registered for llm:call');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('serializes for logging', () => {
    const err = new PluginError({
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
    });
    expect(err.toJSON()).toMatchObject({
      name: 'PluginError',
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
    });
  });
});

describe('reject', () => {
  it('returns a rejection sentinel', () => {
    const r = reject({ reason: 'secret detected' });
    expect(isRejection(r)).toBe(true);
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('secret detected');
  });

  it('isRejection returns false for ordinary objects', () => {
    expect(isRejection({ foo: 'bar' })).toBe(false);
    expect(isRejection(null)).toBe(false);
    expect(isRejection(undefined)).toBe(false);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @ax/core test
```
Expected: FAIL (`../errors.js` not found).

**Step 3: Implement `packages/core/src/errors.ts`**

```ts
export type PluginErrorCode =
  | 'no-service'
  | 'duplicate-service'
  | 'timeout'
  | 'invalid-payload'
  | 'invalid-manifest'
  | 'cycle'
  | 'missing-service'
  | 'init-failed'
  | 'subscriber-failed'
  | 'unknown';

export interface PluginErrorOptions {
  code: PluginErrorCode;
  plugin: string;
  message: string;
  cause?: unknown;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly plugin: string;

  constructor(opts: PluginErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PluginError';
    this.code = opts.code;
    this.plugin = opts.plugin;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      plugin: this.plugin,
      message: this.message,
    };
  }
}

export interface Rejection {
  readonly rejected: true;
  readonly reason: string;
  readonly source?: string;
}

export function reject(opts: { reason: string; source?: string }): Rejection {
  const r: Rejection = opts.source !== undefined
    ? { rejected: true, reason: opts.reason, source: opts.source }
    : { rejected: true, reason: opts.reason };
  return r;
}

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { rejected?: unknown }).rejected === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}
```

**Step 4: Update `packages/core/src/index.ts`**

```ts
export * from './errors.js';
```

**Step 5: Run the test to verify it passes**

```bash
pnpm --filter @ax/core test
```
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add PluginError and reject() helper"
```

---

## Task 3: `ChatContext`, `makeReqId`, `createLogger`

**Files:**
- Create: `packages/core/src/context.ts`
- Create: `packages/core/src/__tests__/context.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test** (`packages/core/src/__tests__/context.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeReqId, createLogger, makeChatContext } from '../context.js';

describe('makeReqId', () => {
  it('generates a unique, readable id', () => {
    const a = makeReqId();
    const b = makeReqId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^req-[a-z0-9]+$/);
  });
});

describe('createLogger', () => {
  it('binds reqId into every log entry', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-abc',
      writer: (line) => out.push(line),
    });
    logger.info('hello', { a: 1 });
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({
      level: 'info',
      reqId: 'req-abc',
      msg: 'hello',
      a: 1,
    });
  });

  it('logs at error level with serialized Error', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-xyz',
      writer: (line) => out.push(line),
    });
    logger.error('boom', { err: new Error('bang') });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.level).toBe('error');
    expect(parsed.err).toMatchObject({ name: 'Error', message: 'bang' });
  });

  it('child() adds bindings without losing parent bindings', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-1',
      writer: (line) => out.push(line),
    });
    const child = logger.child({ plugin: 'llm-anthropic' });
    child.info('x');
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({
      reqId: 'req-1',
      plugin: 'llm-anthropic',
      msg: 'x',
    });
  });
});

describe('makeChatContext', () => {
  it('carries the expected identity fields', () => {
    const ctx = makeChatContext({
      reqId: 'req-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.reqId).toBe('req-1');
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.agentId).toBe('agent-1');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.state).toEqual(new Map());
    expect(typeof ctx.logger.info).toBe('function');
  });

  it('generates a reqId when not supplied', () => {
    const ctx = makeChatContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.reqId).toMatch(/^req-/);
  });
});
```

**Step 2: Run test → FAIL**

```bash
pnpm --filter @ax/core test
```

**Step 3: Implement `packages/core/src/context.ts`**

```ts
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
```

**Step 4: Re-export from `packages/core/src/index.ts`**

```ts
export * from './errors.js';
export * from './context.js';
```

**Step 5: Run test → PASS**

```bash
pnpm --filter @ax/core test
```

**Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add ChatContext, makeReqId, createLogger"
```

---

## Task 4: Core type stubs (`ChatMessage`, `ToolCall`, `LlmRequest`, `LlmResponse`, `ChatOutcome`, `FireResult`)

**Files:**
- Create: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

No test file — these are pure type declarations. Types are exercised through later tasks.

**Step 1: Write `packages/core/src/types.ts`**

```ts
import type { Rejection } from './errors.js';

export interface ChatMessageText {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
export type ChatMessage = ChatMessageText;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
}

export interface LlmResponse {
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
}

export interface ToolDescriptor {
  name: string;
  description?: string;
}

export type ChatOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown };

export type FireResult<P> =
  | { rejected: false; payload: P }
  | (Rejection & { rejected: true });
```

**Step 2: Re-export**

```ts
// packages/core/src/index.ts
export * from './errors.js';
export * from './context.js';
export * from './types.js';
```

**Step 3: Typecheck**

```bash
pnpm --filter @ax/core build
```
Expected: no errors.

**Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): add public type stubs (ChatMessage, ToolCall, ChatOutcome, FireResult)"
```

---

## Task 5: Hook bus — service hooks (`register`, `call`)

**Files:**
- Create: `packages/core/src/hook-bus.ts`
- Create: `packages/core/src/__tests__/hook-bus.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test** (`packages/core/src/__tests__/hook-bus.test.ts`, service section only — we add subscriber tests in Task 6)

```ts
import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { PluginError } from '../errors.js';
import { makeChatContext } from '../context.js';

const silentCtx = () => {
  const ctx = makeChatContext({
    sessionId: 's', agentId: 'a', userId: 'u',
  });
  (ctx.logger as unknown as { info: () => void }).info = () => {};
  (ctx.logger as unknown as { error: () => void }).error = () => {};
  (ctx.logger as unknown as { warn: () => void }).warn = () => {};
  (ctx.logger as unknown as { debug: () => void }).debug = () => {};
  return ctx;
};

describe('HookBus — service hooks', () => {
  it('register + call returns the handler result', async () => {
    const bus = new HookBus();
    bus.registerService('greet', 'greeter', async (_ctx, { name }: { name: string }) => ({
      text: `hello ${name}`,
    }));

    const result = await bus.call<{ name: string }, { text: string }>(
      'greet',
      silentCtx(),
      { name: 'world' },
    );
    expect(result).toEqual({ text: 'hello world' });
  });

  it('call on an unregistered service throws PluginError{code:"no-service"}', async () => {
    const bus = new HookBus();
    await expect(bus.call('missing', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      code: 'no-service',
    });
  });

  it('duplicate registerService throws PluginError{code:"duplicate-service"}', () => {
    const bus = new HookBus();
    bus.registerService('svc', 'plugin-a', async () => 1);
    expect(() => bus.registerService('svc', 'plugin-b', async () => 2)).toThrow(PluginError);
  });

  it('service handler that throws propagates as PluginError with cause', async () => {
    const bus = new HookBus();
    bus.registerService('boom', 'boomer', async () => {
      throw new Error('bang');
    });
    await expect(bus.call('boom', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      plugin: 'boomer',
    });
  });

  it('hasService reflects registration', () => {
    const bus = new HookBus();
    expect(bus.hasService('x')).toBe(false);
    bus.registerService('x', 'p', async () => 0);
    expect(bus.hasService('x')).toBe(true);
  });
});
```

**Step 2: Run → FAIL**

```bash
pnpm --filter @ax/core test
```

**Step 3: Implement `packages/core/src/hook-bus.ts` (service portion only)**

```ts
import type { ChatContext } from './context.js';
import { PluginError } from './errors.js';

export type ServiceHandler<I = unknown, O = unknown> = (
  ctx: ChatContext,
  input: I,
) => Promise<O>;

interface RegisteredService {
  plugin: string;
  handler: ServiceHandler;
}

export class HookBus {
  private services = new Map<string, RegisteredService>();

  registerService<I, O>(hookName: string, plugin: string, handler: ServiceHandler<I, O>): void {
    const existing = this.services.get(hookName);
    if (existing !== undefined) {
      throw new PluginError({
        code: 'duplicate-service',
        plugin,
        message: `service hook '${hookName}' already registered by plugin '${existing.plugin}'`,
      });
    }
    this.services.set(hookName, { plugin, handler: handler as ServiceHandler });
  }

  hasService(hookName: string): boolean {
    return this.services.has(hookName);
  }

  async call<I, O>(hookName: string, ctx: ChatContext, input: I): Promise<O> {
    const registered = this.services.get(hookName);
    if (registered === undefined) {
      throw new PluginError({
        code: 'no-service',
        plugin: 'core',
        message: `no plugin registered for service hook '${hookName}'`,
      });
    }
    try {
      return (await registered.handler(ctx, input)) as O;
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError({
        code: 'unknown',
        plugin: registered.plugin,
        message: `service hook '${hookName}' threw: ${(err as Error).message ?? String(err)}`,
        cause: err,
      });
    }
  }
}
```

**Step 4: Re-export**

```ts
// packages/core/src/index.ts — append:
export * from './hook-bus.js';
```

**Step 5: Run → PASS**

```bash
pnpm --filter @ax/core test
```

**Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): HookBus service hooks (register, call)"
```

---

## Task 6: Hook bus — subscriber hooks (`subscribe`, `fire`)

**Files:**
- Modify: `packages/core/src/hook-bus.ts`
- Modify: `packages/core/src/__tests__/hook-bus.test.ts` (append)

**Step 1: Write the failing tests (append to existing file)**

```ts
import type { FireResult } from '../types.js';
import { isRejection, reject } from '../errors.js';

describe('HookBus — subscriber hooks', () => {
  it('fire with no subscribers returns payload unchanged', async () => {
    const bus = new HookBus();
    const res = await bus.fire<{ x: number }>('h', silentCtx(), { x: 1 });
    expect(res).toEqual({ rejected: false, payload: { x: 1 } });
  });

  it('subscribers run in registration order', async () => {
    const bus = new HookBus();
    const calls: string[] = [];
    bus.subscribe('h', 'a', async () => { calls.push('a'); return undefined; });
    bus.subscribe('h', 'b', async () => { calls.push('b'); return undefined; });
    await bus.fire('h', silentCtx(), {});
    expect(calls).toEqual(['a', 'b']);
  });

  it('returning a modified payload chains into the next subscriber', async () => {
    const bus = new HookBus();
    bus.subscribe<{ n: number }>('h', 'inc', async (_ctx, p) => ({ n: p.n + 1 }));
    bus.subscribe<{ n: number }>('h', 'dbl', async (_ctx, p) => ({ n: p.n * 2 }));
    const res = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 4 } });
  });

  it('returning undefined is pass-through', async () => {
    const bus = new HookBus();
    bus.subscribe<{ n: number }>('h', 'noop', async () => undefined);
    bus.subscribe<{ n: number }>('h', 'inc', async (_ctx, p) => ({ n: p.n + 1 }));
    const res = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 2 } });
  });

  it('reject short-circuits the chain and fills in source', async () => {
    const bus = new HookBus();
    let bCalled = false;
    bus.subscribe('h', 'a', async () => reject({ reason: 'blocked' }));
    bus.subscribe('h', 'b', async () => { bCalled = true; return undefined; });
    const res = await bus.fire('h', silentCtx(), {});
    expect(bCalled).toBe(false);
    expect(res).toMatchObject({ rejected: true, reason: 'blocked', source: 'a' });
    expect(isRejection(res)).toBe(true);
  });

  it('subscriber throw is isolated: logged, chain continues', async () => {
    const bus = new HookBus();
    const logs: Array<{ level: string; msg: string; bindings?: unknown }> = [];
    const ctx = makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    (ctx.logger as unknown as Record<string, unknown>).error = (msg: string, b: unknown) =>
      logs.push({ level: 'error', msg, bindings: b });
    (ctx.logger as unknown as Record<string, unknown>).info = () => {};
    (ctx.logger as unknown as Record<string, unknown>).warn = () => {};
    (ctx.logger as unknown as Record<string, unknown>).debug = () => {};
    bus.subscribe<{ n: number }>('h', 'bad', async () => { throw new Error('oops'); });
    bus.subscribe<{ n: number }>('h', 'good', async (_ctx, p) => ({ n: p.n + 1 }));
    const res = await bus.fire<{ n: number }>('h', ctx, { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 2 } });
    expect(logs.find(l => l.level === 'error')).toBeDefined();
  });

  it('FireResult type: consumers can discriminate via .rejected', async () => {
    const bus = new HookBus();
    bus.subscribe('h', 'a', async () => reject({ reason: 'nope' }));
    const res: FireResult<{ n: number }> = await bus.fire('h', silentCtx(), { n: 1 });
    if (res.rejected) {
      expect(res.reason).toBe('nope');
    } else {
      throw new Error('should be rejected');
    }
  });
});
```

**Step 2: Run → FAIL**

```bash
pnpm --filter @ax/core test
```

**Step 3: Add subscriber support to `packages/core/src/hook-bus.ts`**

```ts
// add to imports:
import { isRejection } from './errors.js';
import type { FireResult } from './types.js';

// add types:
export type SubscriberHandler<P = unknown> = (
  ctx: ChatContext,
  payload: P,
) => Promise<P | undefined | import('./errors.js').Rejection>;

interface RegisteredSubscriber {
  plugin: string;
  handler: SubscriberHandler;
}

// extend the class:
export class HookBus {
  private services = new Map<string, RegisteredService>();
  private subscribers = new Map<string, RegisteredSubscriber[]>();

  // ...existing service methods...

  subscribe<P>(hookName: string, plugin: string, handler: SubscriberHandler<P>): void {
    const list = this.subscribers.get(hookName) ?? [];
    list.push({ plugin, handler: handler as SubscriberHandler });
    this.subscribers.set(hookName, list);
  }

  async fire<P>(hookName: string, ctx: ChatContext, payload: P): Promise<FireResult<P>> {
    const list = this.subscribers.get(hookName) ?? [];
    let current: P = payload;
    for (const sub of list) {
      let result: P | undefined | import('./errors.js').Rejection;
      try {
        result = await sub.handler(ctx, current);
      } catch (err) {
        ctx.logger.error('hook_subscriber_failed', {
          hook: hookName,
          plugin: sub.plugin,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        continue;
      }
      if (isRejection(result)) {
        return { rejected: true, reason: result.reason, source: sub.plugin };
      }
      if (result !== undefined) {
        current = result as P;
      }
    }
    return { rejected: false, payload: current };
  }
}
```

**Step 4: Run → PASS**

```bash
pnpm --filter @ax/core test
```

**Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): HookBus subscriber hooks (subscribe, fire) with rejection + isolation"
```

---

## Task 7: Chat orchestration loop registered as `chat:run`

**Files:**
- Create: `packages/core/src/chat-loop.ts`
- Create: `packages/core/src/__tests__/chat-loop.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/chat-loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { registerChatLoop } from '../chat-loop.js';
import { makeChatContext } from '../context.js';
import type { ChatMessage, ChatOutcome, LlmRequest, LlmResponse, ToolCall } from '../types.js';
import { reject } from '../errors.js';

const ctx = () => {
  const c = makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  for (const k of ['info', 'error', 'warn', 'debug']) {
    (c.logger as unknown as Record<string, unknown>)[k] = () => {};
  }
  return c;
};

describe('chat:run', () => {
  it('returns terminated with reason no-service:llm:call when llm:call is not registered', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('no-service:llm:call');
    }
  });

  it('completes a single turn with a registered llm:call (no tool calls)', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => ({
      assistantMessage: { role: 'assistant', content: 'hello' },
      toolCalls: [],
    }));
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run',
      ctx(),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      expect(outcome.messages).toHaveLength(2);
      expect(outcome.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
    }
  });

  it('fires chat:start and chat:end subscribers', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => ({
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [],
    }));
    const events: string[] = [];
    bus.subscribe('chat:start', 'obs', async () => { events.push('start'); return undefined; });
    bus.subscribe('chat:end', 'obs', async () => { events.push('end'); return undefined; });
    await bus.call('chat:run', ctx(), { message: { role: 'user', content: 'hi' } });
    expect(events).toEqual(['start', 'end']);
  });

  it('llm:pre-call subscriber can transform the request', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    let seen: LlmRequest | undefined;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async (_ctx, req) => {
      seen = req;
      return { assistantMessage: { role: 'assistant', content: 'ok' }, toolCalls: [] };
    });
    bus.subscribe<LlmRequest>('llm:pre-call', 'prep', async (_ctx, p) => ({
      ...p,
      messages: [...p.messages, { role: 'system', content: 'injected' }],
    }));
    await bus.call('chat:run', ctx(), { message: { role: 'user', content: 'hi' } });
    expect(seen?.messages.some(m => m.role === 'system' && m.content === 'injected')).toBe(true);
  });

  it('tool:pre-call rejection skips the tool and appends a rejection message', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const toolCall: ToolCall = { id: 't1', name: 'bash', input: { cmd: 'rm -rf /' } };
    let llmCalls = 0;
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return { assistantMessage: { role: 'assistant', content: '' }, toolCalls: [toolCall] };
      }
      return { assistantMessage: { role: 'assistant', content: 'done' }, toolCalls: [] };
    });
    bus.subscribe('tool:pre-call', 'security', async () => reject({ reason: 'bash is blocked' }));
    let toolExecCalled = false;
    bus.registerService('tool:execute', 'tools', async () => {
      toolExecCalled = true;
      return { output: 'x' };
    });
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run', ctx(), { message: { role: 'user', content: 'do it' } },
    );
    expect(toolExecCalled).toBe(false);
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      const rejectionMsg = outcome.messages.find(m => m.content.includes('bash is blocked'));
      expect(rejectionMsg).toBeDefined();
    }
  });

  it('service-hook error inside chat:run is classified in outcome.reason', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    bus.registerService<LlmRequest, LlmResponse>('llm:call', 'llm-fake', async () => {
      throw new Error('upstream down');
    });
    const outcome = await bus.call<{ message: ChatMessage }, ChatOutcome>(
      'chat:run', ctx(), { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
  });
});
```

**Step 2: Run → FAIL**

**Step 3: Implement `packages/core/src/chat-loop.ts`**

```ts
import type { HookBus } from './hook-bus.js';
import type { ChatContext } from './context.js';
import type {
  ChatMessage,
  ChatOutcome,
  LlmRequest,
  LlmResponse,
  ToolCall,
} from './types.js';
import { PluginError } from './errors.js';

interface ChatRunInput {
  message: ChatMessage;
}

export function registerChatLoop(bus: HookBus): void {
  bus.registerService<ChatRunInput, ChatOutcome>(
    'chat:run',
    'core',
    async (ctx, { message }) => runChat(bus, ctx, message),
  );
}

async function runChat(
  bus: HookBus,
  ctx: ChatContext,
  message: ChatMessage,
): Promise<ChatOutcome> {
  const startResult = await bus.fire('chat:start', ctx, { message });
  if (startResult.rejected) {
    const outcome: ChatOutcome = {
      kind: 'terminated',
      reason: `chat:start:${startResult.reason}`,
    };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  }

  const messages: ChatMessage[] = [message];

  try {
    while (true) {
      const pre = await bus.fire<LlmRequest>('llm:pre-call', ctx, {
        messages: [...messages],
      });
      if (pre.rejected) {
        return await terminate(bus, ctx, `llm:pre-call:${pre.reason}`);
      }

      const response = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx, pre.payload);

      const post = await bus.fire<LlmResponse>('llm:post-call', ctx, response);
      if (post.rejected) {
        return await terminate(bus, ctx, `llm:post-call:${post.reason}`);
      }

      messages.push(post.payload.assistantMessage);
      if (post.payload.toolCalls.length === 0) break;

      for (const toolCall of post.payload.toolCalls) {
        const pre = await bus.fire<ToolCall>('tool:pre-call', ctx, toolCall);
        if (pre.rejected) {
          messages.push({
            role: 'user',
            content: `tool '${toolCall.name}' rejected: ${pre.reason}`,
          });
          continue;
        }
        let output: unknown;
        try {
          output = await bus.call('tool:execute', ctx, pre.payload);
        } catch (err) {
          if (err instanceof PluginError && err.code === 'no-service') {
            return await terminate(bus, ctx, `no-service:tool:execute`);
          }
          throw err;
        }
        const postTool = await bus.fire('tool:post-call', ctx, { toolCall, output });
        const finalOutput = postTool.rejected ? output : (postTool.payload as { output: unknown }).output;
        messages.push({
          role: 'user',
          content: `[tool ${toolCall.name}] ${JSON.stringify(finalOutput)}`,
        });
      }
    }

    const outcome: ChatOutcome = { kind: 'complete', messages };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  } catch (err) {
    const reason = classify(err);
    const outcome: ChatOutcome = { kind: 'terminated', reason, error: err };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  }
}

async function terminate(bus: HookBus, ctx: ChatContext, reason: string): Promise<ChatOutcome> {
  const outcome: ChatOutcome = { kind: 'terminated', reason };
  await bus.fire('chat:end', ctx, { outcome });
  return outcome;
}

function classify(err: unknown): string {
  if (err instanceof PluginError) {
    if (err.code === 'no-service') return `no-service:${extractServiceName(err.message)}`;
    return `plugin-error:${err.code}`;
  }
  return 'unknown';
}

function extractServiceName(message: string): string {
  const match = message.match(/'([^']+)'/);
  return match ? match[1]! : 'unknown';
}
```

**Step 4: Re-export + run → PASS**

```ts
// packages/core/src/index.ts — append:
export { registerChatLoop } from './chat-loop.js';
```

```bash
pnpm --filter @ax/core test
```

**Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): chat:run orchestration loop with start/end/pre/post hooks"
```

---

## Task 8: Plugin manifest type + Zod schema

**Files:**
- Create: `packages/core/src/plugin.ts`
- Modify: `packages/core/src/index.ts`
- (tests deferred to Task 9 which exercises this through bootstrap)

**Step 1: Write `packages/core/src/plugin.ts`**

```ts
import { z } from 'zod';
import type { HookBus } from './hook-bus.js';

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  registers: z.array(z.string()).default([]),
  calls: z.array(z.string()).default([]),
  subscribes: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PluginInitContext {
  bus: HookBus;
  config: unknown;
}

export interface Plugin {
  manifest: PluginManifest;
  init(ctx: PluginInitContext): Promise<void> | void;
}
```

**Step 2: Re-export**

```ts
// packages/core/src/index.ts — append:
export * from './plugin.js';
```

**Step 3: Typecheck**

```bash
pnpm --filter @ax/core build
```

**Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): Plugin manifest type and Zod schema"
```

---

## Task 9: Bootstrap — load plugins, run init, validate missing services + cycles

**Files:**
- Create: `packages/core/src/bootstrap.ts`
- Create: `packages/core/src/__tests__/bootstrap.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing tests**

```ts
// packages/core/src/__tests__/bootstrap.test.ts
import { describe, it, expect } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { HookBus } from '../hook-bus.js';
import type { Plugin } from '../plugin.js';

const makePlugin = (m: Partial<Plugin['manifest']> & { name: string }, init?: Plugin['init']): Plugin => ({
  manifest: {
    version: '0.0.0',
    registers: [],
    calls: [],
    subscribes: [],
    ...m,
  },
  init: init ?? (() => {}),
});

describe('bootstrap', () => {
  it('calls init on every plugin with a shared bus', async () => {
    const called: string[] = [];
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        makePlugin({ name: 'a' }, () => { called.push('a'); }),
        makePlugin({ name: 'b' }, () => { called.push('b'); }),
      ],
      config: {},
    });
    expect(called).toEqual(['a', 'b']);
  });

  it('rejects invalid manifest with PluginError{code:"invalid-manifest"}', async () => {
    const badPlugin = { manifest: { name: '' }, init: () => {} } as unknown as Plugin;
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [badPlugin], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-manifest' });
  });

  it('fails with missing-service when a plugin calls a hook nobody registers', async () => {
    const plugin = makePlugin({ name: 'user', calls: ['storage:get'] });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [plugin], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'missing-service' });
  });

  it('passes when the declared call is satisfied by another plugin', async () => {
    const provider = makePlugin(
      { name: 'provider', registers: ['storage:get'] },
      ({ bus }) => { bus.registerService('storage:get', 'provider', async () => 'v'); },
    );
    const consumer = makePlugin({ name: 'consumer', calls: ['storage:get'] });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [provider, consumer], config: {} }),
    ).resolves.toBeUndefined();
  });

  it('detects cycles in declared calls', async () => {
    const a = makePlugin({
      name: 'a', registers: ['a:do'], calls: ['b:do'],
    }, ({ bus }) => bus.registerService('a:do', 'a', async () => 0));
    const b = makePlugin({
      name: 'b', registers: ['b:do'], calls: ['a:do'],
    }, ({ bus }) => bus.registerService('b:do', 'b', async () => 0));
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'cycle' });
  });

  it('wraps init errors as PluginError{code:"init-failed"}', async () => {
    const bad = makePlugin({ name: 'bad' }, () => { throw new Error('oops'); });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [bad], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'init-failed', plugin: 'bad' });
  });
});
```

**Step 2: Run → FAIL**

**Step 3: Implement `packages/core/src/bootstrap.ts`**

```ts
import type { HookBus } from './hook-bus.js';
import { PluginError } from './errors.js';
import { PluginManifestSchema, type Plugin } from './plugin.js';

export interface BootstrapOptions {
  bus: HookBus;
  plugins: Plugin[];
  config: Record<string, unknown>;
}

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  const { bus, plugins, config } = opts;

  for (const p of plugins) {
    const parsed = PluginManifestSchema.safeParse(p.manifest);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-manifest',
        plugin: p.manifest?.name ?? 'unknown',
        message: `invalid plugin manifest: ${parsed.error.message}`,
        cause: parsed.error,
      });
    }
  }

  detectCycles(plugins);

  for (const p of plugins) {
    try {
      await p.init({ bus, config: (config as Record<string, unknown>)[p.manifest.name] });
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError({
        code: 'init-failed',
        plugin: p.manifest.name,
        message: `plugin '${p.manifest.name}' init failed: ${(err as Error).message ?? String(err)}`,
        cause: err,
      });
    }
  }

  verifyCalls(plugins, bus);
}

function detectCycles(plugins: Plugin[]): void {
  const producers = new Map<string, string>();
  for (const p of plugins) {
    for (const r of p.manifest.registers) {
      const existing = producers.get(r);
      if (existing !== undefined && existing !== p.manifest.name) {
        throw new PluginError({
          code: 'duplicate-service',
          plugin: p.manifest.name,
          message: `service hook '${r}' registered by both '${existing}' and '${p.manifest.name}'`,
        });
      }
      producers.set(r, p.manifest.name);
    }
  }

  const graph = new Map<string, string[]>();
  for (const p of plugins) {
    const out: string[] = [];
    for (const c of p.manifest.calls) {
      const prod = producers.get(c);
      if (prod !== undefined && prod !== p.manifest.name) out.push(prod);
    }
    graph.set(p.manifest.name, out);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (node: string, stack: string[]): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      const cycle = stack.slice(cycleStart).concat(node).join(' → ');
      throw new PluginError({
        code: 'cycle',
        plugin: node,
        message: `plugin call cycle detected: ${cycle}`,
      });
    }
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      visit(next, [...stack, node]);
    }
    visiting.delete(node);
    done.add(node);
  };

  for (const name of graph.keys()) visit(name, []);
}

function verifyCalls(plugins: Plugin[], bus: HookBus): void {
  for (const p of plugins) {
    for (const hook of p.manifest.calls) {
      if (!bus.hasService(hook)) {
        throw new PluginError({
          code: 'missing-service',
          plugin: p.manifest.name,
          message: `plugin '${p.manifest.name}' declares calls:['${hook}'] but no plugin registers it`,
        });
      }
    }
  }
}
```

**Step 4: Re-export + run → PASS**

```ts
// packages/core/src/index.ts — append:
export * from './bootstrap.js';
```

```bash
pnpm --filter @ax/core test
```

**Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): bootstrap with manifest validation, cycle detection, missing-service check"
```

---

## Task 10: `@ax/test-harness` package scaffold

**Files:**
- Create: `packages/test-harness/package.json`
- Create: `packages/test-harness/tsconfig.json`
- Create: `packages/test-harness/vitest.config.ts`
- Create: `packages/test-harness/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Write `packages/test-harness/package.json`**

```json
{
  "name": "@ax/test-harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 2: Write `packages/test-harness/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

**Step 3: Write `packages/test-harness/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

**Step 4: Stub `packages/test-harness/src/index.ts`**

```ts
export {};
```

**Step 5: Update root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/test-harness" }
  ]
}
```

**Step 6: Install + build**

```bash
pnpm install
pnpm build
```

Expected: both packages build.

**Step 7: Commit**

```bash
git add packages/test-harness tsconfig.json pnpm-lock.yaml
git commit -m "feat(test-harness): scaffold @ax/test-harness package"
```

---

## Task 11: `createTestHarness` + `MockServices.basics`

**Files:**
- Create: `packages/test-harness/src/harness.ts`
- Create: `packages/test-harness/src/mock-services.ts`
- Create: `packages/test-harness/src/__tests__/harness.test.ts`
- Modify: `packages/test-harness/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/test-harness/src/__tests__/harness.test.ts
import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '../index.js';
import type { Plugin } from '@ax/core';

describe('createTestHarness', () => {
  it('provides a bus and a ctx factory', async () => {
    const h = await createTestHarness({});
    expect(h.bus).toBeDefined();
    const ctx = h.ctx();
    expect(ctx.reqId).toMatch(/^req-/);
  });

  it('loads additional plugins passed in', async () => {
    let initCalled = false;
    const p: Plugin = {
      manifest: { name: 'p', version: '0.0.0', registers: [], calls: [], subscribes: [] },
      init: () => { initCalled = true; },
    };
    const h = await createTestHarness({ plugins: [p] });
    expect(initCalled).toBe(true);
    expect(h.bus).toBeDefined();
  });

  it('registers MockServices.basics when requested', async () => {
    const h = await createTestHarness({ services: MockServices.basics() });
    expect(h.bus.hasService('storage:get')).toBe(true);
    expect(h.bus.hasService('storage:set')).toBe(true);
    expect(h.bus.hasService('audit:write')).toBe(true);
    expect(h.bus.hasService('eventbus:emit')).toBe(true);
  });

  it('override a single service', async () => {
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:get': async () => 'mocked-value',
      },
    });
    const v = await h.bus.call('storage:get', h.ctx(), { key: 'anything' });
    expect(v).toBe('mocked-value');
  });

  it('chat:run returns terminated:no-service:llm:call when no llm plugin is loaded (Week 1-2 goal)', async () => {
    const h = await createTestHarness({ withChatLoop: true });
    const outcome = await h.bus.call('chat:run', h.ctx(), {
      message: { role: 'user', content: 'hi' },
    });
    expect(outcome).toMatchObject({ kind: 'terminated', reason: 'no-service:llm:call' });
  });
});
```

**Step 2: Run → FAIL**

**Step 3: Implement `packages/test-harness/src/mock-services.ts`**

```ts
import type { ServiceHandler } from '@ax/core';

export const MockServices = {
  basics(): Record<string, ServiceHandler> {
    return {
      'storage:get': async () => undefined,
      'storage:set': async () => undefined,
      'audit:write': async () => undefined,
      'eventbus:emit': async () => undefined,
    };
  },
};
```

Note: this requires `ServiceHandler` to be exported from `@ax/core`. Verify `packages/core/src/index.ts` exports `hook-bus.js` (it does). `ServiceHandler` is declared in `hook-bus.ts` and exported at Task 5.

**Step 4: Implement `packages/test-harness/src/harness.ts`**

```ts
import {
  HookBus,
  makeChatContext,
  registerChatLoop,
  bootstrap,
  type ChatContext,
  type Plugin,
  type ServiceHandler,
} from '@ax/core';

export interface TestHarness {
  bus: HookBus;
  ctx(overrides?: Partial<Parameters<typeof makeChatContext>[0]>): ChatContext;
}

export interface CreateTestHarnessOptions {
  services?: Record<string, ServiceHandler>;
  plugins?: Plugin[];
  withChatLoop?: boolean;
}

export async function createTestHarness(opts: CreateTestHarnessOptions = {}): Promise<TestHarness> {
  const bus = new HookBus();

  if (opts.withChatLoop !== false) {
    registerChatLoop(bus);
  }

  if (opts.services) {
    for (const [hook, handler] of Object.entries(opts.services)) {
      if (!bus.hasService(hook)) {
        bus.registerService(hook, 'mock', handler);
      }
    }
  }

  if (opts.plugins && opts.plugins.length > 0) {
    await bootstrap({ bus, plugins: opts.plugins, config: {} });
  }

  return {
    bus,
    ctx(overrides) {
      return makeChatContext({
        sessionId: 'test-session',
        agentId: 'test-agent',
        userId: 'test-user',
        ...overrides,
      });
    },
  };
}
```

**Step 5: `packages/test-harness/src/index.ts`**

```ts
export * from './harness.js';
export * from './mock-services.js';
```

**Step 6: Default-on chat loop — adjust test**

The test uses `{ withChatLoop: true }` to be explicit. The default in the implementation is `withChatLoop !== false` (i.e., default true). Both pass.

**Step 7: Run → PASS**

```bash
pnpm --filter @ax/test-harness test
```

**Step 8: Commit**

```bash
git add packages/test-harness
git commit -m "feat(test-harness): createTestHarness + MockServices.basics"
```

---

## Task 12: Acceptance test — the "no llm registered" end-to-end check

**Files:**
- Create: `packages/core/src/__tests__/acceptance.test.ts`

This test lives in `@ax/core` but uses only the public API, to verify the Week 1–2 goal from a consumer's perspective. It does NOT depend on `@ax/test-harness` (which has its own tests in Task 11).

**Step 1: Write the test**

```ts
// packages/core/src/__tests__/acceptance.test.ts
import { describe, it, expect } from 'vitest';
import {
  HookBus,
  registerChatLoop,
  makeChatContext,
  type ChatOutcome,
} from '../index.js';

describe('Week 1–2 acceptance', () => {
  it('chat:run returns a clean terminated outcome when no llm:call is registered', async () => {
    const bus = new HookBus();
    registerChatLoop(bus);
    const ctx = makeChatContext({
      sessionId: 's', agentId: 'a', userId: 'u',
    });
    for (const k of ['info', 'error', 'warn', 'debug']) {
      (ctx.logger as unknown as Record<string, unknown>)[k] = () => {};
    }
    const outcome: ChatOutcome = await bus.call(
      'chat:run',
      ctx,
      { message: { role: 'user', content: 'hello' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('no-service:llm:call');
      expect(outcome.error).toBeDefined();
    }
  });
});
```

**Step 2: Run**

```bash
pnpm --filter @ax/core test
```

Expected: PASS.

**Step 3: Typecheck + lint at the monorepo level**

```bash
pnpm build
pnpm lint
```

Expected: clean.

**Step 4: Commit**

```bash
git add packages/core
git commit -m "test(core): Week 1-2 acceptance — chat:run terminates cleanly with no llm"
```

---

## Task 13: Add a `.changeset` entry documenting the kernel slice

**Files:**
- Create: `.changeset/kernel-slice.md`

**Step 1: Write the changeset**

```markdown
---
'@ax/core': minor
'@ax/test-harness': minor
---

Initial kernel slice: `HookBus` (service + subscriber hooks), `ChatContext`, `PluginError`, `bootstrap` (manifest validation, cycle + missing-service checks), orchestration loop registered as `chat:run`, and `@ax/test-harness` with `createTestHarness` and `MockServices.basics`. Calling `chat:run` with no LLM plugin returns `{ kind: 'terminated', reason: 'no-service:llm:call' }`.
```

**Step 2: Run the full build + test + lint**

```bash
pnpm build
pnpm -r run test
pnpm lint
```

Expected: everything green.

**Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for kernel slice"
```

---

## Definition of done for this plan

- [ ] Feature branch `feat/kernel-hook-bus` created, not merged to main.
- [ ] `pnpm build` clean across the workspace.
- [ ] `pnpm -r run test` passes; `@ax/core` has >= 12 tests, `@ax/test-harness` has >= 5.
- [ ] `pnpm lint` passes (no cross-plugin imports — only allowed: `@ax/core` and `@ax/test-harness` per `eslint.config.mjs`).
- [ ] Acceptance test demonstrates `chat:run` → `terminated:no-service:llm:call`.
- [ ] Changeset entry documenting the minor bump is present.
- [ ] One commit per task.

## Deferred to later slices (not in this plan)

- IPC primitives (length-prefixed framing, Zod wire validation, sandbox-side client) — needed when the first sandbox plugin ships.
- Structured pino-style logger with real transports.
- Timeout enforcement on service-hook calls (plan doc Section 10 lists this; deferring because no real service plugins exist yet to benchmark timeouts).
- Zod validation on hook return shapes (plan doc Section 10; adds a perf cost worth measuring with a real plugin).
- `@ax/llm-mock`, `@ax/sandbox-subprocess`, `@ax/storage-sqlite`, `@ax/cli` — Week 3 (next slice).
- Real config loader (`ax.config.ts` discovery). This slice passes `config` directly to `bootstrap`.
