import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPS_BRIDGE_PORT,
  DEFAULT_VIEWER_MAX_AGE_SECONDS,
  assertAppsBridgeConfig,
  parseAppsBridgeEnv,
  type AppsBridgeDeployConfig,
  type AppsBridgeEnv,
} from '../config.js';

/*
  The operator's AX_APPS_BRIDGE_* values, as raw strings, become the bridge's
  deploy config, or nothing (the bridge is off), or a boot error that names
  the variable and never echoes a value.
*/

const FULL: AppsBridgeEnv = {
  platformId: 'canopy',
  callerIssuer: 'https://accounts.example.test',
  callerJwksUrl: 'https://accounts.example.test/jwks',
  callerAudience: 'https://ax.test/api/apps-bridge/v1',
  callerSubject: 'platform@example.test',
  viewerIssuer: 'https://gateway.example.test',
  viewerJwksUrl: 'https://gateway.example.test/jwks',
  viewerAudience: '/projects/1/apps/platform',
  bindHost: '0.0.0.0',
};

const EXPECTED: AppsBridgeDeployConfig = {
  platformId: 'canopy',
  host: '0.0.0.0',
  port: 9092,
  caller: {
    issuer: 'https://accounts.example.test',
    jwksUrl: 'https://accounts.example.test/jwks',
    audience: 'https://ax.test/api/apps-bridge/v1',
    subject: 'platform@example.test',
  },
  viewer: {
    issuer: 'https://gateway.example.test',
    jwksUrl: 'https://gateway.example.test/jwks',
    audience: '/projects/1/apps/platform',
    maxAgeSeconds: 600,
  },
};

const ENV_NAMES: Record<Exclude<keyof AppsBridgeEnv, 'bindHost' | 'platformId' | 'port' | 'viewerMaxAgeSeconds'>, string> = {
  callerIssuer: 'AX_APPS_BRIDGE_CALLER_ISSUER',
  callerJwksUrl: 'AX_APPS_BRIDGE_CALLER_JWKS_URL',
  callerAudience: 'AX_APPS_BRIDGE_CALLER_AUDIENCE',
  callerSubject: 'AX_APPS_BRIDGE_CALLER_SUBJECT',
  viewerIssuer: 'AX_APPS_BRIDGE_VIEWER_ISSUER',
  viewerJwksUrl: 'AX_APPS_BRIDGE_VIEWER_JWKS_URL',
  viewerAudience: 'AX_APPS_BRIDGE_VIEWER_AUDIENCE',
};

