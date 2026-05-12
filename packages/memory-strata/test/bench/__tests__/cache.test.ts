import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchCache } from '../cache.js';

describe('BenchCache', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bench-cache-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns cached payload on hit', async () => {
    const cache = new BenchCache(dir);
    const path = await cache.getPath('demo', '1.jsonl');
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(path, 'hello');
    const buf = await cache.readIfHit('demo', '1.jsonl');
    expect(buf?.toString()).toBe('hello');
  });

  it('returns null on cache miss', async () => {
    const cache = new BenchCache(dir);
    expect(await cache.readIfHit('demo', 'missing.jsonl')).toBeNull();
  });

  it('writes payload to expected path', async () => {
    const cache = new BenchCache(dir);
    await cache.write('demo', '1.jsonl', Buffer.from('content'));
    const path = await cache.getPath('demo', '1.jsonl');
    expect(readFileSync(path).toString()).toBe('content');
  });

  it('purge deletes the dataset subdir', async () => {
    const cache = new BenchCache(dir);
    await cache.write('demo', '1.jsonl', Buffer.from('x'));
    await cache.purge('demo');
    expect(existsSync(join(dir, 'demo'))).toBe(false);
  });
});
