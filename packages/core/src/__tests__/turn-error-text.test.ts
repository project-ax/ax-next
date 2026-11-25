import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
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
});
