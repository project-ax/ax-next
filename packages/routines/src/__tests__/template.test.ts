import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../template.js';

describe('renderTemplate', () => {
  it('substitutes a top-level string', () => {
    expect(renderTemplate('hello {{payload.name}}', { payload: { name: 'world' } }))
      .toBe('hello world');
  });

  it('walks a nested path', () => {
    expect(renderTemplate('PR {{payload.pr.title}}', {
      payload: { pr: { title: 'fix bug' } },
    })).toBe('PR fix bug');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(renderTemplate('{{payload.n}}/{{payload.b}}', {
      payload: { n: 42, b: true },
    })).toBe('42/true');
  });

  it('JSON.stringifies object values', () => {
    expect(renderTemplate('{{payload.obj}}', { payload: { obj: { a: 1 } } }))
      .toBe('{"a":1}');
  });

  it('JSON.stringifies array values', () => {
    expect(renderTemplate('{{payload.arr}}', { payload: { arr: [1, 2, 3] } }))
      .toBe('[1,2,3]');
  });

  it('empties missing fields', () => {
    expect(renderTemplate('hi [{{payload.missing}}]', { payload: {} }))
      .toBe('hi []');
  });

  it('empties when an intermediate is non-object', () => {
    expect(renderTemplate('{{payload.a.b}}', { payload: { a: 'string' } }))
      .toBe('');
  });

  it('empties when an intermediate is null', () => {
    expect(renderTemplate('{{payload.a.b}}', { payload: { a: null } }))
      .toBe('');
  });

  it('treats {{payload}} as whole-payload JSON', () => {
    expect(renderTemplate('full = {{payload}}', { payload: { x: 1 } }))
      .toBe('full = {"x":1}');
  });

  it('leaves unmatched braces literal', () => {
    expect(renderTemplate('a {{ not.payload.x }} b', { payload: { x: 'y' } }))
      .toBe('a {{ not.payload.x }} b');
  });

  it('leaves array-indexing syntax literal (regex does not match)', () => {
    const out = renderTemplate('{{payload.arr[0]}}', { payload: { arr: ['x'] } });
    expect(out).toContain('[0]');
    expect(out).not.toContain('safe-called');
  });

  it('leaves function-call syntax literal (regex does not match)', () => {
    const out = renderTemplate('{{payload.x()}}', { payload: { x: 'safe' } });
    // No expression execution; the dynamic-eval forbidden set is not reachable.
    expect(out).not.toBe('safe');
  });

  it('handles undefined payload safely', () => {
    expect(renderTemplate('hi {{payload.x}}', { payload: undefined }))
      .toBe('hi ');
    expect(renderTemplate('hi {{payload}}', { payload: undefined }))
      .toBe('hi undefined');
    // ^ JSON.stringify(undefined) is 'undefined'; if you prefer empty
    // string for the whole-payload escape hatch when undefined, adjust
    // the test AND the implementation. Default is JSON.stringify
    // behaviour.
  });

  it('handles null payload safely', () => {
    expect(renderTemplate('hi {{payload.x}}', { payload: null }))
      .toBe('hi ');
    expect(renderTemplate('hi {{payload}}', { payload: null }))
      .toBe('hi null');
  });

  it('multiple substitutions in one template', () => {
    expect(renderTemplate(
      '{{payload.a}}+{{payload.b}}={{payload.sum}}',
      { payload: { a: 1, b: 2, sum: 3 } },
    )).toBe('1+2=3');
  });

  // K9 regression: a two-pass substitution would re-scan the JSON output
  // of {{payload}} and expand attacker-embedded {{payload.X}} strings.
  // Single-pass means the regex sees `body` once; expansion outputs are
  // never re-matched.
  it('does not re-expand {{payload.X}} strings embedded in payload values', () => {
    const out = renderTemplate('full = {{payload}}', {
      payload: { msg: '{{payload.token}}', token: 'real-token-value' },
    });
    // The literal `{{payload.token}}` survives JSON.stringify (it's
    // valid JSON content) — the assertion is that the `msg` field still
    // contains the LITERAL placeholder, not the token's value. A two-pass
    // implementation would replace the placeholder substring inside the
    // dumped JSON, mutating the `msg` field's value to 'real-token-value'.
    expect(out).toContain('"msg":"{{payload.token}}"');
    expect(out).not.toContain('"msg":"real-token-value"');
    // (The token value itself appears as the `token` field — that's the
    // whole-payload escape hatch behaving correctly; it's the dump of
    // an attacker-supplied field, fully under their control.)
  });

  it('does not re-expand {{payload}} embedded inside the body output either', () => {
    const out = renderTemplate('{{payload.escape}}', {
      payload: { escape: '{{payload.real}}', real: 'should-not-appear' },
    });
    expect(out).toBe('{{payload.real}}');
    expect(out).not.toContain('should-not-appear');
  });

  // K9 regression: prototype-chain segments are treated as missing fields,
  // not as a way to reach Object.prototype methods/properties.
  it('refuses prototype-chain traversal via __proto__', () => {
    // A regular object literal — __proto__ is the prototype-chain entry,
    // not an own property. Old impl returned JSON.stringify(Object.prototype)
    // (`'{}'`); new impl returns '' because Object.hasOwn(obj, '__proto__')
    // is false.
    expect(renderTemplate('{{payload.__proto__}}', { payload: { x: 1 } }))
      .toBe('');
    expect(renderTemplate('{{payload.constructor}}', { payload: { x: 1 } }))
      .toBe('');
  });

  it('still walks own __proto__ key when present (URLSearchParams shape)', () => {
    // Object.fromEntries(new URLSearchParams('__proto__=v')) sets
    // __proto__ as an OWN property — attacker controls both key and
    // value, so this is benign self-disclosure. Confirm the guard
    // doesn't block legitimate own-property reads.
    const payload = Object.fromEntries(new URLSearchParams('__proto__=attacker'));
    expect(renderTemplate('{{payload.__proto__}}', { payload }))
      .toBe('attacker');
  });
});
