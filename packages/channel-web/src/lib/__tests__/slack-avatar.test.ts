import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import markLight from '@/assets/design/ax-mark-light.svg';
import { logoUrl, type Branding } from '../branding';

vi.mock('../slack-avatar-draw', async (importOriginal) => {
  const original = await importOriginal<typeof import('../slack-avatar-draw')>();
  return { ...original, loadAvatarImage: vi.fn(), drawSlackAvatar: vi.fn() };
});

import { drawSlackAvatar, loadAvatarImage } from '../slack-avatar-draw';
import { drawPickedSlackAvatar, renderSlackAvatar, SLACK_AVATAR_TIMEOUT_MS, slackAvatarSource } from '../slack-avatar';

const load = vi.mocked(loadAvatarImage);
const draw = vi.mocked(drawSlackAvatar);

function branding(over: Partial<Branding>): Branding {
  return { name: '', logoType: 'full', light: false, dark: false, version: '', ...over };
}

function stubBranding(b: Branding): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

const IMG = { tag: 'loaded-image' } as unknown as HTMLImageElement;

beforeEach(() => {
  load.mockReset().mockResolvedValue(IMG);
  draw.mockReset().mockReturnValue('B64');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('renderSlackAvatar', () => {
  it('a light logo is the picture, loaded from its versioned URL', async () => {
    stubBranding(branding({ name: 'Canopy AI', light: true, dark: true, version: 'v7' }));
    await expect(renderSlackAvatar()).resolves.toBe('B64');
    expect(load).toHaveBeenCalledWith(logoUrl('light', 'v7'), 5_000);
    expect(draw).toHaveBeenCalledWith(IMG);
  });

  it('no logo and no product name: the AX mark', async () => {
    stubBranding(branding({ name: '', light: false }));
    await expect(renderSlackAvatar()).resolves.toBe('B64');
    expect(load).toHaveBeenCalledWith(markLight, 5_000);
  });

  it('no logo and the name "ax": the AX mark too', async () => {
    stubBranding(branding({ name: 'ax', light: false }));
    await expect(renderSlackAvatar()).resolves.toBe('B64');
    expect(load).toHaveBeenCalledWith(markLight, 5_000);
  });

  it('no logo under a custom name: no picture, nothing loaded', async () => {
    stubBranding(branding({ name: 'Acme', light: false }));
    await expect(renderSlackAvatar()).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(slackAvatarSource(branding({ name: 'Acme', light: false }))).toBeNull();
  });

  it('a branding read that fails: no picture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(renderSlackAvatar()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(renderSlackAvatar()).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('a logo that will not load: no picture', async () => {
    stubBranding(branding({ light: true, version: 'v1' }));
    load.mockRejectedValue(new Error('decode'));
    await expect(renderSlackAvatar()).resolves.toBeNull();
    expect(draw).not.toHaveBeenCalled();
  });

  it('a drawing that fails: no picture', async () => {
    stubBranding(branding({ light: true, version: 'v1' }));
    draw.mockReturnValue(null);
    await expect(renderSlackAvatar()).resolves.toBeNull();
  });

  it('a branding read that never answers gives up after SLACK_AVATAR_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    let result: string | null | undefined;
    void renderSlackAvatar().then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(SLACK_AVATAR_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });
});

describe('drawPickedSlackAvatar', () => {
  const create = vi.fn();
  const revoke = vi.fn();
  const FILE = new File(['x'], 'p.png', { type: 'image/png' });
  beforeEach(() => {
    create.mockReset().mockReturnValue('blob:picked');
    revoke.mockReset();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  });

  it('draws the picked file and revokes its URL', async () => {
    await expect(drawPickedSlackAvatar(FILE)).resolves.toBe('B64');
    expect(create).toHaveBeenCalledWith(FILE);
    expect(load).toHaveBeenCalledWith('blob:picked', 5_000);
    expect(draw).toHaveBeenCalledWith(IMG);
    expect(revoke).toHaveBeenCalledWith('blob:picked');
  });

  it('an image that will not load is null, and the URL is still revoked', async () => {
    load.mockRejectedValue(new Error('decode'));
    await expect(drawPickedSlackAvatar(FILE)).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:picked');
  });

  it('a draw that gives nothing is null', async () => {
    draw.mockReturnValue(null);
    await expect(drawPickedSlackAvatar(FILE)).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:picked');
  });
});
