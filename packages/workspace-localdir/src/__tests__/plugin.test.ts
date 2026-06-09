import { randomBytes } from 'node:crypto';
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
// keyed off `owner.agentId` (validated `^[A-Za-z0-9_-]+$` — the base64url
// alphabet, matching real `agt_<base64url>` ids). Returns `[]` when the owner
// has no agentId (anonymous CLI session → graceful no-mount). This is the
// canary/dev path — it gives a durable per-agent `/workspace` without a real
// NFS server.
// ---------------------------------------------------------------------------

// Mint a real agentId exactly the way `@ax/agents` does (store.ts:mintAgentId).
// 16 random bytes → base64url, prefixed `agt_`. Real ids always contain `_`
// (the prefix separator) and usually uppercase — the shape that the original
// `^[a-z0-9-]+$` gate rejected, leaving the user-files mount inert (TASK-175).
function mintRealAgentId(): string {
  return `agt_${randomBytes(16).toString('base64url')}`;
}

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
  readOnly?: boolean,
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
      readOnly !== undefined ? { owner, readOnly } : { owner },
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

  // TASK-167 (§11 host-read): the SAME owner-keyed resolver emits a read-only
  // realization when the caller requests it. The runner omits `readOnly`,
  // keeping the writable realization byte-for-byte.
  it('emits a readOnly localDir mount when the caller requests readOnly (host-read)', async () => {
    const out = await resolve('/var/lib/ax/userfiles', OWNER('agent-abc'), undefined, true);
    const m = out.mounts[0] as LocalDirMountSpec;
    expect(m.kind).toBe('localDir');
    expect(m.hostPath).toBe('/var/lib/ax/userfiles/agent-abc');
    expect(m.readOnly).toBe(true);
    expect(m.role).toBe('user-files');
  });

  it('defaults to a writable mount when readOnly is omitted or false', async () => {
    const omitted = await resolve('/var/lib/ax/userfiles', OWNER('agent-abc'));
    expect((omitted.mounts[0] as LocalDirMountSpec).readOnly).toBe(false);
    const explicitFalse = await resolve(
      '/var/lib/ax/userfiles',
      OWNER('agent-abc'),
      undefined,
      false,
    );
    expect((explicitFalse.mounts[0] as LocalDirMountSpec).readOnly).toBe(false);
  });

  it('returns [] when the owner has no agentId (anonymous CLI)', async () => {
    const out = await resolve('/var/lib/ax/userfiles', OWNER(''));
    expect(out.mounts).toEqual([]);
  });

  // TASK-175 regression: a REAL minted id (`agt_<base64url>`, with `_` and
  // usually uppercase) MUST resolve to a confined per-agent subtree under root.
  // The original `^[a-z0-9-]+$` gate rejected every real agent → no mount, no
  // `AX_USERFILES_ROOT`, EROFS on `/workspace`. Every prior test missed this by
  // using hand-crafted lowercase-dash ids. We run a batch to cover the random
  // alphabet (`_`, `-`, mixed case) across many mints.
  it('emits a confined per-agent mount for a REAL minted agt_<base64url> id', async () => {
    for (let i = 0; i < 50; i++) {
      const realId = mintRealAgentId();
      const out = await resolve('/var/lib/ax/userfiles', OWNER(realId));
      expect(out.mounts).toHaveLength(1);
      const m = out.mounts[0] as LocalDirMountSpec;
      expect(m.kind).toBe('localDir');
      // hostPath is exactly `<root>/<agentId>`: the id contributes one confined
      // segment (no `/`, no `..`), so the join can't escape the root.
      expect(m.hostPath).toBe(`/var/lib/ax/userfiles/${realId}`);
      expect(m.hostPath.startsWith('/var/lib/ax/userfiles/')).toBe(true);
      expect(m.role).toBe('user-files');
    }
  });

  it.each(['../escape', 'a/b', 'a b', '.', 'a..b', '/abs', 'a.b', 'a/../b'])(
    'returns [] for a traversal-unsafe agentId (%s)',
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
