import { describe, expect, it } from 'vitest';
import { buildTelemetryEnv } from '../telemetry-env.js';

describe('buildTelemetryEnv', () => {
  it('disables every SDK phone-home channel (datadog telemetry + error reporting)', () => {
    // TASK-55: the vendored claude CLI POSTs telemetry to datadoghq.com unless
    // the traffic mode is taken out of "default". Each of these flags does that;
    // we set all three so a future SDK that splits the single gate keeps every
    // channel off. If any one is dropped the phantom datadoghq.com egress (and
    // its reactive-wall card) can return — this test is the regression guard.
    expect(buildTelemetryEnv()).toEqual({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    });
  });

  it('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is the load-bearing umbrella flag', () => {
    // Anthropic's docs use this exact flag to "opt out of all non-essential
    // traffic"; in the pinned 0.2.119 binary it sets the traffic mode to
    // "essential-traffic", which makes the datadog initializer bail. Assert it
    // explicitly so a refactor can't quietly demote it to a weaker var.
    expect(buildTelemetryEnv().CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = buildTelemetryEnv();
    const b = buildTelemetryEnv();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
