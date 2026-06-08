import { randomBytes } from 'node:crypto';
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
// `owner.agentId` (the `subPath`, validated `^[A-Za-z0-9_-]+$` — the base64url
// alphabet, matching real `agt_<base64url>` ids). Returns `[]` when the owner
// has no usable agentId.
// ---------------------------------------------------------------------------

// Mint a real agentId exactly the way `@ax/agents` does (store.ts:mintAgentId).
// 16 random bytes → base64url, prefixed `agt_`. Real ids always contain `_`
// (the prefix separator) and usually uppercase — the shape that the original
// `^[a-z0-9-]+$` gate rejected, leaving the user-files mount inert (TASK-175).
function mintRealAgentId(): string {
  return `agt_${randomBytes(16).toString('base64url')}`;
}

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

  // TASK-175 regression: a REAL minted id (`agt_<base64url>`, with `_` and
  // usually uppercase) MUST resolve to a confined per-agent subPath. The
  // original `^[a-z0-9-]+$` gate rejected every real agent → no mount, no
  // `AX_USERFILES_ROOT`, EROFS on `/workspace`. Every prior test missed this by
  // using hand-crafted lowercase-dash ids. We run a batch to cover the random
  // alphabet (`_`, `-`, mixed case) across many mints.
  it('emits a confined per-agent mount for a REAL minted agt_<base64url> id', async () => {
    for (let i = 0; i < 50; i++) {
      const realId = mintRealAgentId();
      const out = await resolve(OWNER(realId));
      expect(out.mounts).toHaveLength(1);
      const m = out.mounts[0] as NfsMountSpec;
      expect(m.kind).toBe('nfs');
      // subPath is exactly the agentId — a single confined segment, no leading
      // slash and no traversal, so the mount stays inside the agent's subtree.
      expect(m.subPath).toBe(realId);
      expect(m.subPath.startsWith('/')).toBe(false);
      expect(m.subPath.includes('/')).toBe(false);
      expect(m.subPath.includes('..')).toBe(false);
      expect(m.role).toBe('user-files');
    }
  });

  it.each(['../escape', 'a/b', 'a b', '.', 'a..b', '/abs', 'a.b', 'a/../b'])(
    'returns [] for a traversal-unsafe agentId (%s)',
    async (bad) => {
      const out = await resolve(OWNER(bad));
      expect(out.mounts).toEqual([]);
    },
  );
});
