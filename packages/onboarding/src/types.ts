export interface OnboardingConfig {
  /** Base URL printed in the stdout banner. e.g. 'http://localhost:8080'. */
  baseUrl: string;
  /** Path to write the token file. Default '/var/run/ax/bootstrap-token'. */
  tokenFilePath?: string;
  /**
   * Injection point for tests. Production omits these; the plugin uses
   * `printTokenToStdout` and `writeTokenFile` from './token.js'. Tests pass
   * fakes to assert what was written and to simulate failure.
   */
  stdoutWriter?: (line: string) => void;
  tokenFileWriter?: (path: string, token: string) => Promise<void>;
  /** Read AX_BOOTSTRAP_TOKEN from this map instead of process.env. Tests only. */
  envOverride?: Record<string, string | undefined>;
}

/**
 * Public payload of the `bootstrap:status` service hook. Camel-case fields,
 * no SQL/storage shapes leaking. The `completedAt` field is included only
 * when status is 'completed'.
 */
export interface BootstrapStatusOutput {
  status: 'pending' | 'claimed' | 'completed' | 'uninitialized';
  completedAt?: Date;
}
