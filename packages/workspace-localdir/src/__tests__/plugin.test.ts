import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
  LocalDirMountSpec,
} from '@ax/sandbox-mount-protocol';
import type { OpenSessionInput } from '@ax/sandbox-protocol';
import { createWorkspaceLocaldirPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// @ax/workspace-localdir — the CLI/subprocess `sandbox:resolve-mounts` impl.
//
// Emits ONE per-agent `localDir` mount rooted under a real dev-host directory,
// keyed off `owner.agentId` (validated `^[a-z0-9-]+$`). Returns `[]` when the
// owner has no agentId (anonymous CLI session → graceful no-mount). This is
// the canary/dev path — it gives a durable per-agent `/workspace` without a
// real NFS server.
// ---------------------------------------------------------------------------

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
  pluginRoot: string,
  owner: NonNullable<OpenSessionInput['owner']>,
  mountPath?: string,
): Promise<ResolveMountsOutput> {
  const harness = await createTestHarness({
    plugins: [
      createWorkspaceLocaldirPlugin(
        mountPath !== undefined
          ? { root: pluginRoot, mountPath }
          : { root: pluginRoot },
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

describe('@ax/workspace-localdir — sandbox:resolve-mounts', () => {
  it('registers the resolve-mounts hook', async () => {
    const harness = await createTestHarness({
      plugins: [createWorkspaceLocaldirPlugin({ root: '/var/lib/ax/userfiles' })],
    });
    expect(harness.bus.hasService('sandbox:resolve-mounts')).toBe(true);
    await harness.close();
  });

  it('emits a per-agent localDir mount under <root>/<agentId>', async () => {
    const out = await resolve('/var/lib/ax/userfiles', OWNER('agent-abc'));
    expect(out.mounts).toHaveLength(1);
    const m = out.mounts[0] as LocalDirMountSpec;
    expect(m.kind).toBe('localDir');
    expect(m.mountPath).toBe('/workspace');
    expect(m.hostPath).toBe('/var/lib/ax/userfiles/agent-abc');
    expect(m.readOnly).toBe(false);
    expect(m.role).toBe('user-files');
  });

  it('honors a custom mountPath', async () => {
    const out = await resolve('/srv/files', OWNER('agent-abc'), '/data');
    const m = out.mounts[0] as LocalDirMountSpec;
    expect(m.mountPath).toBe('/data');
  });

  it('returns [] when the owner has no agentId (anonymous CLI)', async () => {
    const out = await resolve('/var/lib/ax/userfiles', OWNER(''));
    expect(out.mounts).toEqual([]);
  });

  it.each(['../escape', 'Agent-Abc', 'a/b', 'a b', '.', 'a..b', '/abs'])(
    'returns [] for an agentId that fails ^[a-z0-9-]+$ (%s)',
    async (bad) => {
      const out = await resolve('/var/lib/ax/userfiles', OWNER(bad));
      expect(out.mounts).toEqual([]);
    },
  );

  it('accepts a valid lowercase-alnum-dash agentId', async () => {
    const out = await resolve('/root', OWNER('a-1-z'));
    const m = out.mounts[0] as LocalDirMountSpec;
    expect(m.hostPath).toBe('/root/a-1-z');
  });
});
