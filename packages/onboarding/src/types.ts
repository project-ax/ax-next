import { z, type ZodType } from 'zod';
import type { Transaction } from 'kysely';

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
  /**
   * Override the Anthropic validation timeout (ms). Defaults to 10 000.
   * Pass a small value (e.g. 100) in tests to avoid burning real wall time.
   */
  validationTimeoutMs?: number;
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

export interface BootstrapCompleteInput {
  /** Optional transaction handle from db:transact's run callback. */
  tx?: Transaction<unknown>;
}

/**
 * Input for `bootstrap:reset`. Setting `force: true` is the explicit
 * operator override of the I6 "never backwards" invariant — required to
 * re-open a `completed` install.
 */
export interface BootstrapResetInput {
  force?: boolean;
}

/**
 * Output of `bootstrap:reset`. Success carries the freshly minted token
 * (printed once to STDOUT by the CLI; never written to disk by the
 * hook itself) and `previousStatus` for diagnostics.
 */
export type BootstrapResetOutput =
  | {
      ok: true;
      token: string;
      baseUrl: string;
      previousStatus: 'pending' | 'claimed' | 'completed' | null;
    }
  | { ok: false; reason: 'completed-without-force' };

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the data-returning `bootstrap:*` hooks
// (ARCH-13). `bootstrap:complete` returns `void`, so it gets no schema.
//
// Storage-agnostic: `status` is the I6 state enum, `completedAt` is a real
// `Date` (the store returns a Date; `z.date()`, NOT `z.string()`), and the
// reset result mirrors the public discriminated union (the freshly-minted
// `token`/`baseUrl` are operator-facing, never persisted by the hook). Cast to
// `ZodType<…>` because zod's `.optional()`/`.nullable()` infer union shapes the
// interface won't directly absorb; the drift-guard test enforces agreement.
// ---------------------------------------------------------------------------
export const BootstrapStatusOutputSchema = z.object({
  status: z.union([
    z.literal('pending'),
    z.literal('claimed'),
    z.literal('completed'),
    z.literal('uninitialized'),
  ]),
  completedAt: z.date().optional(),
}) as unknown as ZodType<BootstrapStatusOutput>;

export const BootstrapResetOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    token: z.string(),
    baseUrl: z.string(),
    previousStatus: z
      .union([z.literal('pending'), z.literal('claimed'), z.literal('completed')])
      .nullable(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('completed-without-force'),
  }),
]) as unknown as ZodType<BootstrapResetOutput>;
