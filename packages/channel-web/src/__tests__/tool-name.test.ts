/**
 * stripMcpToolPrefix normalizes the SDK/MCP-namespaced tool name
 * (`mcp__<server>__<tool>`) that reaches the transcript UI back to the bare
 * ax-native name the renderers key on (TASK-81). Without this, a published
 * artifact arriving as `mcp__ax-sandbox-tools__artifact_publish` never matched
 * the `artifact_publish`-keyed chip renderer and rendered a dead
 * "unknown artifact" pill.
 */
import { describe, it, expect } from 'vitest';
import { stripMcpToolPrefix } from '../lib/tool-name';

describe('stripMcpToolPrefix', () => {
  it('strips the sandbox-MCP prefix the runner emits for artifact_publish', () => {
    expect(stripMcpToolPrefix('mcp__ax-sandbox-tools__artifact_publish')).toBe(
      'artifact_publish',
    );
  });

  it('strips the host-MCP prefix too', () => {
    expect(stripMcpToolPrefix('mcp__ax-host-tools__memory.recall')).toBe(
      'memory.recall',
    );
  });

  it('preserves a tool name that itself contains __ delimiters', () => {
    expect(
      stripMcpToolPrefix('mcp__ax-sandbox-tools__some_tool__with_delims'),
    ).toBe('some_tool__with_delims');
  });

  it('passes a bare (already-stripped) name through unchanged', () => {
    expect(stripMcpToolPrefix('artifact_publish')).toBe('artifact_publish');
  });

  it('passes a built-in SDK tool name through unchanged', () => {
    expect(stripMcpToolPrefix('Bash')).toBe('Bash');
  });

  it('does not strip a non-mcp name that merely contains mcp', () => {
    expect(stripMcpToolPrefix('web.search')).toBe('web.search');
  });
});
