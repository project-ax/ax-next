import type { Transaction } from 'kysely';
import { createLogger, type AgentContext, type HookBus } from '@ax/core';

const PLUGIN_NAME = '@ax/onboarding';

// ---------------------------------------------------------------------------
// Wizard completion transaction — Task 2.7 (I8, I9)
//
// Validates the Anthropic API key via a direct HTTP call (with a hard 10s
// timeout — Invariant I8), then atomically stores the credential, creates
// the Default Agent, and marks bootstrap as complete inside a single
// db:transact (Invariant I9). The fast-model setting is written after the
// transaction because it is recoverable — it is not part of the atomicity
// invariant.
// ---------------------------------------------------------------------------

const ANTHROPIC_VALIDATION_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VALIDATION_VERSION = '2023-06-01';
const VALIDATION_TIMEOUT_MS = 10_000; // Invariant I8: hard 10s timeout.

export type CompletionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'credential-invalid'
        | 'credential-validation-timeout'
        | 'credential-validation-error';
    };

export interface CompletionInput {
  bus: HookBus;
  ctx: AgentContext;
  adminUserId: string;
  apiKey: string;
  fastModel: string;
  defaultModel: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to VALIDATION_TIMEOUT_MS (10 s). Pass a small value in tests to skip real wall-clock waits. */
  timeoutMs?: number;
}

export async function runCompletionTransaction(
  input: CompletionInput,
): Promise<CompletionResult> {
  // Step 1: Validate API key via direct HTTP, with hard timeout (I8).
  // Algorithm lifted from credentials-admin-routes/src/providers-routes.ts:218-235.
  const fetchFn = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? VALIDATION_TIMEOUT_MS);
  let valid = false;
  try {
    const r = await fetchFn(ANTHROPIC_VALIDATION_URL, {
      method: 'GET',
      headers: {
        'x-api-key': input.apiKey,
        'anthropic-version': ANTHROPIC_VALIDATION_VERSION,
      },
      signal: ctrl.signal,
    });
    if (r.status === 200) {
      valid = true;
    } else if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: 'credential-invalid' };
    } else {
      return { ok: false, reason: 'credential-validation-error' };
    }
  } catch {
    if (ctrl.signal.aborted) {
      return { ok: false, reason: 'credential-validation-timeout' };
    }
    return { ok: false, reason: 'credential-validation-error' };
  } finally {
    clearTimeout(timer);
  }
  if (!valid) return { ok: false, reason: 'credential-invalid' };

  // Step 2: Atomic transaction — credential + agent + bootstrap:complete (I9).
  await input.bus.call<unknown, void>('db:transact', input.ctx, {
    run: async ({ tx }: { tx: Transaction<unknown> }) => {
      await input.bus.call('credentials:set', input.ctx, {
        scope: 'global',
        ownerId: null,
        // Single shared ref for the Anthropic credential: chat-orchestrator
        // looks it up here, the k8s preset's envFallback maps the same ref
        // to ANTHROPIC_API_KEY, and the admin Provider keys tab reads the
        // same row to render "Configured". Drift on this string means
        // (a) the wizard credential is orphaned data, and (b) the admin UI
        // shows "Not configured" right after a successful wizard run.
        ref: 'anthropic-api',
        kind: 'api-key',
        payload: new TextEncoder().encode(input.apiKey),
        tx,
      });
      await input.bus.call('agents:create', input.ctx, {
        actor: { userId: input.adminUserId, isAdmin: true },
        input: {
          displayName: 'Default Agent',
          // Generic placeholder so the runner's
          // owner.agentConfig.systemPrompt validator (requireString,
          // non-empty) doesn't reject the very first chat. Operator
          // can edit via /admin/agents after onboarding.
          systemPrompt: 'You are a helpful assistant.',
          allowedTools: [],
          mcpConfigIds: [],
          model: input.defaultModel,
          visibility: 'personal',
        },
        tx,
      });
      await input.bus.call('bootstrap:complete', input.ctx, { tx });
    },
  });

  // Step 3: Fast-model setting (post-tx; recoverable, not atomic with above).
  // Swallowed on failure: bootstrap is already committed, and a missing
  // fast-model setting can be set manually later. Returning 500 here would
  // leave the wizard wedged behind the post-completion 410 gate.
  try {
    await input.bus.call('storage:set', input.ctx, {
      key: 'settings:fast-model',
      value: new TextEncoder().encode(input.fastModel),
    });
  } catch (err) {
    // Best-effort log; don't propagate. Bootstrap is already committed
    // and a missing fast-model setting is set-able later.
    createLogger({ reqId: PLUGIN_NAME }).warn(
      'failed to persist fast-model setting (recoverable)',
      { err: err instanceof Error ? err.message : String(err) },
    );
  }

  return { ok: true };
}
