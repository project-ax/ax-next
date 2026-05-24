// Unit tests for the helm-presence gate. Pure decision logic — runs anywhere,
// no helm required. Guards the TASK-1 contract: a CI lane that sets
// AX_REQUIRE_HELM must HARD-FAIL when helm is absent, instead of silently
// skipping the chart-render guards (the exact failure mode TASK-1 kills).

import { describe, expect, it } from 'vitest';

import { resolveHelmGate } from './helm-required.js';

describe('resolveHelmGate', () => {
  it('helm present → run, regardless of AX_REQUIRE_HELM', () => {
    expect(resolveHelmGate('helm', undefined)).toEqual({ mode: 'run', helm: 'helm' });
    expect(resolveHelmGate('helm', '1')).toEqual({ mode: 'run', helm: 'helm' });
    expect(resolveHelmGate('helm', '0')).toEqual({ mode: 'run', helm: 'helm' });
  });

  it('helm absent + AX_REQUIRE_HELM unset → silent skip (local-dev friendly)', () => {
    expect(resolveHelmGate(null, undefined)).toEqual({ mode: 'skip' });
  });

  it('helm absent + AX_REQUIRE_HELM=1 → hard fail (CI regression guard)', () => {
    expect(resolveHelmGate(null, '1')).toEqual({ mode: 'require-missing' });
  });

  it('strict mode accepts common truthy spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(resolveHelmGate(null, v), `value ${JSON.stringify(v)}`).toEqual({
        mode: 'require-missing',
      });
    }
  });

  it('strict mode treats falsey/empty spellings as opt-out (silent skip)', () => {
    for (const v of ['', '   ', '0', 'false', 'FALSE', 'no', 'off']) {
      expect(resolveHelmGate(null, v), `value ${JSON.stringify(v)}`).toEqual({
        mode: 'skip',
      });
    }
  });
});
