/**
 * The plugin's configuration. Types only for now: Task 8 adds the defaults,
 * `parseAppsBridgeEnv` and `assertAppsBridgeConfig` that validate them.
 */

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
