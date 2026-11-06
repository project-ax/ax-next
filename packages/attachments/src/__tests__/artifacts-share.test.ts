import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginError, makeAgentContext, ownerlessIdFor, type Logger } from '@ax/core';
import { SHARE_CODE_RE, isShareCode, newShareCode } from '../artifacts/share-code.js';
import type { ArtifactsReadOutput, ArtifactsResolveShareCodeOutput, ArtifactsSetLinkOutput } from '../artifacts/types.js';
import { SHA, SHA2, ctxFor, makeRig, publish, useArtifactsDb, type Rig } from './artifacts-fixture.js';

useArtifactsDb();

type LinkAction = 'ensure' | 'off' | 'rotate';

function setLink(rig: Rig, artifactId: string, action: LinkAction, userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsSetLinkOutput>('artifacts:set-link', ctxFor(userId), { artifactId, action });
}
function resolve(rig: Rig, shareCode: unknown, ctx = ctxFor('u-9')) {
  return rig.bus.call<unknown, ArtifactsResolveShareCodeOutput>('artifacts:resolve-share-code', ctx, { shareCode });
}
function readByCode(rig: Rig, shareCode: unknown, ctx = ctxFor('u-9')) {
  return rig.bus.call<unknown, ArtifactsReadOutput>('artifacts:read', ctx, { shareCode });
}

/** The code and message a refusal carries, so two refusals can be compared whole. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    const e = err as PluginError;
    return { code: e.code, message: e.message };
  }
  throw new Error('expected a refusal');
}

/** What a missing artifact id gets from the owner hooks: the one not-found every share refusal must match. */
async function missingArtifactRefusal(rig: Rig) {
  return refusal(rig.bus.call('artifacts:get', ctxFor('u-1'), { artifactId: 'no-such-artifact' }));
}

