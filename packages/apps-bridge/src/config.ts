/**
 * The plugin's configuration, its defaults, and the two checks that hold it
 * to the rules: `parseAppsBridgeEnv` (the operator's AX_APPS_BRIDGE_* strings)
 * and `assertAppsBridgeConfig` (any config, however it was built).
 *
 * Every error names the variable or field and the rule, never the value: a
 * JWKS URL can carry credentials, and an operator's typo is no business of a
 * boot log.
 */
import { PLATFORM_ID_RE } from '@ax/apps-bridge-contract';
import { assertJwksUrl, assertViewerMaxAge, MAX_VIEWER_MAX_AGE_SECONDS, MIN_VIEWER_MAX_AGE_SECONDS } from './verify-token.js';

/** Where the bridge listens and whom it trusts. Absent: no bridge at all. */
export interface AppsBridgeDeployConfig {
  platformId: string;
  host: string;
  port: number;
  caller: { issuer: string; jwksUrl: string; audience: string; subject: string };
  viewer: { issuer: string; jwksUrl: string; audience: string; maxAgeSeconds: number };
}

export interface AppsBridgeConfig {
  /** Where approve links point. */
  publicOrigin: string;
  /** Absent: no listener; the settings routes answer `{ enabled: false }`. */
  bridge?: AppsBridgeDeployConfig;
  /** Test seam: the clock, in epoch milliseconds. */
  now?: () => number;
}

export const DEFAULT_APPS_BRIDGE_PORT = 9092;
export const DEFAULT_VIEWER_MAX_AGE_SECONDS = 600;

/** The raw strings, one per env var; the preset reads each variable literally. */
export interface AppsBridgeEnv {
  platformId?: string | undefined;
  port?: string | undefined;
  callerIssuer?: string | undefined;
  callerJwksUrl?: string | undefined;
  callerAudience?: string | undefined;
  callerSubject?: string | undefined;
  viewerIssuer?: string | undefined;
  viewerJwksUrl?: string | undefined;
  viewerAudience?: string | undefined;
  viewerMaxAgeSeconds?: string | undefined;
  /** `AX_HTTP_HOST`: the bridge binds where the main listener does, on its own port. */
  bindHost: string;
}

type EnvKey = Exclude<keyof AppsBridgeEnv, 'bindHost'>;

const ENV_NAMES: Record<EnvKey, string> = {
  platformId: 'AX_APPS_BRIDGE_PLATFORM_ID',
  port: 'AX_APPS_BRIDGE_PORT',
  callerIssuer: 'AX_APPS_BRIDGE_CALLER_ISSUER',
  callerJwksUrl: 'AX_APPS_BRIDGE_CALLER_JWKS_URL',
  callerAudience: 'AX_APPS_BRIDGE_CALLER_AUDIENCE',
  callerSubject: 'AX_APPS_BRIDGE_CALLER_SUBJECT',
  viewerIssuer: 'AX_APPS_BRIDGE_VIEWER_ISSUER',
  viewerJwksUrl: 'AX_APPS_BRIDGE_VIEWER_JWKS_URL',
  viewerAudience: 'AX_APPS_BRIDGE_VIEWER_AUDIENCE',
  viewerMaxAgeSeconds: 'AX_APPS_BRIDGE_VIEWER_MAX_AGE_SECONDS',
};

/** Required once a platform id is set, in the order they are reported. */
const REQUIRED: readonly EnvKey[] = [
  'callerIssuer',
  'callerJwksUrl',
  'callerAudience',
  'callerSubject',
  'viewerIssuer',
  'viewerJwksUrl',
  'viewerAudience',
];

const MAX_CLAIM_VALUE_CHARS = 512;
const MAX_PORT = 65_535;

/**
 * The operator's values become the bridge's deploy config, or `undefined`
 * when none is set (the bridge is off). Every value is trimmed, and a blank
 * one counts as unset. Throws an Error naming the variable when the set is
 * partial or a value breaks its rule, then holds the result to
 * `assertAppsBridgeConfig`'s rules.
 */
