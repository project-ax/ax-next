import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONNECTORS_TAB_REASONS,
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
  turnErrorLabel,
  turnErrorText,
} from '../turn-error-text.js';

describe('@ax/core/turn-error-text', () => {
  it('imports nothing, so the channel-web SPA can bundle it', () => {
    // Same contract as `@ax/core/error-codes`: a browser bundle that imports
    // this subpath must not drag the kernel (hook bus, node built-ins) along.
    const src = readFileSync(new URL('../turn-error-text.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/^\s*export\s[^;]*\bfrom\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it('turnErrorLabel answers a known reason with its sentence', () => {
    expect(turnErrorLabel('dev-service-failed')).toBe('A dev service failed to start.');
  });

  it.each(['sandbox-terminated', '', 'toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'turnErrorLabel(%j) is undefined, never an inherited member',
    (reason) => expect(turnErrorLabel(reason)).toBeUndefined(),
  );

  it('turnErrorText still falls back to the default and puts the detail under the sentence', () => {
    expect(turnErrorText('sandbox-terminated')).toBe(DEFAULT_TURN_ERROR);
    expect(turnErrorText('dev-service-failed', 'svc down')).toBe(
      'A dev service failed to start.\nsvc down',
    );
  });

  it('the table can’t be changed by either plugin that shares it', () => {
    expect(Object.isFrozen(ERROR_LABELS)).toBe(true);
  });

  it('names the reasons fixed on the Connectors tab, each one a reason the table words', () => {
    expect([...CONNECTORS_TAB_REASONS].sort()).toEqual(['connector-needs-reconnect', 'connectors-need-reconnect']);
    for (const reason of CONNECTORS_TAB_REASONS) expect(turnErrorLabel(reason), reason).toBeDefined();
  });

  it('the Connectors-tab set can’t be changed by either plugin that shares it', () => {
    const shared = CONNECTORS_TAB_REASONS as Set<string>;
    expect(Object.isFrozen(shared)).toBe(true);
    expect(() => shared.add('chat-run-timeout')).toThrow(TypeError);
    expect(() => shared.delete('connector-needs-reconnect')).toThrow(TypeError);
    expect(() => shared.clear()).toThrow(TypeError);
    expect(CONNECTORS_TAB_REASONS.size).toBe(2);
    expect(CONNECTORS_TAB_REASONS.has('chat-run-timeout')).toBe(false);
  });
});
