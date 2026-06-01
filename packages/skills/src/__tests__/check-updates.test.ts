import { describe, it, expect } from 'vitest';
import { checkForUpdates } from '../check-updates.js';
import type { SkillDetail } from '../types.js';

function makeDetail(over: Partial<SkillDetail> = {}): SkillDetail {
  const base: SkillDetail = {
    id: 'x',
    description: 'x',
    version: 1,
    manifestYaml: 'name: x\ndescription: x\nversion: 1\n',
    bodyMd: 'body',
    connectors: [],
    defaultAttached: false,
    updatedAt: new Date().toISOString(),
    sourceUrl: 'https://example.com/skill.md',
  };
  return { ...base, ...over };
}

function mockFetch(text: string, ok = true, status = 200) {
  return {
    fetch: async () => ({ ok, status, text: async () => text }),
  };
}

describe('checkForUpdates', () => {
  it('returns available=false when sourceUrl is missing', async () => {
    const detail = makeDetail();
    delete (detail as { sourceUrl?: string }).sourceUrl;
    const r = await checkForUpdates(detail, mockFetch(''));
    expect(r.available).toBe(false);
    expect(r.latestVersion).toBeUndefined();
    expect(r.currentVersion).toBe(1);
  });

  it('returns available=true when remote version > current', async () => {
    const remote = '---\nname: x\ndescription: x\nversion: 5\n---\nnew body';
    const r = await checkForUpdates(makeDetail({ version: 2 }), mockFetch(remote));
    expect(r.available).toBe(true);
    expect(r.currentVersion).toBe(2);
    expect(r.latestVersion).toBe(5);
    expect(r.latestSkillMd).toBe(remote);
  });

  it('returns available=false when remote version == current', async () => {
    const remote = '---\nname: x\ndescription: x\nversion: 2\n---\nsame body';
    const r = await checkForUpdates(makeDetail({ version: 2 }), mockFetch(remote));
    expect(r.available).toBe(false);
    expect(r.latestVersion).toBe(2);
    expect(r.latestSkillMd).toBeUndefined();
  });

  it('returns available=false when remote version < current', async () => {
    const remote = '---\nname: x\ndescription: x\nversion: 1\n---\nold body';
    const r = await checkForUpdates(makeDetail({ version: 3 }), mockFetch(remote));
    expect(r.available).toBe(false);
    expect(r.latestVersion).toBe(1);
  });

  it('throws on fetch failure (non-2xx)', async () => {
    await expect(
      checkForUpdates(makeDetail(), mockFetch('', false, 404)),
    ).rejects.toThrow(/skill-source-fetch-failed/);
  });

  it('throws on missing frontmatter fence', async () => {
    await expect(
      checkForUpdates(makeDetail(), mockFetch('no fence here, just text')),
    ).rejects.toThrow(/skill-source-missing-frontmatter/);
  });

  it('throws on invalid remote manifest', async () => {
    const remote = '---\nname: BAD\ndescription: x\nversion: 5\n---\nbody';
    await expect(
      checkForUpdates(makeDetail(), mockFetch(remote)),
    ).rejects.toThrow(/skill-source-manifest-invalid/);
  });
});
