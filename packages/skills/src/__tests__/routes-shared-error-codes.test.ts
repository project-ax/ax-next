import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { MANIFEST_CODES } from '@ax/skills-parser';
import {
  BAD_REQUEST_CODES,
  SKILLS_OWN_BAD_REQUEST_CODES,
  writeServiceError,
  type RouteResponse,
} from '../_routes-shared.js';

// TASK-1018: the 400 set used to be a hand-kept list that still carried six
// codes nothing emitted any more (the parser dropped them when capabilities
// moved onto connectors, TASK-100). It is now the parser's own list plus this
// plugin's codes. These tests pin both halves.

function fakeRes(): RouteResponse & { statusCode?: number; payload?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(v: unknown) {
      res.payload = v;
    },
  };
  return res as unknown as RouteResponse & { statusCode?: number; payload?: unknown };
}

function errWith(code: string): PluginError {
  return new PluginError({ code, plugin: '@ax/skills', message: `boom ${code}` });
}

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Non-test source of this package, minus the file that defines the list. */
function packageSourceExceptRoutesShared(): string {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && f !== '_routes-shared.ts')
    .map((f) => readFileSync(join(SRC_DIR, f), 'utf8'))
    .join('\n');
}

describe('writeServiceError 400 set', () => {
  it('is exactly the parser codes plus this plugin\'s own codes', () => {
    expect([...BAD_REQUEST_CODES].sort()).toEqual(
      [...MANIFEST_CODES, ...SKILLS_OWN_BAD_REQUEST_CODES].sort(),
    );
  });

  it.each([...MANIFEST_CODES])('maps the parser code %s to 400', (code) => {
    const res = fakeRes();
    expect(writeServiceError(res, errWith(code))).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: `boom ${code}`, code });
  });

  it.each([...SKILLS_OWN_BAD_REQUEST_CODES])('maps the plugin code %s to 400', (code) => {
    const res = fakeRes();
    expect(writeServiceError(res, errWith(code))).toBe(true);
    expect(res.statusCode).toBe(400);
  });

  it.each([...SKILLS_OWN_BAD_REQUEST_CODES])(
    'the plugin code %s is thrown somewhere in this package',
    (code) => {
      expect(packageSourceExceptRoutesShared()).toContain(`'${code}'`);
    },
  );

  // The six codes the old list carried that nothing emits. They now fall
  // through (writeServiceError returns false, the caller answers 500), the same
  // as any other code nobody classified.
  it.each([
    'invalid-host',
    'invalid-slot',
    'duplicate-slot',
    'invalid-kind',
    'invalid-mcp-command',
    'invalid-mcp-transport',
  ])('no longer maps the dead code %s', (code) => {
    const res = fakeRes();
    expect(writeServiceError(res, errWith(code))).toBe(false);
    expect(res.statusCode).toBeUndefined();
  });
});
