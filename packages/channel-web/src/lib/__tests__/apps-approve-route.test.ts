/**
 * `/apps/approve/<platformId>/<appId>/<connectorId>`: the approve page's
 * address. The sign-in return trusts this match, so it is exact.
 */
import { describe, expect, it } from 'vitest';
import { parseAppsApproveRoute } from '../apps-approve-route';

const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const PATH = `/apps/approve/canopy/${APP}/linear`;

describe('parseAppsApproveRoute', () => {
  it('parses /apps/approve/<p>/<a>/<c> exactly and nothing else', () => {
    expect(parseAppsApproveRoute(PATH)).toEqual({ platformId: 'canopy', appId: APP, connectorId: 'linear' });
    for (const bad of [
      `${PATH}?x=1`,
      `${PATH}#x`,
      `${PATH}/`,
      `${PATH}/extra`,
      `/apps/approve/canopy/${APP}`,
      `/apps/approve/Canopy/${APP}/linear`,
      `/apps/approve/canopy/a.b/linear`,
      `/apps/approve/canopy/../linear`,
      `/apps/approve/canopy/${APP}/%2e%2e`,
      `/apps/approve/canopy/${APP}/_linear`,
      `//evil.example${PATH}`,
      `https://evil.example${PATH}`,
      `/a${PATH}`,
      '/apps/approve/',
      '/apps/approve',
      '/',
      '',
    ]) expect(parseAppsApproveRoute(bad), bad).toBeNull();
  });
});
