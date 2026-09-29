import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Host-wide cap on concurrent testcontainer STARTS. (TASK-398)
 *
 * Why this exists: a full local gate runs up to four packages at once, each with
 * a vitest fork per core, and every Postgres-backed test file starts its own
 * container in `beforeAll`. Several builders on one machine multiply that. On
 * 2026-09-19 that left 34 containers starting at once, most never passing their
 * readiness check, and the timed-out `beforeAll`s reported 0 assertions and left
 * the containers behind. They were not broken. One reached healthy in 56s. They
 * were starved.
 *
 * So a container start takes one of a fixed number of slots first. A slot is
 * held only while `start()` runs. Once the container is up the slot goes back,
 * so this bounds how many containers are booting at once, not how many exist.
 *
 * Slots are symlinks in a shared directory. Every process on the host that uses
 * this harness (every vitest fork, every package, every worktree) contends for
 * the same slots. An in-process counter would not do: each fork is its own
 * process. A symlink is created atomically with its content, so a slot always
 * names its holder (`<pid>:<nonce>`). A slot whose holder process is gone, or
 * that has been held longer than any start could take, is reclaimed. That is
 * what stops a killed test run from wedging every run after it.
 *
 * Queue wait is bounded and named. Hook budgets here are 60s or 120s, and a
 * `beforeAll` that spends them all queueing would time out as if the container
 * had failed. So waiting is announced through `warn` when it begins, and if it
 * lasts past the wait budget the start fails with an error that says it was
 * queueing, not starting. That budget (40s) sits under the smallest hook budget
 * in the repo (60s), so the named error wins that race. It also means a start
 * that gave up waiting never runs later, after its hook is gone, to leave an
 * orphaned container behind.
 */

export const CONTAINER_START_SLOTS_DEFAULT = 4;
export const CONTAINER_START_SLOT_WAIT_MS_DEFAULT = 40_000;
const SLOTS_MAX = 64;
const WAIT_MS_MAX = 600_000;
/** A slot held this long is reclaimable even if its holder pid looks alive. */
export const CONTAINER_START_SLOT_STALE_MS = 10 * 60_000;
/** A reclaim marker older than this is abandoned (its reclaimer died mid-reclaim). */
const RECLAIM_MARKER_STALE_MS = 60_000;
const POLL_MS = 100;

const SLOTS_ENV = 'AX_TESTCONTAINER_START_SLOTS';
const WAIT_ENV = 'AX_TESTCONTAINER_START_SLOT_WAIT_MS';
const DIR_ENV = 'AX_TESTCONTAINER_START_SLOT_DIR';

interface SlotConfig {
  slots: number;
  waitMs: number;
  dir: string;
}

function intFromEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) {
    throw new Error(`Docker test configuration: ${name} must be a whole number from 1 to ${max}.`);
  }
  return Number(raw);
}

function slotConfig(): SlotConfig {
  return {
    slots: intFromEnv(SLOTS_ENV, CONTAINER_START_SLOTS_DEFAULT, SLOTS_MAX),
    waitMs: intFromEnv(WAIT_ENV, CONTAINER_START_SLOT_WAIT_MS_DEFAULT, WAIT_MS_MAX),
    dir: process.env[DIR_ENV] || join(tmpdir(), 'ax-testcontainer-start-slots'),
  };
}

function holderPid(token: string): number | undefined {
  const pid = Number(token.split(':', 1)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Still a holder.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function readSlot(path: string): Promise<{ token: string; ageMs: number } | undefined> {
  try {
    const token = await readlink(path);
    const { mtimeMs } = await lstat(path);
    return { token, ageMs: Date.now() - mtimeMs };
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Free a slot whose holder is gone. Two processes can find the same stale slot
 * at once, and the second must not delete the fresh slot the first one then
 * takes. So a reclaimer first claims `<slot>.reclaim`, re-reads the slot, and
 * deletes it only if it still names the same stale holder. Exported for tests.
 */
export async function reclaimStaleSlot(path: string, staleToken: string): Promise<void> {
  const marker = `${path}.reclaim`;
  try {
    await symlink(staleToken, marker);
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    const existing = await readSlot(marker);
    if (existing !== undefined && existing.ageMs > RECLAIM_MARKER_STALE_MS) {
      await unlink(marker).catch(() => undefined);
    }
    return;
  }
  try {
    const current = await readSlot(path);
    if (current?.token === staleToken) await unlink(path).catch(() => undefined);
  } finally {
    await unlink(marker).catch(() => undefined);
  }
}

async function tryAcquire(config: SlotConfig, token: string): Promise<string | undefined> {
  for (let i = 0; i < config.slots; i += 1) {
    const path = join(config.dir, `slot-${i}`);
    try {
      await symlink(token, path);
      return path;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    const held = await readSlot(path);
    if (held === undefined) continue;
    const pid = holderPid(held.token);
    if (pid === undefined || !alive(pid) || held.ageMs > CONTAINER_START_SLOT_STALE_MS) {
      await reclaimStaleSlot(path, held.token);
    }
  }
  return undefined;
}

async function holders(config: SlotConfig): Promise<string> {
  const pids: string[] = [];
  for (let i = 0; i < config.slots; i += 1) {
    const held = await readSlot(join(config.dir, `slot-${i}`)).catch(() => undefined);
    const pid = held === undefined ? undefined : holderPid(held.token);
    if (pid !== undefined) pids.push(String(pid));
  }
  return pids.length === 0 ? 'none' : pids.join(', ');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `start` while holding one of the host-wide container start slots.
 * The slot is released as soon as `start` settles, success or failure.
 */
export async function withContainerStartSlot<T>(
  start: () => Promise<T>,
  warn: (message: string) => void = console.warn,
): Promise<T> {
  const config = slotConfig();
  await mkdir(config.dir, { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const began = Date.now();
  let slot = await tryAcquire(config, token);
  if (slot === undefined) {
    warn(`Waiting for a container start slot: all ${config.slots} are in use (holder pids: ${await holders(config)}). Other test processes on this host are starting containers; this start will wait up to ${config.waitMs} ms. Set ${SLOTS_ENV} to change the number of slots.`);
    while (slot === undefined) {
      if (Date.now() - began >= config.waitMs) {
        throw new Error(`Waited ${config.waitMs} ms for a container start slot and none came free (${config.slots} slots, holder pids: ${await holders(config)}). The container was never started: this is queueing on a loaded host, not a container failure. Retry with fewer parallel Docker-backed test runs, or raise ${WAIT_ENV}.`);
      }
      await sleep(POLL_MS);
      slot = await tryAcquire(config, token);
    }
    warn(`Got a container start slot after waiting ${Date.now() - began} ms.`);
  }
  try {
    return await start();
  } finally {
    const current = await readSlot(slot).catch(() => undefined);
    if (current?.token === token) await unlink(slot).catch(() => undefined);
  }
}
