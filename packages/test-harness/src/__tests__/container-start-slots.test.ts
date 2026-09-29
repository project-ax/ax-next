import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_START_SLOTS_DEFAULT,
  CONTAINER_START_SLOT_WAIT_MS_DEFAULT,
  reclaimStaleSlot,
  withContainerStartSlot,
} from '../container-start-slots.js';

// TASK-398. These tests hold slots on purpose and never race a wall clock for a
// pass: every wait budget set here is the behaviour under test (the named
// "queueing" error), reached while a slot is deliberately held.

const here = dirname(fileURLToPath(import.meta.url));
// The children load the SOURCE (Node 24 strips the types), so a change to the
// module is what they run, with no build step in between.
const source = join(here, '../container-start-slots.ts');

let dir: string;
const warn = vi.fn<(message: string) => void>();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ax-start-slots-'));
  vi.stubEnv('AX_TESTCONTAINER_START_SLOT_DIR', join(dir, 'slots'));
  vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', undefined);
  vi.stubEnv('AX_TESTCONTAINER_START_SLOT_WAIT_MS', undefined);
  warn.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('withContainerStartSlot', () => {
  it('defaults to 4 slots and a wait budget under the smallest 60s hook budget', () => {
    expect(CONTAINER_START_SLOTS_DEFAULT).toBe(4);
    expect(CONTAINER_START_SLOT_WAIT_MS_DEFAULT).toBeLessThan(60_000);
  });

  it('never runs more starts at once than there are slots', async () => {
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '3');
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 12 }, () => deferred());
    const runs = gates.map((gate) => withContainerStartSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    }, warn));
    // Three get in; nothing else can until one finishes.
    await until(() => active === 3);
    // Let everyone who could get in get in, then release one at a time.
    for (const gate of gates) {
      await new Promise((r) => setTimeout(r, 30));
      gate.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Waiting for a container start slot: all 3 are in use/));
  });

  it('bounds starts across separate processes, not just within one', async () => {
    // Each vitest fork is its own process, so an in-process counter would let
    // every fork start at once. Children share only the slot directory.
    const active = join(dir, 'active');
    const child = join(dir, 'child.mjs');
    await writeFile(child, `
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { withContainerStartSlot } = await import(${JSON.stringify(pathToFileURL(source).href)});
const active = ${JSON.stringify(active)};
mkdirSync(active, { recursive: true });
let peak = 0;
await withContainerStartSlot(async () => {
  const mine = join(active, String(process.pid));
  writeFileSync(mine, '');
  for (let i = 0; i < 20; i += 1) {
    peak = Math.max(peak, readdirSync(active).length);
    await new Promise((r) => setTimeout(r, 10));
  }
  rmSync(mine);
}, () => {});
process.stdout.write(String(peak));
`);
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '2');
    const peaks = await Promise.all(Array.from({ length: 6 }, () => new Promise<number>((resolve, reject) => {
      const proc = spawn(process.execPath, [child], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      proc.on('error', reject);
      proc.on('exit', (status) => (status === 0 ? resolve(Number(out)) : reject(new Error(`child exited ${status}`))));
    })));
    expect(peaks).toHaveLength(6);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
    expect(await readdir(active)).toEqual([]);
  }, 60_000);

  it('gives up with a named queueing error instead of eating the hook budget, and never starts', async () => {
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '1');
    vi.stubEnv('AX_TESTCONTAINER_START_SLOT_WAIT_MS', '300');
    const hold = deferred();
    let holding = false;
    const holder = withContainerStartSlot(async () => { holding = true; await hold.promise; }, warn);
    await until(() => holding);
    const start = vi.fn(async () => 'started');
    await expect(withContainerStartSlot(start, warn)).rejects.toThrow(
      /Waited 300 ms for a container start slot.*never started.*queueing on a loaded host, not a container failure/,
    );
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`holder pids: ${process.pid}`)));
    hold.resolve();
    await holder;
  });

  it('releases the slot when the start fails', async () => {
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '1');
    vi.stubEnv('AX_TESTCONTAINER_START_SLOT_WAIT_MS', '300');
    const failure = new Error('fixture start failed');
    await expect(withContainerStartSlot(async () => { throw failure; }, warn)).rejects.toBe(failure);
    await expect(withContainerStartSlot(async () => 'next', warn)).resolves.toBe('next');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reclaims a slot whose holder process has exited', async () => {
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '1');
    vi.stubEnv('AX_TESTCONTAINER_START_SLOT_WAIT_MS', '300');
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(exited.stdout);
    expect(deadPid).toBeGreaterThan(0);
    const slots = join(dir, 'slots');
    await mkdir(slots, { recursive: true });
    await symlink(`${deadPid}:left-by-a-killed-run`, join(slots, 'slot-0'));
    await expect(withContainerStartSlot(async () => 'reclaimed', warn)).resolves.toBe('reclaimed');
    expect(readdirSync(slots)).toEqual([]);
  });

  it('a late reclaimer does not delete the fresh slot another process just took', async () => {
    // Two processes can both see the same dead holder. The first reclaims and a new
    // start takes the slot; the second, arriving late with the stale token, must
    // leave the new holder's slot alone.
    const slots = join(dir, 'slots');
    await mkdir(slots, { recursive: true });
    const slot = join(slots, 'slot-0');
    await symlink(`${process.pid}:fresh-holder`, slot);
    await reclaimStaleSlot(slot, '999999:the-dead-holder-it-saw');
    expect(readdirSync(slots)).toEqual(['slot-0']);
  });

  it('does not reclaim a slot whose holder is alive', async () => {
    vi.stubEnv('AX_TESTCONTAINER_START_SLOTS', '1');
    vi.stubEnv('AX_TESTCONTAINER_START_SLOT_WAIT_MS', '300');
    const slots = join(dir, 'slots');
    await mkdir(slots, { recursive: true });
    await symlink(`${process.pid}:someone-else-in-this-process`, join(slots, 'slot-0'));
    const start = vi.fn(async () => 'started');
    await expect(withContainerStartSlot(start, warn)).rejects.toThrow(/Waited 300 ms for a container start slot/);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['AX_TESTCONTAINER_START_SLOTS', '0'],
    ['AX_TESTCONTAINER_START_SLOTS', 'many'],
    ['AX_TESTCONTAINER_START_SLOTS', '65'],
    ['AX_TESTCONTAINER_START_SLOT_WAIT_MS', '-1'],
    ['AX_TESTCONTAINER_START_SLOT_WAIT_MS', '1.5'],
  ])('rejects %s=%s before starting anything', async (name, value) => {
    vi.stubEnv(name, value);
    const start = vi.fn(async () => 'started');
    await expect(withContainerStartSlot(start, warn)).rejects.toThrow(new RegExp(`${name} must be a whole number`));
    expect(start).not.toHaveBeenCalled();
  });
});
