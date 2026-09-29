import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { HookBus } from '../hook-bus.js';
import { PluginError, reject } from '../errors.js';
import { makeAgentContext, createLogger, type AgentContext } from '../context.js';
import {
  registerBlobPutFacade,
  type BlobPrePutPayload,
  type BlobStoredPayload,
} from '../blob-put-facade.js';

const FACADE_PLUGIN = '@ax/blob-test-backend';

// ---------------------------------------------------------------------------
// `blob:put` was a raw backend service hook, so nothing could intercept a
// write (the hook bus has no interceptor for service hooks). The facade makes
// `blob:put` the PUBLIC entry point that always fires the `blob:pre-put` veto
// and the `blob:stored` notify around the backend's `blob:put-internal`.
// Same shape as `registerWorkspaceApplyFacade`.
// ---------------------------------------------------------------------------

interface PutInput {
  bytes: Uint8Array;
}
interface PutOutput {
  sha256: string;
  size: number;
}

function silentCtx(
  overrides?: Partial<Parameters<typeof makeAgentContext>[0]>,
): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    ...overrides,
  });
}

const SHA = 'a'.repeat(64);
const bytes = new Uint8Array([1, 2, 3, 4, 5]);

function busWithInternal(
  internal: (ctx: AgentContext, input: PutInput) => Promise<PutOutput>,
): HookBus {
  const bus = new HookBus();
  bus.registerService<PutInput, PutOutput>('blob:put-internal', FACADE_PLUGIN, internal);
  return bus;
}

