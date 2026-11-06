import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { MAX_RETAINED_VERSIONS } from '../artifacts/store.js';
import type {
  ArtifactsGetOutput,
  ArtifactsListOutput,
  ArtifactsReadOutput,
  ArtifactsSummaryOutput,
} from '../artifacts/types.js';
import { SHA, SHA2, ctxFor, makeRig, publish, useArtifactsDb, type Rig } from './artifacts-fixture.js';

useArtifactsDb();

function list(rig: Rig, agentId = 'agt-1', userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsListOutput>('artifacts:list', ctxFor(userId), { agentId });
}
function get(rig: Rig, artifactId: string, userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsGetOutput>('artifacts:get', ctxFor(userId), { artifactId });
}
function read(rig: Rig, artifactId: string, version?: number, userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsReadOutput>('artifacts:read', ctxFor(userId), {
    artifactId,
    ...(version !== undefined ? { version } : {}),
  });
}
function rename(rig: Rig, artifactId: string, title: string, userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsSummaryOutput>('artifacts:rename', ctxFor(userId), { artifactId, title });
}
function restore(rig: Rig, artifactId: string, version: number, userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsSummaryOutput>('artifacts:restore', ctxFor(userId), { artifactId, version });
}
function del(rig: Rig, artifactId: string, userId = 'u-1') {
  return rig.bus.call<unknown, { deleted: true }>('artifacts:delete', ctxFor(userId), { artifactId });
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

describe('artifact owner hooks', () => {
  it("a team member lists an artifact made in another member's chat (D7)", async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, { conversationId: 'c-team-u1' });
    const { artifacts } = await list(rig, 'agt-team', 'u-2');
    expect(artifacts.map((a) => a.artifactId)).toEqual([artifactId]);
    // And may open it.
    expect((await get(rig, artifactId, 'u-2')).artifact.title).toBe('Q3 pipeline report');
  });

  it('a non-member gets the same not-found as a missing artifact from list, get, read, rename, restore and delete', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const missing = 'f'.repeat(32);

    const listForeign = await refusal(list(rig, 'agt-1', 'u-2'));
    const listMissing = await refusal(list(rig, 'agt-nope', 'u-2'));
    expect(listForeign).toEqual(listMissing);
    expect(listForeign.code).toBe('not-found');

    const calls: Array<(id: string) => Promise<unknown>> = [
      (id) => get(rig, id, 'u-2'),
      (id) => read(rig, id, undefined, 'u-2'),
      (id) => read(rig, id, 1, 'u-2'),
      (id) => rename(rig, id, 'Mine now', 'u-2'),
      (id) => restore(rig, id, 1, 'u-2'),
      (id) => del(rig, id, 'u-2'),
    ];
    for (const call of calls) {
      const foreign = await refusal(call(artifactId));
      const absent = await refusal(call(missing));
      expect(foreign).toEqual(absent);
      expect(foreign.code).toBe('not-found');
    }
    // Nothing the non-member tried changed it.
    const { artifact } = await get(rig, artifactId);
    expect(artifact.title).toBe('Q3 pipeline report');
  });

  it('an agents:resolve outage propagates as itself, not as not-found', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    rig.outage.on = true;
    await expect(list(rig)).rejects.toMatchObject({ code: 'unknown' });
    await expect(get(rig, artifactId)).rejects.toMatchObject({ code: 'unknown' });
    await expect(del(rig, artifactId)).rejects.toMatchObject({ code: 'unknown' });
    rig.outage.on = false;
    expect((await list(rig)).artifacts).toHaveLength(1);
  });

  it('publish refuses a conversation the caller does not own (forbidden) and a sha the store lacks (not-found)', async () => {
    const rig = await makeRig();
    await expect(publish(rig, { conversationId: 'c-other' }, 'u-1', 'agt-2')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(publish(rig, { sha256: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'not-found' });
    expect((await list(rig)).artifacts).toEqual([]);
  });

  it("publish refuses an agent publishing into another agent's conversation", async () => {
    const rig = await makeRig();
    // u-1 owns c-1 (agt-1), but the session runs as agt-team.
    await expect(publish(rig, { conversationId: 'c-1' }, 'u-1', 'agt-team')).rejects.toMatchObject({
      code: 'forbidden',
    });
    // An owner-less session is not an agent, so only the owner gate applies.
    await expect(publish(rig, { conversationId: 'c-1' }, 'u-1', 'ownerless:s')).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    ['an empty title', { title: ' \n ' }],
    ['a title over 200 characters', { title: 'x'.repeat(201) }],
    ['an absolute path', { sourcePath: '/etc/passwd' }],
    ['a path that climbs', { sourcePath: 'reports/../../secret.pdf' }],
    ['an empty segment', { sourcePath: 'reports//q3.pdf' }],
    ['an empty path', { sourcePath: '' }],
    ['a path over 1024 characters', { sourcePath: `${'d/'.repeat(512)}x.pdf` }],
  ])('publish refuses %s as invalid-payload', async (_name, args) => {
    const rig = await makeRig();
    await expect(publish(rig, args)).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('publish: an unknown artifactId is not-found, and a path another artifact holds is a conflict', async () => {
    const rig = await makeRig();
    const a = await publish(rig, { sourcePath: 'a.pdf' });
    await publish(rig, { sourcePath: 'b.pdf' });
    await expect(publish(rig, { artifactId: 'f'.repeat(32) })).rejects.toMatchObject({ code: 'not-found' });
    await expect(publish(rig, { sourcePath: 'b.pdf', artifactId: a.artifactId })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('publish takes size from blob:stat and media type from the path, so nothing the caller sends can set either', async () => {
    const rig = await makeRig();
    const out = await rig.bus.call<Record<string, unknown>, { artifactId: string; kind: string; extension: string }>(
      'artifacts:publish',
      ctxFor('u-1', 'agt-1'),
      {
        conversationId: 'c-1',
        sha256: SHA2,
        sourcePath: 'reports/q3.pdf',
        title: 'Q3',
        // Not part of the input; a caller that sends them anyway steers nothing.
        mediaType: 'text/html',
        size: 1,
        sizeBytes: 1,
      },
    );
    expect(out).toMatchObject({ kind: 'document', extension: 'PDF' });
    const { artifact } = await get(rig, out.artifactId);
    expect(artifact).toMatchObject({ mediaType: 'application/pdf', sizeBytes: 5, preview: 'pdf' });
  });

  it("publish returns the stored title, so a person's rename shows", async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    await rename(rig, artifactId, 'Pipeline (final)');
    const again = await publish(rig, { title: 'Agent title' });
    expect(again).toMatchObject({ artifactId, version: 2, title: 'Pipeline (final)' });
  });

  it('get lists versions newest first; read defaults to current; reading a pruned version is not-found', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, { sha256: SHA });
    await publish(rig, { sha256: SHA2 });

    const { artifact } = await get(rig, artifactId);
    expect(artifact.currentVersion).toBe(2);
    expect(artifact.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(artifact.versions[0]).toMatchObject({ mediaType: 'application/pdf', sizeBytes: 5 });

    const current = await read(rig, artifactId);
    expect(current).toMatchObject({ version: 2, mediaType: 'application/pdf', preview: 'pdf', sizeBytes: 5 });
    expect(current.filename).toBe('Q3 pipeline report.pdf');
    expect(Array.from(current.bytes)).toEqual([4, 5, 6, 7, 8]);
    expect(Array.from((await read(rig, artifactId, 1)).bytes)).toEqual([1, 2, 3]);

    for (let i = 0; i < MAX_RETAINED_VERSIONS; i++) await publish(rig);
    await expect(read(rig, artifactId, 1)).rejects.toMatchObject({ code: 'not-found' });
    await expect(restore(rig, artifactId, 1)).rejects.toMatchObject({ code: 'not-found' });
    await expect(read(rig, artifactId, 0)).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('restore moves the current version back; delete removes the artifact', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, { sha256: SHA });
    await publish(rig, { sha256: SHA2 });
    const { artifact } = await restore(rig, artifactId, 1);
    expect(artifact).toMatchObject({ currentVersion: 1, sizeBytes: 3 });
    expect((await read(rig, artifactId)).version).toBe(1);

    await expect(del(rig, artifactId)).resolves.toEqual({ deleted: true });
    await expect(get(rig, artifactId)).rejects.toMatchObject({ code: 'not-found' });
    expect((await list(rig)).artifacts).toEqual([]);
  });

  it('rename refuses a title that does not normalize, and does not move the artifact up the list', async () => {
    const rig = await makeRig();
    const older = await publish(rig, { sourcePath: 'old.pdf', title: 'Older' });
    const newer = await publish(rig, { sourcePath: 'new.pdf', title: 'Newer' });
    await expect(rename(rig, older.artifactId, '\u0000\u200b')).rejects.toMatchObject({ code: 'invalid-payload' });

    const before = (await list(rig)).artifacts;
    const renamed = await rename(rig, older.artifactId, '  Older,\nrenamed ');
    expect(renamed.artifact.title).toBe('Older, renamed');
    expect(renamed.artifact.updatedAt).toBe(before.find((a) => a.artifactId === older.artifactId)!.updatedAt);
    expect((await list(rig)).artifacts.map((a) => a.artifactId)).toEqual([newer.artifactId, older.artifactId]);
  });

  it('no hook answer contains a share code or a source path', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig);
    const code = await rig.artifacts.setShareCode(artifactId, 'ensure', () => 'Z'.repeat(32));
    expect(code).toBe('Z'.repeat(32));

    const listed = await list(rig);
    const blob = JSON.stringify([listed, await get(rig, artifactId), await rename(rig, artifactId, 'Renamed')]);
    expect(blob).not.toMatch(/sourcePath|shareCode|reports\/q3/);
    expect(blob).not.toContain('Z'.repeat(32));
    expect(listed.artifacts[0]!.linkOn).toBe(true);
  });
});
