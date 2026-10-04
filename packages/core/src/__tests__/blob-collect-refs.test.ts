import { describe, expect, it } from 'vitest';
import {
  BLOB_COLLECT_REFS_HOOK,
  BLOB_COLLECT_REFS_MAX_CANDIDATES,
  answerBlobCollectRefs,
  isBlobSha256,
  parseBlobCandidates,
  readBlobCollectRefsAnswers,
  type BlobCollectRefsPayload,
} from '../blob-collect-refs.js';
import { HookBus } from '../hook-bus.js';
import { makeAgentContext } from '../context.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function payload(candidates: unknown, answers: unknown = []): unknown {
  return { candidates, answers };
}

describe('isBlobSha256 / parseBlobCandidates', () => {
  it('accepts only 64 lowercase hex characters', () => {
    expect(isBlobSha256(A)).toBe(true);
    expect(isBlobSha256('A'.repeat(64))).toBe(false);
    expect(isBlobSha256('a'.repeat(63))).toBe(false);
    expect(isBlobSha256('g'.repeat(64))).toBe(false);
    expect(isBlobSha256(42)).toBe(false);
  });

  it('rejects a non-array, an oversized list, and any bad entry WHOLE', () => {
    expect(parseBlobCandidates([A, B])).toEqual([A, B]);
    expect(parseBlobCandidates([])).toEqual([]);
    expect(parseBlobCandidates('nope')).toBeUndefined();
    expect(parseBlobCandidates([A, 'x'])).toBeUndefined();
    expect(
      parseBlobCandidates(Array.from({ length: BLOB_COLLECT_REFS_MAX_CANDIDATES + 1 }, () => A)),
    ).toBeUndefined();
    expect(
      parseBlobCandidates(Array.from({ length: BLOB_COLLECT_REFS_MAX_CANDIDATES }, () => A)),
    ).toHaveLength(BLOB_COLLECT_REFS_MAX_CANDIDATES);
  });
});

