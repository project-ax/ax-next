import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';

describe('Store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mock-store-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists across Store instances', () => {
    const a = new Store(dir);
    a.collection<{ id: string }>('agents').upsert({ id: 'a1' });
    const b = new Store(dir);
    expect(b.collection<{ id: string }>('agents').list()).toEqual([{ id: 'a1' }]);
  });

  it('seeds the default fixture set on first read of an empty dir', () => {
    const s = new Store(dir);
    s.seed();
    expect(s.collection<{ id: string }>('agents').list().length).toBeGreaterThanOrEqual(2);
    expect(s.collection<{ id: string }>('users').list().length).toBeGreaterThanOrEqual(1);
  });
});
