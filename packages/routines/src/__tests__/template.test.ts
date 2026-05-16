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
});
