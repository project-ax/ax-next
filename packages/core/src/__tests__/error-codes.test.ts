import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS_RESET_FAILED } from '../error-codes.js';

describe('@ax/core/error-codes', () => {
  it('pins the wire spelling of the tool-permissions reset refusal (TASK-782)', () => {
    // The connector routes answer 503 with this exact string as `error`, and
    // the channel-web editors key their message on it. Renaming it is a wire
    // change, not a refactor.
    expect(TOOL_PERMISSIONS_RESET_FAILED).toBe('tool-permissions-reset-failed');
  });

  it('imports nothing, so the channel-web SPA can bundle it', () => {
    // Same contract as `@ax/core/surface-text`: a browser bundle that imports
    // this subpath must not drag the kernel (hook bus, node built-ins) along.
    const src = readFileSync(new URL('../error-codes.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/^\s*export\s[^;]*\bfrom\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
