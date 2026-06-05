import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import {
  encodeProjectSlug,
  hashBytes,
  restoreTranscriptForResume,
  shipTranscriptDelta,
  splitCompleteLines,
} from '../transcript-delta.js';

function writeJsonl(root: string, sessionId: string, body: string): string {
  const projDir = join(root, '.claude', 'projects', 'my-proj');
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  return file;
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

describe('encodeProjectSlug', () => {
  it('mirrors the SDK encoding (realpath cwd → non-alnum to dash)', () => {
    expect(encodeProjectSlug('/permanent')).toBe('-permanent');
    expect(encodeProjectSlug('/var/lib/ax')).toBe('-var-lib-ax');
  });

  it('truncates + hash-suffixes an over-200-char path (SDK P0 cap)', () => {
    const longPath = '/' + 'a'.repeat(250);
    const slug = encodeProjectSlug(longPath);
    // dashed = '-' + 250 'a' = 251 chars > 200 → truncate to 200 + '-' + hash.
    const dashed = longPath.replace(/[^a-zA-Z0-9]/g, '-');
    // Reproduce the SDK's djb2-style hash to pin the exact suffix.
    let h = 0;
    for (let i = 0; i < longPath.length; i++) {
      h = ((h << 5) - h + longPath.charCodeAt(i)) | 0;
    }
    const expected = `${dashed.slice(0, 200)}-${Math.abs(h).toString(36)}`;
    expect(slug).toBe(expected);
    expect(slug.startsWith(dashed.slice(0, 200))).toBe(true);
  });
});

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
        workspaceRoot: root,
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
        workspaceRoot: root,
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
        workspaceRoot: root,
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
        workspaceRoot: root,
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
        workspaceRoot: root,
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
        workspaceRoot: root,
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

  it('is no-jsonl when the file does not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const client = fakeClient({});
      const res = await shipTranscriptDelta({
        client,
        workspaceRoot: root,
        sessionId: 'missing',
        state: { sentOffset: 0, sentSeq: 0 },
      });
      expect(res.outcome).toBe('no-jsonl');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('restoreTranscriptForResume', () => {
  it('writes the rebuilt jsonl to the SDK slug path and seeds the ship state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-tx-'));
    try {
      const rebuilt = 'u1\na1\na2\n';
      // Fake callBinary drains the host bytes to a temp file (as the real one does).
      const tmpFile = join(tmpdir(), `ax-restore-${Date.now()}.bin`);
      await writeFile(tmpFile, rebuilt);
      const client = fakeClient({
        callBinary: vi.fn(async () => ({ path: tmpFile, bytes: rebuilt.length })) as never,
      });

      const res = await restoreTranscriptForResume({
        client,
        workspaceRoot: root,
        sessionId: 'sess-resume',
      });
      expect(res.written).toBe(true);
      expect(res.state.sentSeq).toBe(3);
      expect(res.state.sentOffset).toBe(rebuilt.length);

      // The jsonl landed at the SDK slug path so query({resume}) can read it.
      const { realpathSync } = await import('node:fs');
      const slug = encodeProjectSlug(realpathSync(root));
      const written = readFileSync(
        join(root, '.claude', 'projects', slug, 'sess-resume.jsonl'),
        'utf8',
      );
      expect(written).toBe(rebuilt);
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
      const res = await restoreTranscriptForResume({
        client,
        workspaceRoot: root,
        sessionId: 'sess-empty',
      });
      expect(res.written).toBe(false);
      expect(res.state).toEqual({ sentOffset: 0, sentSeq: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
