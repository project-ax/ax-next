import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, parse, posix, resolve, sep } from 'node:path';

import { MEMORY_FACTS_EXPORT_ROOT, safePath } from '@ax/core';
import type { NfsMountSpec } from '@ax/sandbox-mount-protocol';

import { parseFactsPath, type FactsPath } from './export-paths.js';

export const MEMORY_MOUNT_PATH = '/memory';

export interface MemoryVolumeConfig {
  hostRoot: string;
  backing: { server: string; exportPath: string };
}

export function volumeAgentKey(agentId: string): string {
  return createHash('sha256').update(JSON.stringify([agentId])).digest('hex');
}

export function validateVolumeConfig(volume: MemoryVolumeConfig): void {
  if (typeof volume.hostRoot !== 'string' || !isAbsolute(volume.hostRoot)) {
    throw new Error('memory export volume hostRoot must be an absolute path');
  }
  const hostRoot = resolve(volume.hostRoot);
  if (hostRoot === parse(hostRoot).root) {
    throw new Error('memory export volume hostRoot must not be the filesystem root');
  }
  if (
    typeof volume.backing?.server !== 'string' ||
    volume.backing.server.trim() === '' ||
    typeof volume.backing?.exportPath !== 'string' ||
    !posix.isAbsolute(volume.backing.exportPath)
  ) {
    throw new Error(
      'memory export volume backing must name a non-empty server and an absolute exportPath',
    );
  }
}

export function memoryMountSpec(agentId: string, volume: MemoryVolumeConfig): NfsMountSpec {
  return {
    kind: 'nfs',
    role: 'memory',
    mountPath: MEMORY_MOUNT_PATH,
    server: volume.backing.server,
    exportPath: volume.backing.exportPath,
    subPath: `${volumeAgentKey(agentId)}/${MEMORY_FACTS_EXPORT_ROOT}`,
    readOnly: true,
  };
}

function assertConfined(baseReal: string, targetReal: string): void {
  if (targetReal !== baseReal && !targetReal.startsWith(baseReal + sep)) {
    throw new Error(`export volume path escapes its root: ${targetReal}`);
  }
}

async function lstatOrAbsent(path: string) {
  const stat = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  return stat;
}

async function ensureDirComponent(parent: string, name: string, anchor: string): Promise<string> {
  const dir = join(parent, name);
  const stat = await lstatOrAbsent(dir);
  if (stat !== undefined) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`export volume refuses a non-directory component: ${dir}`);
    }
  } else {
    await fs.mkdir(dir);
  }
  const real = await fs.realpath(dir);
  assertConfined(anchor, real);
  return dir;
}

export async function syncFactsVolume(
  volume: MemoryVolumeConfig,
  agentId: string,
  desired: ReadonlyMap<FactsPath, string>,
): Promise<void> {
  validateVolumeConfig(volume);
  const hostRoot = resolve(volume.hostRoot);
  await fs.mkdir(hostRoot, { recursive: true });
  const hostReal = await fs.realpath(hostRoot);
  if (hostReal === parse(hostReal).root) {
    throw new Error('memory export volume hostRoot resolves to the filesystem root');
  }

  const desiredChecked = new Map<FactsPath, string>();
  for (const [factsPath, content] of desired) {
    if (parseFactsPath(factsPath) !== factsPath) {
      throw new Error(`export volume refused an unparseable facts path: ${factsPath}`);
    }
    desiredChecked.set(factsPath, content);
  }

  const agentDir = await ensureDirComponent(hostReal, volumeAgentKey(agentId), hostReal);
  const agentReal = await fs.realpath(agentDir);
  assertConfined(hostReal, agentReal);
  if (agentReal !== agentDir && agentReal !== join(hostReal, volumeAgentKey(agentId))) {
    throw new Error(`export volume agent dir resolves outside its slot: ${agentReal}`);
  }

  let factsDir = agentDir;
  for (const segment of MEMORY_FACTS_EXPORT_ROOT.split('/')) {
    factsDir = await ensureDirComponent(factsDir, segment, agentReal);
  }
  const factsReal = await fs.realpath(factsDir);
  assertConfined(agentReal, factsReal);

  const keep = new Set<string>();
  for (const [factsPath, content] of desiredChecked) {
    const rel = factsPath.slice(MEMORY_FACTS_EXPORT_ROOT.length + 1);
    const segments = rel.split('/');
    const target = safePath(factsDir, ...segments);
    let parentDir = factsDir;
    for (const segment of segments.slice(0, -1)) {
      parentDir = await ensureDirComponent(parentDir, segment, factsReal);
    }
    const leaf = await lstatOrAbsent(target);
    if (leaf !== undefined && (!leaf.isFile() || leaf.isSymbolicLink())) {
      throw new Error(`export volume refuses a non-regular file: ${target}`);
    }
    keep.add(target);
    const tmp = join(parentDir, `.export-${randomUUID()}.tmp`);
    const existing = leaf === undefined ? undefined : await fs.readFile(target);
    if (existing !== undefined && existing.equals(Buffer.from(content, 'utf-8'))) continue;
    try {
      await fs.writeFile(tmp, content, { encoding: 'utf-8', flag: 'wx' });
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`export volume refuses a symlink inside the facts tree: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`export volume refuses a non-regular file: ${entryPath}`);
      }
      if (keep.has(entryPath)) continue;
      const rel = entryPath.slice(factsDir.length + 1).split(sep).join('/');
      const parsed = parseFactsPath(`${MEMORY_FACTS_EXPORT_ROOT}/${rel}`);
      if (parsed !== undefined && !desiredChecked.has(parsed)) {
        await fs.unlink(entryPath);
      }
    }
  };
  await walk(factsDir);
}
