import { describe, it, expect, vi } from 'vitest';
import { workspaceReadHandler } from '../workspace-read.js';

function fakeBus(readImpl: (path: string) => Promise<unknown>) {
  return {
    call: vi.fn(async (hook: string, _ctx: unknown, payload: { path: string }) => {
      if (hook === 'workspace:read') return readImpl(payload.path);
      throw new Error(`unexpected hook ${hook}`);
    }),
    hasService: vi.fn(() => false),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  };
}

function fakeCtx() {
  return {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('workspace.read handler', () => {
  it('returns base64 bytes for a found file', async () => {
    const bus = fakeBus(async (p) => {
      expect(p).toBe('foo/bar');
      return { found: true, bytes: Buffer.from('hello') };
    });
    const result = await workspaceReadHandler({ path: 'foo/bar' }, fakeCtx(), bus as never);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      found: true,
      bytesBase64: Buffer.from('hello').toString('base64'),
    });
  });

  it('returns found:false for a missing file', async () => {
    const bus = fakeBus(async () => ({ found: false }));
    const result = await workspaceReadHandler({ path: 'missing' }, fakeCtx(), bus as never);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ found: false });
  });

  it('rejects empty path at the handler level (validation)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not call workspace:read');
    });
    const result = await workspaceReadHandler({ path: '' }, fakeCtx(), bus as never);
    expect(result.status).not.toBe(200);
  });

  it('rejects missing path key', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not call workspace:read');
    });
    const result = await workspaceReadHandler({}, fakeCtx(), bus as never);
    expect(result.status).not.toBe(200);
  });

  it('returns an internal error envelope when bus.call("workspace:read") throws', async () => {
    // Plugin-side exceptions (workspace plugin not registered, git engine
    // unhealthy, transient I/O failure) must surface as a 500 INTERNAL
    // rather than propagating raw to the runner. The sanitized envelope
    // hides any underlying paths or git diagnostics.
    const ctx = fakeCtx();
    const bus = fakeBus(async () => {
      throw new Error('git engine: workspace plugin not registered');
    });
    const result = await workspaceReadHandler(
      { path: 'workspace/foo' },
      ctx,
      bus as never,
    );
    expect(result.status).not.toBe(200);
    // Logger MUST be called with the sanitized internal-error path so the
    // host operator sees the real diagnostic in logs, not the runner.
    expect((ctx as never as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalled();
  });

  it('rejects request with absolute path (workspace-relative enforcement)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not call workspace:read');
    });
    const result = await workspaceReadHandler(
      { path: '/etc/passwd' },
      fakeCtx(),
      bus as never,
    );
    expect(result.status).not.toBe(200);
  });

  it('rejects request with traversal segment (workspace-relative enforcement)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not call workspace:read');
    });
    const result = await workspaceReadHandler(
      { path: 'workspace/../etc/passwd' },
      fakeCtx(),
      bus as never,
    );
    expect(result.status).not.toBe(200);
  });
});
