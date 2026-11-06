import { describe, it, expect } from 'vitest';
import { AttachmentIdSchema } from '@ax/ipc-protocol';
import {
  VISUAL_ARTIFACT_ID_RE,
  isShowVisualToolName,
  visualFromToolResult,
} from '../visual-result.js';

const ok = { artifactId: '0123456789abcdef0123456789abcdef', title: 'Issues per cycle', summary: 'Down 12%.' };

describe('visualFromToolResult', () => {
  it('reads the string form, the block-array form and a JSON first line', () => {
    expect(visualFromToolResult(JSON.stringify(ok))).toStrictEqual(ok);
    expect(visualFromToolResult([{ type: 'image' }, { type: 'text', text: JSON.stringify(ok) }])).toStrictEqual(ok);
    expect(visualFromToolResult(`${JSON.stringify(ok)}\nA runner note.`)).toStrictEqual(ok);
  });
  it('keeps only id, title and summary', () =>
    expect(visualFromToolResult(JSON.stringify({ ...ok, html: '<p>x</p>', path: 'visuals/x.html' }))).toStrictEqual(ok));
  it.each(['', '../x', 'a b', 'x'.repeat(129), 7])('refuses artifactId %j', (id) =>
    expect(visualFromToolResult(JSON.stringify({ ...ok, artifactId: id }))).toBeNull());
  it('agrees with AttachmentIdSchema', () => {
    for (const id of ['a', 'A-_9', 'x'.repeat(128), 'x'.repeat(129), 'a.b', 'a/b', ''])
      expect(VISUAL_ARTIFACT_ID_RE.test(id)).toBe(AttachmentIdSchema.safeParse(id).success);
  });
  it('fences title and summary; refuses blank ones and non-JSON', () => {
    const v = visualFromToolResult(JSON.stringify({ ...ok, title: 'Q3‮evil', summary: 's'.repeat(1500) }))!;
    expect(v.title).not.toContain('‮');
    expect(v.summary.length).toBeLessThanOrEqual(1000);
    expect(visualFromToolResult(JSON.stringify({ ...ok, title: '  ' }))).toBeNull();
    expect(visualFromToolResult('not json')).toBeNull();
  });
});

describe('isShowVisualToolName', () => {
  it('matches exactly the two runner spellings', () => {
    expect(['show_visual', 'mcp__ax-sandbox-tools__show_visual', 'mcp__linear__show_visual', 'artifact_publish'].map(isShowVisualToolName))
      .toEqual([true, true, false, false]);
  });
});
