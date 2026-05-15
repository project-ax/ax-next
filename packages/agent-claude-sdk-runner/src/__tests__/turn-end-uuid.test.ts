import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastTurnUuid } from '../turn-end-uuid.js';

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