describe('answerBlobCollectRefs (the holder side)', () => {
  it('appends its own answer after the earlier ones and never touches them', async () => {
    const earlier = { holder: '@x/first', ok: true, refs: [{ sha256: A, userIds: ['u1'] }] };
    const out = await answerBlobCollectRefs(payload([A, B], [earlier]), '@x/second', async () => [
      { sha256: B, userIds: ['u2'] },
    ]);
    expect(out.answers).toEqual([
      earlier,
      { holder: '@x/second', ok: true, refs: [{ sha256: B, userIds: ['u2'] }] },
    ]);
    expect(out.answers[0]).toBe(earlier);
    expect(out.candidates).toEqual([A, B]);
  });

  it('a lookup that throws becomes ok:false, never a throw', async () => {
    const out = await answerBlobCollectRefs(payload([A]), '@x/h', async () => {
      throw new Error('db down');
    });
    expect(out.answers).toEqual([{ holder: '@x/h', ok: false, refs: [] }]);
  });

  it('bad candidates become ok:false and the lookup is never called', async () => {
    let called = false;
    const out = await answerBlobCollectRefs(payload(['NOT-A-SHA']), '@x/h', async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(out.answers).toEqual([{ holder: '@x/h', ok: false, refs: [] }]);
  });

  it('a non-object payload still gets an ok:false answer', async () => {
    const out = await answerBlobCollectRefs(null, '@x/h', async () => []);
    expect(out).toEqual({ candidates: [], answers: [{ holder: '@x/h', ok: false, refs: [] }] });
  });

  it('drops refs for shas that were not asked about, and merges duplicates', async () => {
    const out = await answerBlobCollectRefs(payload([A]), '@x/h', async () => [
      { sha256: A, userIds: ['u1'] },
      { sha256: C, userIds: ['u9'] },
      { sha256: A, userIds: ['u2', 'u1'] },
    ]);
    expect(out.answers).toEqual([
      { holder: '@x/h', ok: true, refs: [{ sha256: A, userIds: ['u1', 'u2'] }] },
    ]);
  });

  it('keeps an unattributed ref (empty userIds) as a ref', async () => {
    const out = await answerBlobCollectRefs(payload([A]), '@x/h', async () => [
      { sha256: A, userIds: [] },
    ]);
    expect(out.answers[0]).toEqual({ holder: '@x/h', ok: true, refs: [{ sha256: A, userIds: [] }] });
  });

  it('an empty candidate list answers ok without asking the lookup', async () => {
    let called = false;
    const out = await answerBlobCollectRefs(payload([]), '@x/h', async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(out.answers).toEqual([{ holder: '@x/h', ok: true, refs: [] }]);
  });
});

describe('readBlobCollectRefsAnswers (the caller side)', () => {
  it('collects holders, failures, and per-sha userIds', () => {
    const out = readBlobCollectRefsAnswers(
      payload(
        [A, B],
        [
          { holder: 'h1', ok: true, refs: [{ sha256: A, userIds: ['u1'] }] },
          { holder: 'h2', ok: true, refs: [{ sha256: A, userIds: ['u2'] }, { sha256: B, userIds: [] }] },
          { holder: 'h3', ok: false, refs: [] },
        ],
      ),
      [A, B],
    );
    expect([...out.answered].sort()).toEqual(['h1', 'h2', 'h3']);
    expect(out.failed).toEqual(['h3']);
    expect(out.malformed).toBe(0);
    expect([...out.held.get(A)!.userIds].sort()).toEqual(['u1', 'u2']);
    expect(out.held.get(A)!.unattributed).toBe(false);
    expect(out.held.get(B)!.unattributed).toBe(true);
  });

  it('ignores a ref for a sha that was not a candidate', () => {
    const out = readBlobCollectRefsAnswers(
      payload([A], [{ holder: 'h', ok: true, refs: [{ sha256: C, userIds: ['u'] }] }]),
      [A],
    );
    expect(out.held.size).toBe(0);
  });

  it('judges candidates by the CALLER list, not the (rewritable) payload list', () => {
    const out = readBlobCollectRefsAnswers(
      payload([C], [{ holder: 'h', ok: true, refs: [{ sha256: C, userIds: ['u'] }] }]),
      [A],
    );
    expect(out.held.size).toBe(0);
  });

  it('an answer it cannot read counts as malformed or failed, never as "no refs"', () => {
    const named = readBlobCollectRefsAnswers(
      payload([A], [{ holder: 'h', ok: true, refs: [{ sha256: A, userIds: [7] }] }]),
      [A],
    );
    expect(named.failed).toEqual(['h']);
    expect(named.answered.has('h')).toBe(true);

    const nameless = readBlobCollectRefsAnswers(payload([A], [{ ok: true, refs: [] }]), [A]);
    expect(nameless.malformed).toBe(1);

    const notArray = readBlobCollectRefsAnswers(payload([A], 'nope'), [A]);
    expect(notArray.malformed).toBe(1);

    const notObject = readBlobCollectRefsAnswers(undefined, [A]);
    expect(notObject.malformed).toBe(1);

    const okNotBoolean = readBlobCollectRefsAnswers(
      payload([A], [{ holder: 'h', ok: 'yes', refs: [] }]),
      [A],
    );
    expect(okNotBoolean.failed).toEqual(['h']);

    const badSha = readBlobCollectRefsAnswers(
      payload([A], [{ holder: 'h', ok: true, refs: [{ sha256: 'zz', userIds: [] }] }]),
      [A],
    );
    expect(badSha.failed).toEqual(['h']);
  });

  it('a holder answering twice fails if either answer failed', () => {
    const out = readBlobCollectRefsAnswers(
      payload(
        [A],
        [
          { holder: 'h', ok: true, refs: [] },
          { holder: 'h', ok: false, refs: [] },
        ],
      ),
      [A],
    );
    expect(out.failed).toEqual(['h']);
  });
});

describe('over the real HookBus', () => {
  it('a throwing subscriber leaves no answer (which is why callers keep a roster)', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system' });
    bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, 'h1', async (_c, p) =>
      answerBlobCollectRefs(p, 'h1', async () => [{ sha256: A, userIds: ['u1'] }]),
    );
    bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, 'boom', async () => {
      throw new Error('crash');
    });
    bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, 'h2', async (_c, p) =>
      answerBlobCollectRefs(p, 'h2', async () => []),
    );
    const start: BlobCollectRefsPayload = { candidates: [A], answers: [] };
    const res = await bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, ctx, start);
    expect(res.rejected).toBe(false);
    const out = readBlobCollectRefsAnswers(res.rejected ? undefined : res.payload, [A]);
    expect([...out.answered].sort()).toEqual(['h1', 'h2']);
    expect(out.answered.has('boom')).toBe(false);
  });
});
