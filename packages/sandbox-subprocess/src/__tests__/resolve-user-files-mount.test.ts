import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { resolveUserFilesMount, type ResolveMountsOwner } from '../resolve-user-files-mount.js';

const PLUGIN = '@ax/sandbox-subprocess';

const OWNER: ResolveMountsOwner = {
  userId: 'u1',
  agentId: 'agent-abc',
  agentConfig: {
    displayName: 'A',
    systemPromptAugment: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude',
  },
};

function ctx() {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'agent-abc',
    userId: 'u1',
  });
}

function busWithResolver(out: ResolveMountsOutput): HookBus {
  const bus = new HookBus();
  bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
    'sandbox:resolve-mounts',
    'mock-resolver',
    async () => out,
  );
  return bus;
}

describe('resolveUserFilesMount (subprocess)', () => {
  it('returns {} when no resolver is registered (graceful no-mount)', async () => {
    const bus = new HookBus();
    const mkdir = vi.fn(async () => undefined);
    const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir);
    expect(res.userFilesRoot).toBeUndefined();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('returns {} when the resolver yields no mounts', async () => {
    const bus = busWithResolver({ mounts: [] });
    const mkdir = vi.fn(async () => undefined);
    const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir);
    expect(res.userFilesRoot).toBeUndefined();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('mkdir -p the localDir hostPath and stamps it as userFilesRoot', async () => {
    const bus = busWithResolver({
      mounts: [
        {
          kind: 'localDir',
          mountPath: '/workspace',
          hostPath: '/var/lib/ax/userfiles/agent-abc',
          readOnly: false,
          role: 'user-files',
        },
      ],
    });
    const made: string[] = [];
    const mkdir = vi.fn(async (p: string) => {
      made.push(p);
    });
    const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir);
    expect(made).toEqual(['/var/lib/ax/userfiles/agent-abc']);
    // The runner sees the real host path (subprocess shares the host FS).
    expect(res.userFilesRoot).toBe('/var/lib/ax/userfiles/agent-abc');
  });

  it('does NOT set userFilesRoot for a non-user-files localDir mount', async () => {
    const bus = busWithResolver({
      mounts: [
        {
          kind: 'localDir',
          mountPath: '/scratch',
          hostPath: '/tmp/x',
          readOnly: false,
        },
      ],
    });
    const mkdir = vi.fn(async () => undefined);
    const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir);
    expect(mkdir).toHaveBeenCalledWith('/tmp/x');
    expect(res.userFilesRoot).toBeUndefined();
  });

  it('throws on an unrealizable kind (nfs) — never a silent skip', async () => {
    const bus = busWithResolver({
      mounts: [
        {
          kind: 'nfs',
          mountPath: '/workspace',
          server: '10.0.0.2',
          exportPath: '/vol1/agents',
          subPath: 'agent-abc',
          readOnly: false,
          role: 'user-files',
        },
      ],
    });
    const mkdir = vi.fn(async () => undefined);
    await expect(
      resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir),
    ).rejects.toBeInstanceOf(PluginError);
    expect(mkdir).not.toHaveBeenCalled();
  });
});
