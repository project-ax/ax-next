import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Exercise the actual transitive qs used by the runner's MCP HTTP dependency.
// GHSA-6pq8-jhm2-2vcw: comma serialization must survive hostile object coercion.
const runner = createRequire(new URL('../../packages/agent-aisdk-runner/package.json', import.meta.url));
const sdk = createRequire(runner.resolve('@modelcontextprotocol/sdk/server/index.js'));
const express = createRequire(sdk.resolve('express'));
const qs = express('qs');

describe('MCP HTTP dependency comma serialization', () => {
  it.each([false, true])('contains hostile own toString with encodeValuesOnly=%s', encodeValuesOnly => {
    const fromJson = JSON.parse('{"a":[{"toString":"x"}]}');
    const fromQuery = qs.parse('a[0][toString]=x', { allowPrototypes: true });
    const nullPrototype = qs.parse('a[][b]=c', { plainObjects: true });
    for (const input of [fromJson, fromQuery, nullPrototype]) {
      expect(() => qs.stringify(input, { arrayFormat: 'comma', encodeValuesOnly })).not.toThrow();
    }
  });
  it('still serializes normal comma arrays', () => {
    expect(qs.stringify({ a: ['x', 'y'] }, { arrayFormat: 'comma' })).toBe('a=x%2Cy');
  });
});
