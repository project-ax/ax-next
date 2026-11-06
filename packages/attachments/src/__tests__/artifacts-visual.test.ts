import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { createArtifactsMintViewTokenHandler } from '../artifacts/handlers.js';
import { newShareCode } from '../artifacts/share-code.js';
import type { ArtifactsListOutput } from '../artifacts/types.js';
import { SHA, SHA2, ctxFor, makeRig, publish, useArtifactsDb, type Rig } from './artifacts-fixture.js';

// Ruling U1: a chart from show_visual (a "chat visual") is stored as an
// artifact so its chat card can load it, but it is NOT one of the agent's
// Artifacts. It never appears in the list (the panel, Download all, the chat
// card check), never in the agent's own prompt list, and no owner hook or share
// path reaches it: every one answers the uniform not-found of a missing
// artifact. Loading the chart in chat is attachments:download (download.test.ts).

useArtifactsDb();

const AUGMENT = 'system-prompt:augment:optional:artifacts';

function list(rig: Rig, agentId = 'agt-1', userId = 'u-1') {
  return rig.bus.call<unknown, ArtifactsListOutput>('artifacts:list', ctxFor(userId), { agentId });
}

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

const VISUAL = { sourcePath: 'visuals/abc.html', title: 'Issues per cycle', visual: true };

describe('chat visuals are not artifacts (U1)', () => {
  it('a visual is left out of artifacts:list; a normal artifact beside it is listed', async () => {
    const rig = await makeRig();
    const v = await publish(rig, VISUAL);
    const a = await publish(rig, { sourcePath: 'reports/q3.pdf' });
    const { artifacts } = await list(rig);
    expect(artifacts.map((x) => x.artifactId)).toEqual([a.artifactId]);
    expect(artifacts.map((x) => x.artifactId)).not.toContain(v.artifactId);
  });

  it("a visual is left out of the agent's prompt list and its 'more' count", async () => {
    const rig = await makeRig();
    // Over the row cap in visuals alone: none may show, nor count as "more".
    for (let i = 0; i < 55; i++) {
      await publish(rig, { ...VISUAL, sourcePath: `visuals/${i}.html` });
    }
    const empty = await rig.bus.call<unknown, { context?: string }>(AUGMENT, ctxFor('u-1', 'agt-1'), {});
    expect(empty).toEqual({});
    await publish(rig, { sourcePath: 'reports/q3.pdf', title: 'Q3 pipeline report' });
    const { context } = await rig.bus.call<unknown, { context?: string }>(AUGMENT, ctxFor('u-1', 'agt-1'), {});
    const rows = context!.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Q3 pipeline report');
    expect(context).not.toMatch(/visuals\//);
    expect(context).not.toMatch(/more not shown/);
  });

  it('get, read, rename, restore, delete and set-link answer a visual exactly as a missing artifact', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, VISUAL);
    const ctx = ctxFor('u-1');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['artifacts:get', {}],
      ['artifacts:read', {}],
      ['artifacts:rename', { title: 'Renamed' }],
      ['artifacts:restore', { version: 1 }],
      ['artifacts:delete', {}],
      ['artifacts:set-link', { action: 'ensure' }],
      ['artifacts:set-link', { action: 'rotate' }],
    ];
    for (const [hook, extra] of calls) {
      const hidden = await refusal(rig.bus.call(hook, ctx, { artifactId, ...extra }));
      const missing = await refusal(rig.bus.call(hook, ctx, { artifactId: 'f'.repeat(32), ...extra }));
      expect(hidden, hook).toEqual(missing);
      expect(hidden.code, hook).toBe('not-found');
    }
    // No link was ever minted, and the visual is still there for its chat card.
    const head = await rig.artifacts.getHead(artifactId);
    expect(head).not.toBeNull();
    expect(head!.shareCode).toBeNull();
  });

  it('a share code on a visual (however it got there) resolves to nothing', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, VISUAL);
    const code = await rig.artifacts.setShareCode(artifactId, 'ensure', newShareCode);
    expect(code).not.toBeNull();
    const ctx = ctxFor('u-2');
    const viaCode = await refusal(rig.bus.call('artifacts:resolve-share-code', ctx, { shareCode: code }));
    const unknown = await refusal(rig.bus.call('artifacts:resolve-share-code', ctx, { shareCode: newShareCode() }));
    expect(viaCode).toEqual(unknown);
    expect(await refusal(rig.bus.call('artifacts:read', ctx, { shareCode: code }))).toMatchObject({
      code: 'not-found',
    });
  });

  it('mint-view-token refuses a visual by id and by code, as a missing artifact', async () => {
    const rig = await makeRig();
    const { artifactId } = await publish(rig, VISUAL);
    const mint = createArtifactsMintViewTokenHandler({ artifacts: rig.artifacts, bus: rig.bus }, () => ({
      key: new Uint8Array(32).fill(7),
      publicOrigin: 'https://content.example',
    }));
    const ctx = ctxFor('u-1');
    const hidden = await refusal(mint(ctx, { artifactId, version: 1, purpose: 'view' }));
    const missing = await refusal(mint(ctx, { artifactId: 'f'.repeat(32), version: 1, purpose: 'view' }));
    expect(hidden).toEqual(missing);
    const code = (await rig.artifacts.setShareCode(artifactId, 'ensure', newShareCode))!;
    expect(await refusal(mint(ctx, { shareCode: code, purpose: 'download' }))).toMatchObject({ code: 'not-found' });
  });

  it('re-publishing a visual keeps it hidden; publishing its path without the marker makes it a normal artifact', async () => {
    const rig = await makeRig();
    const v1 = await publish(rig, VISUAL);
    const v2 = await publish(rig, { ...VISUAL, sha256: SHA2 });
    expect(v2).toMatchObject({ artifactId: v1.artifactId, version: 2 });
    expect((await list(rig)).artifacts).toEqual([]);
    // An explicit artifact_publish of that same file (no marker): the agent
    // means it as a deliverable, so it is listed from now on.
    const v3 = await publish(rig, { sourcePath: VISUAL.sourcePath, title: 'Issues per cycle', sha256: SHA });
    expect(v3).toMatchObject({ artifactId: v1.artifactId, version: 3 });
    expect((await list(rig)).artifacts.map((a) => a.artifactId)).toEqual([v1.artifactId]);
    // ...and a later show_visual of the same bytes never hides it again.
    await publish(rig, VISUAL);
    expect((await list(rig)).artifacts.map((a) => a.artifactId)).toEqual([v1.artifactId]);
  });

  it('a non-visual publish under visuals/ is a normal, listed artifact', async () => {
    const rig = await makeRig();
    const a = await publish(rig, { sourcePath: 'visuals/mine.html', title: 'My page' });
    expect((await list(rig)).artifacts.map((x) => x.artifactId)).toEqual([a.artifactId]);
  });

  it('publish refuses a visual marker that is not a boolean', async () => {
    const rig = await makeRig();
    const r = await refusal(
      rig.bus.call('artifacts:publish', ctxFor('u-1', 'agt-1'), {
        conversationId: 'c-1',
        sha256: SHA,
        sourcePath: 'visuals/x.html',
        title: 'X',
        visual: 'yes',
      }),
    );
    expect(r.code).toBe('invalid-payload');
  });
});