describe('share code', () => {
  it('newShareCode gives 32 url-safe characters, and 1000 of them are distinct', () => {
    const s = new Set(Array.from({ length: 1000 }, newShareCode));
    expect(s.size).toBe(1000);
    for (const c of s) expect(c).toMatch(SHARE_CODE_RE);
  });

  it('isShareCode accepts exactly the minted shape', () => {
    expect(isShareCode(newShareCode())).toBe(true);
    for (const bad of [undefined, null, 42, '', 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}=`, `${'a'.repeat(31)}+`, `${'a'.repeat(31)}\n`]) {
      expect(isShareCode(bad)).toBe(false);
    }
  });
});

describe('share links', () => {
  it('ensure mints once and returns the same code after; rotate replaces it and the old one stops resolving; off returns null', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);

    const first = await setLink(rig, artifactId, 'ensure');
    expect(first.shareCode).toMatch(SHARE_CODE_RE);
    expect((await setLink(rig, artifactId, 'ensure')).shareCode).toBe(first.shareCode);
    expect((await resolve(rig, first.shareCode)).artifact.title).toBe('Q3 pipeline report');

    const rotated = await setLink(rig, artifactId, 'rotate');
    expect(rotated.shareCode).toMatch(SHARE_CODE_RE);
    expect(rotated.shareCode).not.toBe(first.shareCode);
    expect(await refusal(resolve(rig, first.shareCode))).toEqual(await missingArtifactRefusal(rig));
    expect((await resolve(rig, rotated.shareCode)).artifact.title).toBe('Q3 pipeline report');

    expect(await setLink(rig, artifactId, 'off')).toEqual({ shareCode: null });
    expect(await refusal(resolve(rig, rotated.shareCode))).toEqual(await missingArtifactRefusal(rig));
    // Turning it back on mints a fresh code, never the old one.
    const again = await setLink(rig, artifactId, 'ensure');
    expect([first.shareCode, rotated.shareCode]).not.toContain(again.shareCode);
  });

  it('two concurrent ensure calls return the same code', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const [a, b] = await Promise.all([setLink(rig, artifactId, 'ensure'), setLink(rig, artifactId, 'ensure')]);
    expect(a.shareCode).toMatch(SHARE_CODE_RE);
    expect(b.shareCode).toBe(a.shareCode);
  });

  it('set-link is owner only: a non-member gets the same not-found as a missing artifact, and nothing changes', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const missing = await missingArtifactRefusal(rig);
    for (const action of ['ensure', 'off', 'rotate'] as const) {
      expect(await refusal(setLink(rig, artifactId, action, 'u-2'))).toEqual(missing);
    }
    expect((await rig.artifacts.getHead(artifactId))!.shareCode).toBeNull();
    // A team member is an owner (D7).
    const team = await publish(rig, { conversationId: 'c-team-u1', sourcePath: 'team.md' });
    expect((await setLink(rig, team.artifactId, 'ensure', 'u-2')).shareCode).toMatch(SHARE_CODE_RE);
  });

  it('set-link refuses an unknown action with invalid-payload', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const r = await refusal(rig.bus.call('artifacts:set-link', ctxFor('u-1'), { artifactId, action: 'public' }));
    expect(r.code).toBe('invalid-payload');
  });

  it.each(['malformed', 'wrong', 'turned-off', 'rotated-away', 'deleted-artifact'])(
    'a %s code is the same not-found',
    async (k) => {
      const rig = await makeRig();
      const { artifactId } = await publish(rig);
      const live = (await setLink(rig, artifactId, 'ensure')).shareCode!;
      let code: string;
      switch (k) {
        case 'malformed':
          code = `${live}=`;
          break;
        case 'wrong':
          code = newShareCode();
          break;
        case 'turned-off':
          await setLink(rig, artifactId, 'off');
          code = live;
          break;
        case 'rotated-away':
          await setLink(rig, artifactId, 'rotate');
          code = live;
          break;
        default:
          await rig.bus.call('artifacts:delete', ctxFor('u-1'), { artifactId });
          code = live;
      }
      const missing = await missingArtifactRefusal(rig);
      expect(missing.code).toBe('not-found');
      await expect(resolve(rig, code)).rejects.toMatchObject(missing);
      await expect(readByCode(rig, code)).rejects.toMatchObject(missing);
    },
  );

  it('a non-string or absent code is the same not-found', async () => {
    const rig = await makeRig();
    const missing = await missingArtifactRefusal(rig);
    for (const bad of [undefined, null, 7, { $ne: null }, ['x']]) {
      expect(await refusal(resolve(rig, bad))).toEqual(missing);
    }
  });

  it('a signed-in non-member resolves the current version only, with no id, versions or code in the answer', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, { sha256: SHA, sourcePath: 'page.html', title: 'Landing page' });
    await publish(rig, { sha256: SHA2, sourcePath: 'page.html', title: 'Landing page' });
    const code = (await setLink(rig, artifactId, 'ensure')).shareCode!;

    const { artifact } = await resolve(rig, code, ctxFor('u-9'));
    expect(Object.keys(artifact).sort()).toEqual(
      ['agentName', 'extension', 'kind', 'mediaType', 'preview', 'sizeBytes', 'title', 'updatedAt'].sort(),
    );
    expect(artifact).toMatchObject({ title: 'Landing page', mediaType: 'text/html', preview: 'html', sizeBytes: 5 });
    const blob = JSON.stringify(artifact);
    expect(blob).not.toContain(artifactId);
    expect(blob).not.toContain(code);
    expect(blob).not.toContain('page.html');

    // read by code: the current version's bytes, never an older one.
    const read = await readByCode(rig, code, ctxFor('u-9'));
    expect(Array.from(read.bytes)).toEqual([4, 5, 6, 7, 8]);
    expect(read.version).toBe(2);
    // After a restore, the link follows the pointer.
    await rig.bus.call('artifacts:restore', ctxFor('u-1'), { artifactId, version: 1 });
    expect(Array.from((await readByCode(rig, code, ctxFor('u-9'))).bytes)).toEqual([1, 2, 3]);
    // The code form takes no version.
    const withVersion = await refusal(rig.bus.call('artifacts:read', ctxFor('u-9'), { shareCode: code, version: 2 }));
    expect(withVersion.code).toBe('invalid-payload');
    // And a non-member still cannot use the id form.
    expect(await refusal(rig.bus.call('artifacts:read', ctxFor('u-9'), { artifactId }))).toEqual(
      await missingArtifactRefusal(rig),
    );
  });

  it('a ctx with no person is refused like a wrong code', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const code = (await setLink(rig, artifactId, 'ensure')).shareCode!;
    const missing = await missingArtifactRefusal(rig);
    for (const userId of ['system', 'init', '', ownerlessIdFor('sess-1')]) {
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'host-route', userId });
      expect(await refusal(resolve(rig, code, ctx))).toEqual(missing);
      expect(await refusal(readByCode(rig, code, ctx))).toEqual(missing);
    }
  });

  it('agentName comes from agents:get-display-name', async () => {
    const rig = await makeRig();
    rig.bus.registerService('agents:get-display-name', 'test-agents', async () => ({ displayName: 'Pipeline Pal' }));
    const { artifactId } = await publish(rig);
    const code = (await setLink(rig, artifactId, 'ensure')).shareCode!;
    expect((await resolve(rig, code)).artifact.agentName).toBe('Pipeline Pal');
  });

  it('agentName is null when agents:get-display-name is absent or fails', async () => {
    const absent = await makeRig();
    const a = await publish(absent);
    const codeA = (await setLink(absent, a.artifactId, 'ensure')).shareCode!;
    expect((await resolve(absent, codeA)).artifact.agentName).toBeNull();

    const failing = await makeRig();
    failing.bus.registerService('agents:get-display-name', 'test-agents', async () => {
      throw new PluginError({ code: 'not-found', plugin: 'test-agents', message: 'agent not found' });
    });
    const b = await publish(failing);
    const codeB = (await setLink(failing, b.artifactId, 'ensure')).shareCode!;
    expect((await resolve(failing, codeB)).artifact.agentName).toBeNull();
  });

  describe('logging', () => {
    afterEach(() => vi.restoreAllMocks());

    it('no log line contains the code', async () => {
      const lines: string[] = [];
      const record = (...args: unknown[]) => {
        lines.push(
          args
            .map((a) => {
              try {
                return typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? `${v.message} ${String(v.cause)}` : v));
              } catch {
                return String(a);
              }
            })
            .join(' '),
        );
      };
      const logger: Logger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: () => logger,
      } as unknown as Logger;
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
      const ctx = (userId: string) => makeAgentContext({ sessionId: 's', agentId: 'host-route', userId, logger });

      const rig = await makeRig();
      rig.bus.registerService('agents:get-display-name', 'test-agents', async () => {
        throw new Error('display-name backend down');
      });
      const { artifactId } = await publish(rig);
      const codes: string[] = [];
      const ensured = await rig.bus.call<unknown, ArtifactsSetLinkOutput>('artifacts:set-link', ctx('u-1'), {
        artifactId,
        action: 'ensure',
      });
      codes.push(ensured.shareCode!);
      await resolve(rig, ensured.shareCode, ctx('u-9'));
      await readByCode(rig, ensured.shareCode, ctx('u-9'));
      const rotated = await rig.bus.call<unknown, ArtifactsSetLinkOutput>('artifacts:set-link', ctx('u-1'), {
        artifactId,
        action: 'rotate',
      });
      codes.push(rotated.shareCode!);
      await resolve(rig, ensured.shareCode, ctx('u-9')).catch(() => {});
      await resolve(rig, ensured.shareCode, ctx('system')).catch(() => {});
      await rig.bus.call('artifacts:set-link', ctx('u-1'), { artifactId, action: 'off' });
      await readByCode(rig, rotated.shareCode, ctx('u-9')).catch(() => {});

      // The failing display-name lookup was logged, so the capture is live.
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const c of codes) {
        // Not in full, and not in part: no 8-character run of it.
        for (let i = 0; i + 8 <= c.length; i++) expect(all).not.toContain(c.slice(i, i + 8));
      }
    });
  });
});