describe('registerBlobPutFacade', () => {
  it('allow path: writes via internal and returns its output', async () => {
    const internal = vi.fn(async (_ctx: AgentContext, _input: PutInput) => ({
      sha256: SHA,
      size: bytes.byteLength,
    }));
    const bus = busWithInternal(internal);
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const out = await bus.call<PutInput, PutOutput>('blob:put', silentCtx(), { bytes });

    expect(out).toEqual({ sha256: SHA, size: 5 });
    expect(internal).toHaveBeenCalledTimes(1);
    expect(internal.mock.calls[0]?.[1]).toEqual({ bytes });
  });

  it('pre-put veto throws PluginError{code:rejected} and internal is NEVER called', async () => {
    const internal = vi.fn(async () => ({ sha256: SHA, size: bytes.byteLength }));
    const bus = busWithInternal(internal);
    bus.subscribe('blob:pre-put', 'quota', async () =>
      reject({ reason: 'storage full', source: 'quota' }),
    );
    const stored = vi.fn(async () => undefined);
    bus.subscribe('blob:stored', 'ledger', stored);
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('blob:put', silentCtx(), { bytes })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('rejected');
    expect((err as PluginError).plugin).toBe(FACADE_PLUGIN);
    expect((err as PluginError).hookName).toBe('blob:put');
    expect((err as PluginError).message).toContain('storage full');
    expect(internal).not.toHaveBeenCalled();
    // Nothing landed, so nothing is announced.
    expect(stored).not.toHaveBeenCalled();
  });

  it('a veto that carries a code surfaces it as reasonCode; PluginError.code stays rejected (TASK-719)', async () => {
    const internal = vi.fn(async () => ({ sha256: SHA, size: bytes.byteLength }));
    const bus = busWithInternal(internal);
    bus.subscribe('blob:pre-put', 'quota', async () =>
      reject({ reason: 'storage full', code: 'storage-full' }),
    );
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('blob:put', silentCtx(), { bytes })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('rejected');
    expect((err as PluginError).reasonCode).toBe('storage-full');
    expect(internal).not.toHaveBeenCalled();
  });

  it('a veto with no code yields an error with NO reasonCode key (TASK-719)', async () => {
    const bus = busWithInternal(async () => ({ sha256: SHA, size: bytes.byteLength }));
    bus.subscribe('blob:pre-put', 'quota', async () => reject({ reason: 'storage full' }));
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('blob:put', silentCtx(), { bytes })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect('reasonCode' in (err as PluginError)).toBe(false);
  });

  it('pre-put payload size equals the byte length', async () => {
    const bus = busWithInternal(async () => ({ sha256: SHA, size: bytes.byteLength }));
    let seen: BlobPrePutPayload | undefined;
    bus.subscribe<BlobPrePutPayload>('blob:pre-put', 'observer', async (_ctx, p) => {
      seen = p;
      return undefined;
    });
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    await bus.call('blob:put', silentCtx(), { bytes: new Uint8Array(1234) });

    expect(seen).toEqual({ size: 1234 });
  });

  it('a transformed pre-put payload is ignored (veto-only): the FULL bytes are written', async () => {
    let internalInput: PutInput | undefined;
    const bus = busWithInternal(async (_ctx, input) => {
      internalInput = input;
      return { sha256: SHA, size: input.bytes.byteLength };
    });
    bus.subscribe<BlobPrePutPayload>('blob:pre-put', 'transformer', async () => ({
      size: 0,
    }));
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    await bus.call('blob:put', silentCtx(), { bytes });

    expect(internalInput?.bytes).toBe(bytes);
  });

  it('blob:stored fires exactly once with sha256 + size after a successful put', async () => {
    const bus = busWithInternal(async () => ({ sha256: SHA, size: bytes.byteLength }));
    const stored = vi.fn(async (_ctx: AgentContext, _p: BlobStoredPayload) => undefined);
    bus.subscribe<BlobStoredPayload>('blob:stored', 'ledger', stored);
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    await bus.call('blob:put', silentCtx(), { bytes });

    expect(stored).toHaveBeenCalledTimes(1);
    expect(stored.mock.calls[0]?.[1]).toEqual({ sha256: SHA, size: 5 });
  });

  it('a rejecting blob:stored subscriber is logged, never thrown; put still succeeds', async () => {
    const bus = busWithInternal(async () => ({ sha256: SHA, size: bytes.byteLength }));
    bus.subscribe('blob:stored', 'late-vetoer', async () =>
      reject({ reason: 'too late to veto', source: 'late-vetoer' }),
    );
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const warn = vi.fn();
    const ctx = silentCtx({
      logger: { ...createLogger({ reqId: 't', writer: () => {} }), warn },
    });

    const out = await bus.call<PutInput, PutOutput>('blob:put', ctx, { bytes });

    expect(out).toEqual({ sha256: SHA, size: 5 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a throwing blob:stored subscriber does not fail the put either', async () => {
    const bus = busWithInternal(async () => ({ sha256: SHA, size: bytes.byteLength }));
    bus.subscribe('blob:stored', 'broken', async () => {
      throw new Error('ledger down');
    });
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    await expect(
      bus.call<PutInput, PutOutput>('blob:put', silentCtx(), { bytes }),
    ).resolves.toEqual({ sha256: SHA, size: 5 });
  });

  it('rethrows internal errors UNCHANGED and does not fire blob:stored', async () => {
    const boom = new PluginError({
      code: 'corrupt',
      plugin: FACADE_PLUGIN,
      hookName: 'blob:put-internal',
      message: 'disk on fire',
    });
    const bus = busWithInternal(async () => {
      throw boom;
    });
    const stored = vi.fn(async () => undefined);
    bus.subscribe('blob:stored', 'ledger', stored);
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    const err = await bus
      .call('blob:put', silentCtx(), { bytes })
      .catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(stored).not.toHaveBeenCalled();
  });

  it('ctx is passed through unchanged to pre-put / internal / stored', async () => {
    const ctx = silentCtx({ userId: 'specific-user', agentId: 'specific-agent' });
    let internalCtx: AgentContext | undefined;
    const bus = busWithInternal(async (c) => {
      internalCtx = c;
      return { sha256: SHA, size: bytes.byteLength };
    });
    let preCtx: AgentContext | undefined;
    let storedCtx: AgentContext | undefined;
    bus.subscribe('blob:pre-put', 'pre', async (c) => {
      preCtx = c;
      return undefined;
    });
    bus.subscribe('blob:stored', 'post', async (c) => {
      storedCtx = c;
      return undefined;
    });
    registerBlobPutFacade(bus, FACADE_PLUGIN);

    await bus.call('blob:put', ctx, { bytes });

    expect(preCtx).toBe(ctx);
    expect(internalCtx).toBe(ctx);
    expect(storedCtx).toBe(ctx);
  });

  it('passes opts.returns through: a malformed internal result is invalid-return', async () => {
    const bus = busWithInternal(
      async () => ({ sha256: 42, size: 'x' }) as unknown as PutOutput,
    );
    registerBlobPutFacade(bus, FACADE_PLUGIN, {
      returns: z.object({ sha256: z.string(), size: z.number() }),
    });

    const err = await bus
      .call('blob:put', silentCtx(), { bytes })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('invalid-return');
    expect((err as PluginError).hookName).toBe('blob:put');
  });
});

// Type-only assert that the facade signature matches what backends call.
const _typecheck: (
  bus: HookBus,
  plugin: string,
  opts?: { returns?: z.ZodType },
) => void = registerBlobPutFacade;
void _typecheck;
