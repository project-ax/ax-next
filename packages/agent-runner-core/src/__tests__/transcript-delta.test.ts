import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import {
  hashBytes,
  restoreTranscriptForResume,
  shipTranscriptDelta,
  splitCompleteLines,
  type TranscriptSource,
  type TranscriptWriteOutcome,
} from '../transcript-delta.js';

function writeJsonl(root: string, sessionId: string, body: string): string {
  const projDir = join(root, '.claude', 'projects', 'my-proj');
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  return file;
}

// `locateJsonl`'s real readdir-walk and the SDK-slug `write` destination now
// live behind `createJsonlTranscriptSource` in @ax/agent-claude-sdk-runner
// (covered by jsonl-transcript-source.test.ts there) — core can't depend on
// that downstream package, so this fixture-local fake reads the fixed
// `my-proj` path `writeJsonl` above writes to (preserving these tests' existing
// "not found" vs "found" behavior verbatim), and records `write` calls
// in-memory instead of naming any on-disk destination — core must never know
// where the bytes land. `writeOutcome` lets a test drive the 'unusable' answer
// a runner gives when it cannot adopt a foreign serialization.
function fakeSource(
  root: string,
  writeOutcome: TranscriptWriteOutcome = 'accepted',
): TranscriptSource & { writes: Array<{ sessionId: string; bytes: Buffer }> } {
  const writes: Array<{ sessionId: string; bytes: Buffer }> = [];
  return {
    writes,
    read: async (sessionId: string) => {
      const candidate = join(root, '.claude', 'projects', 'my-proj', `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        return await readFile(candidate);
      } catch {
        return null;
      }
    },
    write: async (sessionId: string, bytes: Buffer) => {
      writes.push({ sessionId, bytes });
      return writeOutcome;
    },
  };
}

describe('splitCompleteLines', () => {
  it('returns complete lines and holds back a trailing partial', () => {
    const buf = Buffer.from('line1\nline2\npartial', 'utf8');
    const { lines, consumed } = splitCompleteLines(buf);
    expect(lines).toEqual(['line1', 'line2']);
    // consumed = bytes up to and including the 2nd '\n'.
    expect(consumed).toBe('line1\nline2\n'.length);
  });

  it('consumes the whole buffer when it ends with a newline', () => {
    const buf = Buffer.from('a\nb\nc\n', 'utf8');
    const { lines, consumed } = splitCompleteLines(buf);
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(consumed).toBe(buf.length);
  });

  it('holds back everything when there is no complete line yet', () => {
    const buf = Buffer.from('still-writing', 'utf8');
    expect(splitCompleteLines(buf)).toEqual({ lines: [], consumed: 0 });
  });

  it('is empty for an empty buffer', () => {
    expect(splitCompleteLines(Buffer.alloc(0))).toEqual({ lines: [], consumed: 0 });
  });
});

describe('hashBytes / prefix-hash convention', () => {
  it('matches the host getTranscriptPrefixHash convention (line + \\n per line)', () => {
    const lines = ['{"a":1}', '{"b":2}'];
    const onDisk = Buffer.from(lines.map((l) => l + '\n').join(''), 'utf8');
    // The runner hashes the on-disk prefix bytes [0..offset).
    const runnerHash = hashBytes(onDisk);
    // The host hashes each stored line + its trailing '\n'.
    const hostHash = createHash('sha256');
    for (const l of lines) {
      hostHash.update(l);
      hostHash.update('\n');
    }
    expect(runnerHash).toBe(hostHash.digest('hex'));
  });
});

// `encodeProjectSlug` moved with `locateJsonl`/`write` to
// @ax/agent-claude-sdk-runner's jsonl-transcript-source.ts — its unit
// coverage now lives in jsonl-transcript-source.test.ts there.

function fakeClient(over: Partial<IpcClient>): IpcClient {
  return {
    call: vi.fn(),
    callGet: vi.fn(),
    callBinary: vi.fn(),
    callBinaryUpload: vi.fn(),
    event: vi.fn(),
    close: vi.fn(),
    ...over,
  } as unknown as IpcClient;
}

// The append ships over the binary-upload channel: callBinaryUpload(action,
// body, query). This mock routes by action so the resync path (append probe →
// whole-file replace) returns the right shape for each leg.
function uploadRouter(
  appendResp: unknown,
  replaceResp: unknown = { maxSeq: 0 },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (action: string) =>
    action === 'session.append-transcript' ? appendResp : replaceResp,
  );
}

describe('shipTranscriptDelta', () => {
  it('ships the new complete lines over the binary channel (not the capped JSON call) and advances state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const body = 'l1\nl2\nl3\n';
      writeJsonl(root, 'sess', body);
      const callBinaryUpload = uploadRouter({ outcome: 'appended', maxSeq: 3 });
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });

      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        state: { sentOffset: 0, sentSeq: 0 },
      });
      expect(res.outcome).toBe('appended');
      expect(res.sentSeq).toBe(3);
      expect(res.sentOffset).toBe(body.length);
      // The delta rides the uncapped binary channel — NEVER the 4 MiB JSON
      // `call` the host would reject as `body too large`.
      expect(client.call).not.toHaveBeenCalled();
      const [action, sentBody, query] = callBinaryUpload.mock.calls[0]!;
      expect(action).toBe('session.append-transcript');
      expect((sentBody as Buffer).toString('utf8')).toBe(body);
      // fromSeq + empty-prefix hash ride the query (fromSeq is a string there).
      expect(query).toEqual({
        fromSeq: '0',
        prefixHash: createHash('sha256').digest('hex'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships a single jsonl line larger than the 4 MiB JSON cap over the binary channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      // The shape a Read-of-a-PDF tool_result takes: one `user` jsonl line
      // carrying base64 image/document blocks, well over the 4 MiB MAX_FRAME.
      const bigLine = JSON.stringify({
        type: 'user',
        message: { content: 'x'.repeat(5 * 1024 * 1024) },
      });
      writeJsonl(root, 'sess', bigLine + '\n');
      const callBinaryUpload = uploadRouter({ outcome: 'appended', maxSeq: 1 });
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });

      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        state: { sentOffset: 0, sentSeq: 0 },
      });
      expect(res.outcome).toBe('appended');
      // The >4 MiB delta must NOT touch the JSON `call` path — that's the crash.
      expect(client.call).not.toHaveBeenCalled();
      const [, sentBody] = callBinaryUpload.mock.calls[0]!;
      expect((sentBody as Buffer).length).toBeGreaterThan(4 * 1024 * 1024);
      expect((sentBody as Buffer).toString('utf8')).toBe(bigLine + '\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships only the tail past sentOffset on a subsequent turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const body = 'l1\nl2\nl3\n';
      writeJsonl(root, 'sess', body);
      const callBinaryUpload = uploadRouter({ outcome: 'appended', maxSeq: 3 });
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });

      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        // Already shipped l1 (offset after 'l1\n', seq 1).
        state: { sentOffset: 'l1\n'.length, sentSeq: 1 },
      });
      const [, sentBody, query] = callBinaryUpload.mock.calls[0]!;
      expect((sentBody as Buffer).toString('utf8')).toBe('l2\nl3\n');
      // prefixHash = sha256 of the already-shipped bytes 'l1\n'.
      expect(query).toEqual({
        fromSeq: '1',
        prefixHash: hashBytes(Buffer.from('l1\n')),
      });
      expect(res.sentOffset).toBe(body.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to replace-transcript on resync-required', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const body = 'rewritten1\nrewritten2\n';
      writeJsonl(root, 'sess', body);
      const callBinaryUpload = uploadRouter(
        { outcome: 'resync-required', maxSeq: 1 },
        { maxSeq: 2 },
      );
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });

      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        state: { sentOffset: 5, sentSeq: 1 },
      });
      expect(res.outcome).toBe('resynced');
      expect(res.sentSeq).toBe(2);
      expect(res.sentOffset).toBe(body.length);
      // Two binary uploads: the append probe, then the whole-file replace.
      expect(callBinaryUpload).toHaveBeenCalledTimes(2);
      const replaceCall = callBinaryUpload.mock.calls.find(
        (c) => c[0] === 'session.replace-transcript',
      )!;
      expect((replaceCall[1] as Buffer).toString('utf8')).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resyncs when an in-place prefix rewrite (no new line) fails the empty-lines prefix probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      // The SDK rewrote an earlier line in place; no new complete line landed
      // past sentOffset. The empty-lines append probes the prefix → the host
      // returns resync-required → we re-ship the whole file (never silent stale).
      writeJsonl(root, 'sess', 'rewritten\n');
      const callBinaryUpload = uploadRouter(
        { outcome: 'resync-required', maxSeq: 1 },
        { maxSeq: 1 },
      );
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });
      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        state: { sentOffset: 'rewritten\n'.length, sentSeq: 1 },
      });
      // The probe carried zero new lines (an empty octet-stream body).
      const appendCall = callBinaryUpload.mock.calls.find(
        (c) => c[0] === 'session.append-transcript',
      )!;
      expect((appendCall[1] as Buffer).length).toBe(0);
      // ...and the resync re-shipped the whole file.
      expect(res.outcome).toBe('resynced');
      const replaceCall = callBinaryUpload.mock.calls.find(
        (c) => c[0] === 'session.replace-transcript',
      )!;
      expect((replaceCall[1] as Buffer).toString('utf8')).toBe('rewritten\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a noop (prefix-probe confirms intact) when no complete line landed since last ship', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      writeJsonl(root, 'sess', 'l1\n');
      // The empty-lines probe returns appended (prefix intact, nothing inserted).
      const callBinaryUpload = uploadRouter({ outcome: 'appended', maxSeq: 1 });
      const client = fakeClient({ callBinaryUpload: callBinaryUpload as never });
      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'sess',
        state: { sentOffset: 'l1\n'.length, sentSeq: 1 },
      });
      expect(res.outcome).toBe('noop');
      // It DID probe (zero new lines, empty body) — the host confirmed the prefix.
      const [, sentBody, query] = callBinaryUpload.mock.calls[0]!;
      expect((sentBody as Buffer).length).toBe(0);
      expect(query).toEqual({
        fromSeq: '1',
        prefixHash: hashBytes(Buffer.from('l1\n')),
      });
      // State unchanged.
      expect(res.sentOffset).toBe('l1\n'.length);
      expect(res.sentSeq).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is no-transcript when the source has nothing for the session yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const client = fakeClient({});
      const res = await shipTranscriptDelta({
        client,
        source: fakeSource(root),
        sessionId: 'missing',
        state: { sentOffset: 0, sentSeq: 0 },
      });
      expect(res.outcome).toBe('no-transcript');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('restoreTranscriptForResume', () => {
  it('hands the rebuilt jsonl bytes to source.write and seeds the ship state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const rebuilt = 'u1\na1\na2\n';
      // Fake callBinary drains the host bytes to a temp file (as the real one does).
      const tmpFile = join(tmpdir(), `ax-restore-${Date.now()}.bin`);
      await writeFile(tmpFile, rebuilt);
      const client = fakeClient({
        callBinary: vi.fn(async () => ({ path: tmpFile, bytes: rebuilt.length })) as never,
      });
      const source = fakeSource(root);

      const res = await restoreTranscriptForResume({
        client,
        source,
        sessionId: 'sess-resume',
      });
      expect(res.written).toBe(true);
      expect(res.state.sentSeq).toBe(3);
      expect(res.state.sentOffset).toBe(rebuilt.length);

      // Core hands the reconstructed bytes to the source — where they land
      // (the SDK slug path, for the real source) is the source's call, not
      // core's; see jsonl-transcript-source.test.ts for that placement.
      expect(source.writes).toHaveLength(1);
      expect(source.writes[0]!.sessionId).toBe('sess-resume');
      expect(source.writes[0]!.bytes.toString('utf8')).toBe(rebuilt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns written:false (F2a fresh start) when the host has no rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const tmpFile = join(tmpdir(), `ax-restore-empty-${Date.now()}.bin`);
      await writeFile(tmpFile, '');
      const client = fakeClient({
        callBinary: vi.fn(async () => ({ path: tmpFile, bytes: 0 })) as never,
      });
      const source = fakeSource(root);
      const res = await restoreTranscriptForResume({
        client,
        source,
        sessionId: 'sess-empty',
      });
      expect(res.written).toBe(false);
      expect(res.state).toEqual({ sentOffset: 0, sentSeq: 0 });
      // No transcript to restore — the source is never asked to write anything.
      expect(source.writes).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Cross-runner demotion (design §5). The host store hands back bytes the
  // source cannot represent — a transcript the OTHER runner serialized. The
  // source answers 'unusable' and core reports written:false, which routes
  // into the SAME F2a demote-to-fresh branch as "no rows at all". No second
  // branch exists in runRunner for this, by design.
  it('reports written:false when the source answers unusable (foreign transcript)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const foreign = '{"some":"other-runners-format"}\n';
      const tmpFile = join(tmpdir(), `ax-restore-foreign-${Date.now()}.bin`);
      await writeFile(tmpFile, foreign);
      const client = fakeClient({
        callBinary: vi.fn(async () => ({ path: tmpFile, bytes: foreign.length })) as never,
      });
      const source = fakeSource(root, 'unusable');

      const res = await restoreTranscriptForResume({
        client,
        source,
        sessionId: 'sess-foreign',
      });

      expect(res.written).toBe(false);
      // Ship state resets to zero — a demoted session must not ship a delta
      // against an offset derived from bytes it never adopted.
      expect(res.state).toEqual({ sentOffset: 0, sentSeq: 0 });
      // The source WAS offered the bytes (that is how it recognized them as
      // foreign); it simply refused them.
      expect(source.writes).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
