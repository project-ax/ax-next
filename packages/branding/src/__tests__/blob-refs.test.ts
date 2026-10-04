import { describe, it, expect } from 'vitest';
import {
  BLOB_COLLECT_REFS_HOOK,
  HookBus,
  makeAgentContext,
  readBlobCollectRefsAnswers,
  type BlobCollectRefsPayload,
} from '@ax/core';
import { createBrandingPlugin } from '../plugin.js';
import { serializeRecord, type BrandingRecord } from '../record.js';

// ---------------------------------------------------------------------------
// TASK-776 (blob-gc design D2/D7): @ax/branding is a `blob:collect-refs` holder
// for the logo pointers in its one `settings:branding` record. A logo is held
// for nobody in particular (`userIds: []`): the bytes are kept, and no ledger
// charge is released for them.
//
// The holder reads the record STRICTLY. The route-facing `parseRecord` is
// tolerant on purpose (a corrupt row must not 500 the public GET) and answers
// "no logos" for garbage. For a holder that would be failing OPEN: a record we
// could not read would tell the sweep that nothing holds the logos, and the
// sweep would delete them. So here an unreadable record is `ok: false`.
// ---------------------------------------------------------------------------

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const ctx = makeAgentContext({ sessionId: 'test', agentId: '@ax/branding', userId: 'system' });

const record = (over: Partial<BrandingRecord> = {}): BrandingRecord => ({
  name: 'Canopy AI',
  logoType: 'full',
  light: { sha256: A, contentType: 'image/png' },
  dark: { sha256: B, contentType: 'image/png' },
  version: '2026-10-03T00:00:00.000Z',
  ...over,
});

type Stored = Uint8Array | undefined | 'throw';

/** A bus with the hooks branding calls stubbed, the plugin initialised, and a
 *  settable `settings:branding` value. */
async function boot(initial: Stored) {
  const bus = new HookBus();
  let stored: Stored = initial;
  bus.registerService('storage:get', 'test', async () => {
    if (stored === 'throw') throw new Error('storage unavailable');
    return { value: stored };
  });
  bus.registerService('http:register-route', 'test', async () => ({ unregister: () => {} }));
  await createBrandingPlugin().init!({ bus } as never);
  return {
    bus,
    set: (v: Stored) => {
      stored = v;
    },
  };
}

async function ask(bus: HookBus, candidates: string[]): Promise<BlobCollectRefsPayload> {
  const start: BlobCollectRefsPayload = { candidates, answers: [] };
  const res = await bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, ctx, start);
  expect(res.rejected).toBe(false);
  return (res.rejected ? start : res.payload) as BlobCollectRefsPayload;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('@ax/branding manifest', () => {
  it('subscribes to blob:collect-refs (it stores logo shas in its record)', () => {
    expect(createBrandingPlugin().manifest.subscribes).toEqual(['blob:collect-refs']);
  });

  it('has nothing in reach that could free a blob (TASK-778: the GC frees replaced logos)', () => {
    const m = createBrandingPlugin().manifest;
    const reach = [...m.calls, ...(m.optionalCalls ?? []).map((c) => c.hook)];
    for (const hook of ['blob:delete', 'blob:retire', 'blob:purge']) expect(reach).not.toContain(hook);
  });
});

describe('@ax/branding as a blob:collect-refs holder', () => {
  it('answers ok with both logos, held for nobody in particular', async () => {
    const { bus } = await boot(serializeRecord(record()));
    const out = await ask(bus, [A, B, C]);
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.holder).toBe('@ax/branding');
    expect(out.answers[0]!.ok).toBe(true);

    const read = readBlobCollectRefsAnswers(out, [A, B, C]);
    expect(read.failed).toEqual([]);
    expect(read.held.get(A)).toEqual({ userIds: new Set(), unattributed: true });
    expect(read.held.get(B)).toEqual({ userIds: new Set(), unattributed: true });
    expect(read.held.has(C)).toBe(false);
  });

  it('answers only for the candidates it was asked about', async () => {
    const { bus } = await boot(serializeRecord(record()));
    const out = await ask(bus, [A, C]);
    expect(out.answers[0]!.refs).toEqual([{ sha256: A, userIds: [] }]);
  });

  it('names a logo once when light and dark are the same bytes', async () => {
    const same = { sha256: A, contentType: 'image/png' as const };
    const { bus } = await boot(serializeRecord(record({ light: same, dark: same })));
    const out = await ask(bus, [A]);
    expect(out.answers[0]).toEqual({
      holder: '@ax/branding',
      ok: true,
      refs: [{ sha256: A, userIds: [] }],
    });
  });

  it('answers ok with nothing when a logo slot is empty', async () => {
    const { bus } = await boot(serializeRecord(record({ light: null, dark: null })));
    const out = await ask(bus, [A, B]);
    expect(out.answers).toEqual([{ holder: '@ax/branding', ok: true, refs: [] }]);
  });

  it('answers ok with nothing when no record was ever written', async () => {
    const { bus } = await boot(undefined);
    expect((await ask(bus, [A])).answers).toEqual([{ holder: '@ax/branding', ok: true, refs: [] }]);
  });

  it('answers ok with nothing for an empty stored value', async () => {
    const { bus } = await boot(new Uint8Array(0));
    expect((await ask(bus, [A])).answers).toEqual([{ holder: '@ax/branding', ok: true, refs: [] }]);
  });

  // The fail-open trap: the tolerant parseRecord turns each of these into
  // "no logos". A holder must not.
  it.each([
    ['not JSON', bytes('not json {')],
    ['not UTF-8', new Uint8Array([0xff, 0xfe, 0xfd])],
    ['the wrong shape', bytes(JSON.stringify({ name: 42 }))],
    ['a logo pointer with a bad sha', bytes(JSON.stringify({ ...record(), light: { sha256: 'xyz', contentType: 'image/png' } }))],
    ['JSON null', bytes('null')],
  ])('answers ok:false (never "no logos") for a stored record that is %s', async (_label, value) => {
    const { bus } = await boot(value);
    const out = await ask(bus, [A, B]);
    expect(out.answers).toEqual([{ holder: '@ax/branding', ok: false, refs: [] }]);
    expect(readBlobCollectRefsAnswers(out, [A, B]).failed).toEqual(['@ax/branding']);
  });

  it('answers ok:false when storage cannot be read, and never throws', async () => {
    const { bus } = await boot('throw');
    expect((await ask(bus, [A])).answers).toEqual([
      { holder: '@ax/branding', ok: false, refs: [] },
    ]);
  });

  it('reads the record fresh each time: a replaced logo stops being held', async () => {
    const h = await boot(serializeRecord(record()));
    expect((await ask(h.bus, [A])).answers[0]!.refs).toEqual([{ sha256: A, userIds: [] }]);
    h.set(serializeRecord(record({ light: { sha256: C, contentType: 'image/png' } })));
    const out = await ask(h.bus, [A, C]);
    expect(out.answers[0]!.refs).toEqual([{ sha256: C, userIds: [] }]);
  });

  it('answers ok:false for a payload it cannot trust, and never throws', async () => {
    const { bus } = await boot(serializeRecord(record()));
    const res = await bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, ctx, {
      candidates: ['nope'],
      answers: [],
    });
    expect(res.rejected).toBe(false);
    const answers = res.rejected ? [] : (res.payload as BlobCollectRefsPayload).answers;
    expect(answers).toEqual([{ holder: '@ax/branding', ok: false, refs: [] }]);
  });
});
