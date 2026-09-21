import { mkdtemp, rm, mkdir, readFile, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FACTS_EXPORT_ROOT } from '@ax/core';

import { factsPath, type FactsPath } from '../export-paths.js';
import {
  memoryMountSpec,
  syncFactsVolume,
  validateVolumeConfig,
  volumeAgentKey,
  type MemoryVolumeConfig,
} from '../export-volume.js';

const ROOT = MEMORY_FACTS_EXPORT_ROOT;

let dir: string;
let volume: MemoryVolumeConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ax-export-vol-'));
  volume = {
    hostRoot: dir,
    backing: { server: 'nfs.internal', exportPath: '/srv/ax/memory' },
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function agentFactsDir(agentId: string): string {
  return join(dir, volumeAgentKey(agentId), ...ROOT.split('/'));
}

describe('validateVolumeConfig', () => {
  it.each([
    ['relative hostRoot', { hostRoot: 'rel/dir' }],
    ['non-string hostRoot', { hostRoot: 5 }],
    ['filesystem-root hostRoot', { hostRoot: '/' }],
    ['hostRoot that normalizes to the filesystem root', { hostRoot: '/tmp/..' }],
    ['empty backing server', { backing: { server: ' ', exportPath: '/e' } }],
    ['missing backing server', { backing: { exportPath: '/e' } }],
    ['relative exportPath', { backing: { server: 's', exportPath: 'rel' } }],
    ['missing exportPath', { backing: { server: 's' } }],
  ])('rejects %s', (_label, over) => {
    expect(() =>
      validateVolumeConfig({ ...volume, ...over } as MemoryVolumeConfig),
    ).toThrow();
  });

  it('accepts a well-formed config', () => {
    expect(() => validateVolumeConfig(volume)).not.toThrow();
  });
});

describe('memoryMountSpec', () => {
  it('returns one read-only NFS mount at /memory under the hashed agent dir', () => {
    const spec = memoryMountSpec('agent-1', volume);
    expect(spec).toEqual({
      kind: 'nfs',
      role: 'memory',
      mountPath: '/memory',
      server: 'nfs.internal',
      exportPath: '/srv/ax/memory',
      subPath: `${volumeAgentKey('agent-1')}/${ROOT}`,
      readOnly: true,
    });
  });

  it('gives different agents different subPaths and the same agent a stable one', () => {
    const a = memoryMountSpec('agent-1', volume);
    const b = memoryMountSpec('agent-2', volume);
    expect(a.subPath).not.toBe(b.subPath);
    expect(memoryMountSpec('agent-1', volume).subPath).toBe(a.subPath);
    expect(volumeAgentKey('agent-1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('syncFactsVolume', () => {
  it('publishes the desired files under the agent’s own facts dir', async () => {
    const desired = new Map<FactsPath, string>([
      [factsPath({ kind: 'profile' }), '# Profile\n\n- lives_in: Seattle\n'],
      [factsPath({ kind: 'journal', speaker: 'user', month: '2026-09' }), '# User memories — 2026-09\n\n- x\n'],
    ]);
    await syncFactsVolume(volume, 'agent-1', desired);
    const facts = agentFactsDir('agent-1');
    await expect(readFile(join(facts, 'profile.md'), 'utf-8')).resolves.toContain('Seattle');
    await expect(readFile(join(facts, 'user/2026-09.md'), 'utf-8')).resolves.toContain('- x');
  });

  it('does not rewrite a file whose content is unchanged', async () => {
    const desired = new Map<FactsPath, string>([
      [factsPath({ kind: 'profile' }), '# Profile\n\nsame\n'],
    ]);
    await syncFactsVolume(volume, 'agent-1', desired);
    const target = join(agentFactsDir('agent-1'), 'profile.md');
    const before = await stat(target);
    await new Promise((r) => setTimeout(r, 10));
    await syncFactsVolume(volume, 'agent-1', desired);
    const after = await stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('removes only known obsolete FactsPaths and leaves foreign files alone', async () => {
    const desired = new Map<FactsPath, string>([
      [factsPath({ kind: 'profile' }), '# Profile\n\nnew\n'],
    ]);
    await syncFactsVolume(volume, 'agent-1', desired);
    const facts = agentFactsDir('agent-1');
    const obsolete = join(facts, 'recent.md');
    const foreign = join(facts, 'notes.txt');
    await writeFile(obsolete, 'stale');
    await writeFile(foreign, 'not ours');
    await syncFactsVolume(volume, 'agent-1', desired);
    await expect(stat(obsolete)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(foreign, 'utf-8')).resolves.toBe('not ours');
  });

  it('refuses to write through a symlinked directory inside the facts tree', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ax-export-outside-'));
    try {
      const facts = agentFactsDir('agent-1');
      await mkdir(facts, { recursive: true });
      await symlink(outside, join(facts, 'about'));
      const desired = new Map<FactsPath, string>([
        [factsPath({ kind: 'subject', subject: 'acme' }), '# acme\n\n- x\n'],
      ]);
      await expect(syncFactsVolume(volume, 'agent-1', desired)).rejects.toThrow();
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(outside));
      expect(entries).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a non-regular file already occupying a target path', async () => {
    const facts = agentFactsDir('agent-1');
    await mkdir(facts, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'ax-export-victim-'));
    try {
      await symlink(join(outside, 'victim.md'), join(facts, 'profile.md'));
      const desired = new Map<FactsPath, string>([
        [factsPath({ kind: 'profile' }), '# Profile\n\nx\n'],
      ]);
      await expect(syncFactsVolume(volume, 'agent-1', desired)).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an agent dir that is a symlink to outside, and outside stays empty', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ax-export-outside-'));
    try {
      await symlink(outside, join(dir, volumeAgentKey('agent-1')));
      const desired = new Map<FactsPath, string>([
        [factsPath({ kind: 'profile' }), '# Profile\n\nx\n'],
      ]);
      await expect(syncFactsVolume(volume, 'agent-1', desired)).rejects.toThrow();
      await expect(
        (await import('node:fs/promises')).readdir(outside),
      ).resolves.toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an agent dir symlinked at a sibling agent — the victim stays untouched', async () => {
    const desired = new Map<FactsPath, string>([
      [factsPath({ kind: 'profile' }), '# Profile\n\nvictim\n'],
    ]);
    await syncFactsVolume(volume, 'agent-2', desired);
    const victimProfile = join(agentFactsDir('agent-2'), 'profile.md');
    await symlink(join(dir, volumeAgentKey('agent-2')), join(dir, volumeAgentKey('agent-1')));
    await expect(
      syncFactsVolume(volume, 'agent-1', new Map([[factsPath({ kind: 'profile' }), '# Profile\n\nattacker\n']])),
    ).rejects.toThrow();
    await expect(readFile(victimProfile, 'utf-8')).resolves.toContain('victim');
  });

  it('refuses when a reserved intermediate dir (permanent) is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ax-export-outside-'));
    try {
      const agentDir = join(dir, volumeAgentKey('agent-1'));
      await mkdir(agentDir, { recursive: true });
      await symlink(outside, join(agentDir, 'permanent'));
      const desired = new Map<FactsPath, string>([
        [factsPath({ kind: 'profile' }), '# Profile\n\nx\n'],
      ]);
      await expect(syncFactsVolume(volume, 'agent-1', desired)).rejects.toThrow();
      await expect(
        (await import('node:fs/promises')).readdir(outside),
      ).resolves.toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a desired path that never went through the branded constructor', async () => {
    const forged = new Map<FactsPath, string>([
      ['permanent/memory/system/rules.md' as FactsPath, '# forged\n'],
    ]);
    await expect(syncFactsVolume(volume, 'agent-1', forged)).rejects.toThrow();
    await expect(
      stat(join(dir, volumeAgentKey('agent-1'), 'permanent/memory/system/rules.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never writes outside the agent dir — two agents are disjoint', async () => {
    const desired = new Map<FactsPath, string>([
      [factsPath({ kind: 'profile' }), '# Profile\n\n- a\n'],
    ]);
    await syncFactsVolume(volume, 'agent-1', desired);
    await syncFactsVolume(volume, 'agent-2', desired);
    expect(agentFactsDir('agent-1')).not.toBe(agentFactsDir('agent-2'));
    await expect(stat(join(agentFactsDir('agent-2'), 'profile.md'))).resolves.toBeDefined();
  });
});
