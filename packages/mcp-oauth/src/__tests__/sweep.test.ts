import { describe, expect, it, vi } from 'vitest';
import { makeAgentContext, type HookBus } from '@ax/core';
import { sweepDeadAgentMarkers } from '../sweep.js';

// ---------------------------------------------------------------------------
// Slice 5 — the boot sweep that drops agent "sign-in expired" markers for
// connector ids no live connector carries any more (a `connectors:deleted`
// event that was lost, or a delete from before the event existed). It asks
// `connectors:live-ids` in batches of at most 500 and deletes ONLY ids that
// came back not live. It fails toward keeping data and never throws.
// ---------------------------------------------------------------------------

const ctx = makeAgentContext({ sessionId: 'init', agentId: '@ax/mcp-oauth', userId: 'init' });

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
}

function fakeStore(ids: string[]) {
  return {
    listMarkedConnectorIds: vi.fn(async () => [...ids]),
    deleteMarkersForConnector: vi.fn(async (_id: string) => ({ agent: 1, identityScope: 0 })),
  };
}

function fakeBus(liveIds: ((batch: string[]) => unknown) | undefined) {
  const call = vi.fn(async (hook: string, _ctx: unknown, input: unknown) => {
    if (hook !== 'connectors:live-ids' || liveIds === undefined) throw new Error(`no service ${hook}`);
    return liveIds((input as { connectorIds: string[] }).connectorIds);
  });
  const bus = {
    hasService: vi.fn((hook: string) => hook === 'connectors:live-ids' && liveIds !== undefined),
    call,
  } as unknown as HookBus;
  return { bus, call };
}

async function run(ids: string[], liveIds: ((batch: string[]) => unknown) | undefined, storeOver = {}) {
  const store = { ...fakeStore(ids), ...storeOver };
  const { bus, call } = fakeBus(liveIds);
  const logger = fakeLogger();
  await sweepDeadAgentMarkers({ bus, ctx, store, logger: logger as never });
  const deleted = store.deleteMarkersForConnector.mock.calls.map((c) => c[0]);
  return { store, call, logger, deleted };
}

describe('sweepDeadAgentMarkers (slice 5)', () => {
  it('deletes the markers of ids answered not live — and only those', async () => {
    const { deleted, call } = await run(['gmail', 'linear', 'slack'], () => ({ live: ['linear'] }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toEqual({ connectorIds: ['gmail', 'linear', 'slack'] });
    expect(deleted.sort()).toEqual(['gmail', 'slack']);
  });

  it('every id live → nothing deleted', async () => {
    const { deleted } = await run(['gmail'], () => ({ live: ['gmail'] }));
    expect(deleted).toEqual([]);
  });

  it('no markers at all → connectors is not even asked', async () => {
    const { call, deleted } = await run([], () => ({ live: [] }));
    expect(call).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it('501 ids are asked about in two calls (500, then 1)', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `c${i}`);
    const { call, deleted } = await run(ids, (batch) => ({ live: batch }));
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[0]![2] as { connectorIds: string[] }).connectorIds).toHaveLength(500);
    expect((call.mock.calls[1]![2] as { connectorIds: string[] }).connectorIds).toEqual(['c500']);
    expect(deleted).toEqual([]);
  });

  it('connectors not loaded (no connectors:live-ids) → keeps every marker, says so at info, never throws', async () => {
    const { deleted, call, logger } = await run(['gmail'], undefined);
    expect(call).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('mcp_oauth_marker_sweep_skipped', expect.anything());
  });

  it('connectors:live-ids throws → keeps every marker of that batch and warns', async () => {
    const { deleted, logger } = await run(['gmail', 'slack'], () => {
      throw new Error('db down');
    });
    expect(deleted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_marker_sweep_lookup_failed', expect.anything());
  });

  it('a failed batch keeps its ids, and the next batch is still swept', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `c${i}`);
    let n = 0;
    const { deleted } = await run(ids, () => {
      n += 1;
      if (n === 1) throw new Error('first batch fails');
      return { live: [] };
    });
    expect(deleted).toEqual(['c500']);
  });

  it.each([
    ['null', null],
    ['no live array', { alive: [] }],
    ['live not an array', { live: 'gmail' }],
  ])('a malformed reply (%s) → keeps every marker', async (_label, reply) => {
    const { deleted, logger } = await run(['gmail'], () => reply);
    expect(deleted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_marker_sweep_lookup_failed', expect.anything());
  });

  it('an id that is not a connector-id slug is never asked about and never deleted', async () => {
    const { deleted, call, logger } = await run(['gmail', 'Not:A-Slug'], () => ({ live: [] }));
    expect(call.mock.calls[0]![2]).toEqual({ connectorIds: ['gmail'] });
    expect(deleted).toEqual(['gmail']);
    expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_marker_sweep_malformed_ids', expect.anything());
  });

  it('listing the markers throws → nothing deleted, never throws', async () => {
    const { deleted, logger } = await run([], () => ({ live: [] }), {
      listMarkedConnectorIds: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    expect(deleted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_marker_sweep_failed', expect.anything());
  });

  it('one failed delete does not stop the rest', async () => {
    const del = vi.fn(async (id: string) => {
      if (id === 'gmail') throw new Error('db hiccup');
      return { agent: 1, identityScope: 0 };
    });
    const { logger } = await run(['gmail', 'slack'], () => ({ live: [] }), { deleteMarkersForConnector: del });
    expect(del.mock.calls.map((c) => c[0]).sort()).toEqual(['gmail', 'slack']);
    expect(logger.warn).toHaveBeenCalledWith('mcp_oauth_marker_sweep_delete_failed', expect.objectContaining({ connectorId: 'gmail' }));
  });
});
