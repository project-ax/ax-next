import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasResumableTranscript,
  readLastTurnUuid,
  waitForTurnTranscript,
} from '../turn-end-uuid.js';

function writeJsonl(root: string, sessionId: string, body: string): void {
  const projDir = join(root, '.claude', 'projects', 'my-proj');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${sessionId}.jsonl`), body);
}

describe('readLastTurnUuid', () => {
  it('returns the uuid of the last assistant line in the jsonl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-uuid-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'user', uuid: 'u1' }),
          JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }),
          JSON.stringify({ type: 'assistant', uuid: 'a2', message: { id: 'm2' } }),
        ].join('\n') + '\n',
      );
      const uuid = await readLastTurnUuid(root, 'sess', 'assistant');
      expect(uuid).toBe('a2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when no matching line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-uuid-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n');
      expect(await readLastTurnUuid(root, 'sess', 'assistant')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined on missing file/projects-dir', async () => {
    expect(
      await readLastTurnUuid('/does/not/exist', 'sess', 'assistant'),
    ).toBeUndefined();
  });

  it('returns undefined when the most-recent line is malformed (fail closed)', async () => {
    // A partial-write at the tail must NOT cause us to return an older
    // UUID from further back — that would target the WRONG turn for
    // drop-turn. The function fails closed instead.
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-uuid-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }),
          '{"type":"assistant","uuid":"a2","message":{', // truncated
        ].join('\n') + '\n',
      );
      expect(await readLastTurnUuid(root, 'sess', 'assistant')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hasResumableTranscript', () => {
  // F2a: `query({ resume: X })` hard-crashes with "No conversation found with
  // session ID: X" whenever the jsonl for X has NO parseable user/assistant
  // message. These cases mirror the live SDK repro matrix (2026-05-24): the
  // first five throw on resume, the last three resume cleanly.

  it('returns false when the projects dir / jsonl is missing', async () => {
    expect(await hasResumableTranscript('/does/not/exist', 'sess')).toBe(false);
  });

  it('returns false for an empty jsonl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(root, 'sess', '');
      expect(await hasResumableTranscript(root, 'sess')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false for a metadata-only jsonl (no user/assistant lines)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(
        root,
        'sess',
        [
          JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
          JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }),
          JSON.stringify({ type: 'ai-title', aiTitle: 'x' }),
        ].join('\n') + '\n',
      );
      expect(await hasResumableTranscript(root, 'sess')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when the only user line is truncated mid-write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(
        root,
        'sess',
        JSON.stringify({ type: 'queue-operation' }) +
          '\n' +
          '{"type":"user","message":{"role":"user","content":[{', // truncated
      );
      expect(await hasResumableTranscript(root, 'sess')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false for an all-garbage jsonl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(root, 'sess', '{this is not valid json\n');
      expect(await hasResumableTranscript(root, 'sess')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true for a lone user line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(
        root,
        'sess',
        JSON.stringify({ type: 'queue-operation' }) +
          '\n' +
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            uuid: 'u1',
          }) +
          '\n',
      );
      expect(await hasResumableTranscript(root, 'sess')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true for a user + assistant transcript even with a truncated trailing metadata line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-resumable-'));
    try {
      writeJsonl(
        root,
        'sess',
        JSON.stringify({ type: 'user', uuid: 'u1' }) +
          '\n' +
          JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }) +
          '\n' +
          '{"type":"last-prompt","lastP', // truncated trailing line
      );
      expect(await hasResumableTranscript(root, 'sess')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('waitForTurnTranscript', () => {
  // The Anthropic SDK writes the assistant turn's jsonl line AFTER it yields
  // `result` to the runner. The per-turn commit must wait for that line to
  // land, else the just-finished reply is missing from the committed bundle
  // and only surfaces at the next turn / idle-reap (the multi-minute lag).
  // waitForTurnTranscript polls the jsonl until a NEW assistant uuid appears.

  it('resolves with the new assistant uuid once a delayed write lands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-wait-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      // Turn starts with one prior assistant line already on disk.
      writeFileSync(
        file,
        JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }) +
          '\n',
      );
      // Simulate the SDK flushing this turn's assistant line ~80ms after the
      // wait begins (i.e. after the `result` boundary the caller is at).
      const timer = setTimeout(() => {
        appendFileSync(
          file,
          JSON.stringify({
            type: 'assistant',
            uuid: 'a2',
            message: { id: 'm2' },
          }) + '\n',
        );
      }, 80);
      try {
        const uuid = await waitForTurnTranscript(root, 'sess', 'a1', {
          timeoutMs: 2000,
          intervalMs: 10,
        });
        expect(uuid).toBe('a2');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves with the first assistant uuid when there is no prior baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-wait-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      const timer = setTimeout(() => {
        writeFileSync(
          file,
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            message: { id: 'm1' },
          }) + '\n',
        );
      }, 60);
      try {
        const uuid = await waitForTurnTranscript(root, 'sess', undefined, {
          timeoutMs: 2000,
          intervalMs: 10,
        });
        expect(uuid).toBe('a1');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves undefined when no new assistant line appears within the timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-runner-wait-'));
    try {
      const projDir = join(root, '.claude', 'projects', 'my-proj');
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, 'sess.jsonl');
      // Only the prior turn's line exists; the new one never lands.
      writeFileSync(
        file,
        JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }) +
          '\n',
      );
      const started = Date.now();
      const uuid = await waitForTurnTranscript(root, 'sess', 'a1', {
        timeoutMs: 80,
        intervalMs: 10,
      });
      expect(uuid).toBeUndefined();
      // It actually waited (bounded) rather than returning instantly.
      expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
