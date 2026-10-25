import { describe, expect, it } from 'vitest';
import { MAX_MCP_OUTPUT_BYTES, renderMcpResult } from '../tools/mcp-result.js';

describe('renderMcpResult', () => {
  it('joins text parts with newlines', () => {
    expect(
      renderMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    ).toBe('a\nb');
  });

  it('inlines an embedded text resource and placeholders a binary one', () => {
    expect(
      renderMcpResult({
        content: [
          { type: 'resource', resource: { uri: 'file:///a.md', text: 'doc body' } },
          { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA' } },
          { type: 'resource_link', uri: 'https://x.example/r', name: 'r' },
        ],
      }),
    ).toBe('doc body\n[resource file:///b.bin omitted]\n[resource https://x.example/r omitted]');
  });

  it('placeholders image and audio parts by mime type', () => {
    expect(
      renderMcpResult({
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        ],
      }),
    ).toBe('[image: image/png omitted]\n[audio: audio/wav omitted]');
  });

  it('falls back to structuredContent when there is no content', () => {
    expect(renderMcpResult({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    expect(renderMcpResult({})).toBe('');
  });

  it('caps output at 100 KB with a visible marker', () => {
    const big = 'x'.repeat(MAX_MCP_OUTPUT_BYTES + 5000);
    const out = renderMcpResult({ content: [{ type: 'text', text: big }] });
    expect(MAX_MCP_OUTPUT_BYTES).toBe(100 * 1024);
    expect(out.endsWith('\n\n[output truncated at 100 KB]')).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThan(MAX_MCP_OUTPUT_BYTES + 100);
  });

  it('ignores junk content entries instead of throwing', () => {
    expect(renderMcpResult({ content: [null, 7, 'str', { type: 'text', text: 'ok' }] })).toBe('ok');
  });

  // TASK-944: tools/call results are no longer checked against the SDK's
  // content schema, so any field can hold any JSON value. An object whose
  // toString is not callable makes String() and template strings throw.
  it('renders hostile part shapes without throwing', () => {
    expect(
      renderMcpResult({
        content: [
          { type: { toString: 1 } },
          { type: 'resource', resource: { uri: { toString: 1 } } },
          { type: 'resource_link', uri: 7 },
          { type: 'image', mimeType: { toString: 1 } },
          { type: 'text', text: 'ok' },
        ],
      }),
    ).toBe('[resource omitted]\n[resource omitted]\n[image omitted]\nok');
  });

  it('stops reading parts once the output is past the cap', () => {
    // So an answer of a million small junk parts costs what 100 KB of them do.
    let read = 0;
    const later = {
      get type() {
        read += 1;
        return 'text';
      },
      text: 'never shown',
    };
    const out = renderMcpResult({
      content: [{ type: 'text', text: 'x'.repeat(MAX_MCP_OUTPUT_BYTES + 1) }, later, later],
    });
    expect(read).toBe(0);
    expect(out).toBe(`${'x'.repeat(MAX_MCP_OUTPUT_BYTES)}\n\n[output truncated at 100 KB]`);
  });

  it('prints structuredContent only when it is a JSON object it can print', () => {
    expect(renderMcpResult({ content: 'text', structuredContent: 'text' })).toBe('');
    expect(renderMcpResult({ structuredContent: [1, 2] })).toBe('');
    expect(renderMcpResult({ structuredContent: null })).toBe('');
    // JSON.parse takes this; JSON.stringify runs out of stack on it.
    const deep: unknown = JSON.parse(`${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`);
    expect(renderMcpResult({ structuredContent: deep })).toBe('[structured content omitted]');
  });
});