describe('parseAppsBridgeEnv', () => {
  it('no AX_APPS_BRIDGE_* values means the bridge is off', () => {
    expect(parseAppsBridgeEnv({ bindHost: '0.0.0.0' })).toBeUndefined();
    // Blank and whitespace-only values count as unset.
    expect(
      parseAppsBridgeEnv({ bindHost: '0.0.0.0', platformId: '', port: '  ', callerIssuer: '\t', viewerMaxAgeSeconds: '' }),
    ).toBeUndefined();
  });

  it('a full set becomes the deploy config, trimmed', () => {
    expect(parseAppsBridgeEnv(FULL)).toEqual(EXPECTED);
    const padded = Object.fromEntries(Object.entries(FULL).map(([k, v]) => [k, k === 'bindHost' ? v : `  ${v}\n`]));
    expect(parseAppsBridgeEnv(padded as unknown as AppsBridgeEnv)).toEqual(EXPECTED);
  });

  it('a platform id needs every caller and viewer value', () => {
    expect(() => parseAppsBridgeEnv({ ...FULL, callerSubject: undefined })).toThrow(/AX_APPS_BRIDGE_CALLER_SUBJECT/);
    for (const [key, name] of Object.entries(ENV_NAMES)) {
      expect(() => parseAppsBridgeEnv({ ...FULL, [key]: '   ' }), key).toThrow(name);
    }
  });

  it('a value without a platform id is refused', () => {
    const message = 'AX_APPS_BRIDGE_PLATFORM_ID is required when any AX_APPS_BRIDGE_* is set';
    expect(() => parseAppsBridgeEnv({ ...FULL, platformId: undefined })).toThrow(message);
    expect(() => parseAppsBridgeEnv({ bindHost: '0.0.0.0', port: '9092' })).toThrow(message);
    expect(() => parseAppsBridgeEnv({ bindHost: '0.0.0.0', viewerMaxAgeSeconds: '600' })).toThrow(message);
    expect(() => parseAppsBridgeEnv({ bindHost: '0.0.0.0', viewerAudience: 'x' })).toThrow(message);
  });

  it('defaults: port 9092, max age 600; bad port or max age is refused', () => {
    expect(DEFAULT_APPS_BRIDGE_PORT).toBe(9092);
    expect(DEFAULT_VIEWER_MAX_AGE_SECONDS).toBe(600);
    expect(parseAppsBridgeEnv({ ...FULL, port: '0' })?.port).toBe(0);
    expect(parseAppsBridgeEnv({ ...FULL, port: '65535' })?.port).toBe(65535);
    expect(parseAppsBridgeEnv({ ...FULL, port: ' 9300 ' })?.port).toBe(9300);
    expect(parseAppsBridgeEnv({ ...FULL, viewerMaxAgeSeconds: '30' })?.viewer.maxAgeSeconds).toBe(30);
    expect(parseAppsBridgeEnv({ ...FULL, viewerMaxAgeSeconds: '3600' })?.viewer.maxAgeSeconds).toBe(3600);
    for (const port of ['65536', '-1', '1.5', '9092x', '0x10', '123456', '1e3', 'NaN']) {
      expect(() => parseAppsBridgeEnv({ ...FULL, port }), port).toThrow(/AX_APPS_BRIDGE_PORT/);
    }
    for (const age of ['29', '3601', '1.5', '600s', 'Infinity', 'NaN', '-600', '0']) {
      expect(() => parseAppsBridgeEnv({ ...FULL, viewerMaxAgeSeconds: age }), age).toThrow(/AX_APPS_BRIDGE_VIEWER_MAX_AGE_SECONDS/);
    }
  });

  it('jwks urls must be https or loopback http', () => {
    expect(parseAppsBridgeEnv({ ...FULL, callerJwksUrl: 'http://127.0.0.1:8080/jwks' })?.caller.jwksUrl).toBe(
      'http://127.0.0.1:8080/jwks',
    );
    expect(parseAppsBridgeEnv({ ...FULL, viewerJwksUrl: 'http://localhost/jwks' })?.viewer.jwksUrl).toBe('http://localhost/jwks');
    expect(() => parseAppsBridgeEnv({ ...FULL, callerJwksUrl: 'http://accounts.example.test/jwks' })).toThrow(/jwksUrl/);
    expect(() => parseAppsBridgeEnv({ ...FULL, viewerJwksUrl: 'ftp://gateway.example.test/jwks' })).toThrow(/jwksUrl/);
    // Credentials in the URL are refused, and never echoed.
    try {
      parseAppsBridgeEnv({ ...FULL, viewerJwksUrl: 'https://user:hunter2@gateway.example.test/jwks' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/credentials/);
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('a platform id outside its grammar is refused without echoing it', () => {
    for (const platformId of ['Canopy', '-canopy', 'canopy-', 'a'.repeat(64), 'can opy', 'canopy\u0000']) {
      try {
        parseAppsBridgeEnv({ ...FULL, platformId });
        expect.unreachable(platformId);
      } catch (err) {
        expect((err as Error).message).toMatch(/AX_APPS_BRIDGE_PLATFORM_ID/);
        expect((err as Error).message).not.toContain(platformId);
      }
    }
  });

  it('issuer, audience and subject are at most 512 characters', () => {
    expect(parseAppsBridgeEnv({ ...FULL, callerSubject: 's'.repeat(512) })?.caller.subject).toHaveLength(512);
    expect(() => parseAppsBridgeEnv({ ...FULL, callerSubject: 's'.repeat(513) })).toThrow(/subject/);
    expect(() => parseAppsBridgeEnv({ ...FULL, viewerIssuer: 'i'.repeat(513) })).toThrow(/issuer/);
    expect(() => parseAppsBridgeEnv({ ...FULL, callerAudience: 'a'.repeat(513) })).toThrow(/audience/);
  });
});

describe('assertAppsBridgeConfig', () => {
  it('accepts no bridge, and a public origin with or without a trailing slash', () => {
    expect(() => assertAppsBridgeConfig({ publicOrigin: 'https://ax.test' })).not.toThrow();
    expect(() => assertAppsBridgeConfig({ publicOrigin: 'https://ax.test/', bridge: EXPECTED })).not.toThrow();
  });

  it('refuses a public origin that is not an http(s) URL', () => {
    for (const publicOrigin of ['', 'ax.test', 'ftp://ax.test', 'javascript:alert(1)']) {
      expect(() => assertAppsBridgeConfig({ publicOrigin }), publicOrigin).toThrow(/publicOrigin/);
    }
  });

  it('refuses a deploy config built by hand outside the rules', () => {
    const bad: Array<[string, AppsBridgeDeployConfig, RegExp]> = [
      ['platform id', { ...EXPECTED, platformId: 'UPPER' }, /platform/i],
      ['empty issuer', { ...EXPECTED, caller: { ...EXPECTED.caller, issuer: '' } }, /issuer/],
      ['empty subject', { ...EXPECTED, caller: { ...EXPECTED.caller, subject: '' } }, /subject/],
      ['jwks', { ...EXPECTED, caller: { ...EXPECTED.caller, jwksUrl: 'http://evil.test/jwks' } }, /jwksUrl/],
      ['port', { ...EXPECTED, port: 70_000 }, /port/],
      ['port NaN', { ...EXPECTED, port: Number.NaN }, /port/],
      ['empty host', { ...EXPECTED, host: '' }, /host/],
    ];
    for (const [label, bridge, msg] of bad) {
      expect(() => assertAppsBridgeConfig({ publicOrigin: 'https://ax.test', bridge }), label).toThrow(msg);
    }
  });

  it('enforces the viewer max age as a whole number from 30 to 3600', () => {
    for (const maxAgeSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 29, 3601, 600.5]) {
      expect(
        () => assertAppsBridgeConfig({ publicOrigin: 'https://ax.test', bridge: { ...EXPECTED, viewer: { ...EXPECTED.viewer, maxAgeSeconds } } }),
        String(maxAgeSeconds),
      ).toThrow(/maxAgeSeconds/);
    }
  });
});