export function parseAppsBridgeEnv(e: AppsBridgeEnv): AppsBridgeDeployConfig | undefined {
  const v = {} as Record<EnvKey, string>;
  for (const key of Object.keys(ENV_NAMES) as EnvKey[]) v[key] = (e[key] ?? '').trim();

  const anySet = (Object.keys(ENV_NAMES) as EnvKey[]).some((key) => v[key] !== '');
  if (!anySet) return undefined;
  if (v.platformId === '') {
    throw new Error('AX_APPS_BRIDGE_PLATFORM_ID is required when any AX_APPS_BRIDGE_* is set');
  }
  for (const key of REQUIRED) {
    if (v[key] === '') throw new Error(`${ENV_NAMES[key]} is required when AX_APPS_BRIDGE_PLATFORM_ID is set`);
  }

  const bridge: AppsBridgeDeployConfig = {
    platformId: v.platformId,
    host: e.bindHost.trim(),
    port: v.port === '' ? DEFAULT_APPS_BRIDGE_PORT : parsePort(v.port),
    caller: { issuer: v.callerIssuer, jwksUrl: v.callerJwksUrl, audience: v.callerAudience, subject: v.callerSubject },
    viewer: {
      issuer: v.viewerIssuer,
      jwksUrl: v.viewerJwksUrl,
      audience: v.viewerAudience,
      maxAgeSeconds: v.viewerMaxAgeSeconds === '' ? DEFAULT_VIEWER_MAX_AGE_SECONDS : parseMaxAge(v.viewerMaxAgeSeconds),
    },
  };
  try {
    assertDeployConfig(bridge);
  } catch (err) {
    throw new Error(`apps bridge env: ${(err as Error).message}`);
  }
  return bridge;
}

/** 1-65535: a deployment names its port. 0 (any free port) is for tests, through the config object only. */
function parsePort(raw: string): number {
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= 1 && n <= MAX_PORT)) throw new Error(`AX_APPS_BRIDGE_PORT must be a whole number from 1 to ${MAX_PORT}`);
  return n;
}

function parseMaxAge(raw: string): number {
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= MIN_VIEWER_MAX_AGE_SECONDS && n <= MAX_VIEWER_MAX_AGE_SECONDS)) {
    throw new Error(
      `AX_APPS_BRIDGE_VIEWER_MAX_AGE_SECONDS must be a whole number from ${MIN_VIEWER_MAX_AGE_SECONDS} to ${MAX_VIEWER_MAX_AGE_SECONDS}`,
    );
  }
  return n;
}

function assertClaimValue(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLAIM_VALUE_CHARS) {
    throw new Error(`${field} must be 1 to ${MAX_CLAIM_VALUE_CHARS} characters`);
  }
}

/** Rethrows assertJwksUrl's error under the field's name; its message never echoes the URL. */
function assertJwks(field: string, value: string): void {
  try {
    assertJwksUrl(value);
  } catch (err) {
    throw new Error(`${field}: ${(err as Error).message}`);
  }
}

function assertDeployConfig(b: AppsBridgeDeployConfig): void {
  if (typeof b.platformId !== 'string' || !PLATFORM_ID_RE.test(b.platformId)) {
    throw new Error('AX_APPS_BRIDGE_PLATFORM_ID (platformId) must be lowercase letters, digits and inner hyphens, at most 63 characters');
  }
  if (typeof b.host !== 'string' || b.host.length === 0) throw new Error('host (AX_HTTP_HOST) must be set');
  if (!Number.isInteger(b.port) || b.port < 0 || b.port > MAX_PORT) {
    throw new Error(`port must be a whole number from 0 to ${MAX_PORT}`);
  }
  assertClaimValue('caller issuer', b.caller.issuer);
  assertClaimValue('caller audience', b.caller.audience);
  assertClaimValue('caller subject', b.caller.subject);
  assertJwks('caller jwksUrl', b.caller.jwksUrl);
  assertClaimValue('viewer issuer', b.viewer.issuer);
  assertClaimValue('viewer audience', b.viewer.audience);
  assertJwks('viewer jwksUrl', b.viewer.jwksUrl);
  assertViewerMaxAge(b.viewer.maxAgeSeconds);
}

/**
 * Throws unless the config holds to the rules: `publicOrigin` an http(s) URL
 * (approve links are built from its origin, so a trailing slash or a path is
 * harmless), and, when the bridge is on, a platform id in its grammar, JWKS
 * URLs that are https (or loopback http) without credentials, issuer,
 * audience and subject of 1-512 characters, a whole-number port and a viewer
 * max age of 30-3600 whole seconds.
 */
export function assertAppsBridgeConfig(c: AppsBridgeConfig): void {
  let origin: URL;
  try {
    origin = new URL(c.publicOrigin);
  } catch {
    throw new Error('publicOrigin must be an absolute http(s) URL');
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
    throw new Error('publicOrigin must be an absolute http(s) URL');
  }
  if (c.bridge !== undefined) assertDeployConfig(c.bridge);
}
