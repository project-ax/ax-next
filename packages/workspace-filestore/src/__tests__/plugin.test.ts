import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
  NfsMountSpec,
} from '@ax/sandbox-mount-protocol';
import type { OpenSessionInput } from '@ax/sandbox-protocol';
import { createWorkspaceFilestorePlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// @ax/workspace-filestore — the k8s/prod `sandbox:resolve-mounts` impl.
//
// Emits ONE per-agent `nfs` mount into a shared Filestore export, keyed off
// `owner.agentId` (the `subPath`, validated `^[a-z0-9-]+$`). Returns `[]` when
// the owner has no usable agentId.
// ---------------------------------------------------------------------------

const BACKING = { server: '10.0.0.2', exportPath: '/vol1/agents' };

const OWNER = (
  agentId: string,
): NonNullable<OpenSessionInput['owner']> => ({
  userId: 'user-1',
  agentId,
  agentConfig: {
    displayName: 'A',
    systemPromptAugment: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude',
  },
});

async function resolve(
  owner: NonNullable<OpenSessionInput['owner']>,
  mountPath?: string,
): Promise<ResolveMountsOutput> {
  const harness = await createTestHarness({
    plugins: [
      createWorkspaceFilestorePlugin(
        mountPath !== undefined
          ? { backing: BACKING, mountPath }
          : { backing: BACKING },
      ),
    ],
  });
  try {
    return await harness.bus.call<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      harness.ctx(),
      { owner },
    );
  } finally {
    await harness.close();
  }
}

describe('@ax/workspace-filestore — sandbox:resolve-mounts', () => {
  it('registers the resolve-mounts hook', async () => {
    const harness = await createTestHarness({
      plugins: [createWorkspaceFilestorePlugin({ backing: BACKING })],
    });
    expect(harness.bus.hasService('sandbox:resolve-mounts')).toBe(true);
    await harness.close();
  });

  it('emits a per-agent nfs mount with subPath=<agentId>', async () => {
    const out = await resolve(OWNER('agent-abc'));
    expect(out.mounts).toHaveLength(1);
    const m = out.mounts[0] as NfsMountSpec;
    expect(m.kind).toBe('nfs');
    expect(m.mountPath).toBe('/workspace');
    expect(m.server).toBe('10.0.0.2');
    expect(m.exportPath).toBe('/vol1/agents');
    expect(m.subPath).toBe('agent-abc');
    expect(m.readOnly).toBe(false);
    expect(m.role).toBe('user-files');
  });

  it('honors a custom mountPath', async () => {
    const out = await resolve(OWNER('agent-abc'), '/data');
    const m = out.mounts[0] as NfsMountSpec;
    expect(m.mountPath).toBe('/data');
  });

  it('returns [] when the owner has no agentId (anonymous)', async () => {
    const out = await resolve(OWNER(''));
    expect(out.mounts).toEqual([]);
  });

  it.each(['../escape', 'Agent-Abc', 'a/b', 'a b', '.', 'a..b', '/abs'])(
    'returns [] for an agentId that fails ^[a-z0-9-]+$ (%s)',
    async (bad) => {
      const out = await resolve(OWNER(bad));
      expect(out.mounts).toEqual([]);
    },
  );
});
