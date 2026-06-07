import { describe, expect, it } from 'vitest';
import {
  DISABLED_BUILTINS,
  MCP_HOST_SERVER_NAME,
  MCP_SANDBOX_SERVER_NAME,
  classifySdkToolName,
} from '../tool-names.js';

describe('classifySdkToolName', () => {
  it('classifies a known built-in (Bash) as builtin, passing axName through', () => {
    expect(classifySdkToolName('Bash')).toEqual({ kind: 'builtin', axName: 'Bash' });
  });

  it('classifies an unknown built-in name as builtin (pass-through)', () => {
    // Unknown-to-us names pass through — it may be a new SDK tool that our
    // host-side subscribers need to see by its real name. We don't hardcode
    // the full built-in list here.
    expect(classifySdkToolName('Edit')).toEqual({ kind: 'builtin', axName: 'Edit' });
    expect(classifySdkToolName('Read')).toEqual({ kind: 'builtin', axName: 'Read' });
  });

  it.each(DISABLED_BUILTINS)('classifies %s as disabled', (name) => {
    expect(classifySdkToolName(name)).toEqual({ kind: 'disabled' });
  });

  it('classifies AskUserQuestion as disabled — no headless answer path', () => {
    // AskUserQuestion is an SDK built-in whose interactive picker is answered
    // by the CLI's own UI. In our headless stream-json runner there is no such
    // UI and no control-protocol round-trip wired to feed a user-chosen answer
    // back as the tool_result, so the model would emit a question the user can
    // never actually answer. Disabling it forces the model to ask in plain
    // chat instead (rendered + answerable in the normal turn flow — see the
    // clarifying-questions system-prompt note). This pins the classification
    // so a revert that drops it from DISABLED_BUILTINS fails loudly here.
    expect(classifySdkToolName('AskUserQuestion')).toEqual({ kind: 'disabled' });
  });

  it('classifies Skill as builtin (allowed) — I-P0-1 skill discovery', () => {
    // Skill was previously in DISABLED_BUILTINS on the "nested-agent
    // bypass" rationale. Phase 0 (docs/plans/2026-05-17-skill-install-
    // phase-0-impl.md) makes Skill the intended SDK-native skill-discovery
    // path, gated by validator-skill's veto on writes to .claude/settings.json
    // and other SDK-config paths (commit 521f206c). This test pins the
    // new classification so a revert that re-adds Skill to DISABLED_BUILTINS
    // would fail loudly here rather than silently re-disabling skill
    // discovery.
    expect(classifySdkToolName('Skill')).toEqual({
      kind: 'builtin',
      axName: 'Skill',
    });
  });

  it('strips our MCP prefix and returns the axName for ax-host-tools', () => {
    expect(
      classifySdkToolName(`mcp__${MCP_HOST_SERVER_NAME}__memory.recall`),
    ).toEqual({ kind: 'mcp-host', axName: 'memory.recall' });
  });

  it('handles an ax-host-tools axName that itself contains underscores', () => {
    expect(
      classifySdkToolName(`mcp__${MCP_HOST_SERVER_NAME}__some_tool__with_delims`),
    ).toEqual({ kind: 'mcp-host', axName: 'some_tool__with_delims' });
  });

  it('strips the sandbox-MCP prefix and returns the axName for ax-sandbox-tools', () => {
    expect(
      classifySdkToolName(`mcp__${MCP_SANDBOX_SERVER_NAME}__artifact_publish`),
    ).toEqual({ kind: 'mcp-sandbox', axName: 'artifact_publish' });
  });

  it('handles an ax-sandbox-tools axName that itself contains underscores', () => {
    expect(
      classifySdkToolName(`mcp__${MCP_SANDBOX_SERVER_NAME}__some_tool__with_delims`),
    ).toEqual({ kind: 'mcp-sandbox', axName: 'some_tool__with_delims' });
  });

  it('treats an MCP tool from a different server as builtin (full-name pass-through)', () => {
    // Not our server — we don't strip. The full `mcp__<server>__<tool>` name
    // is what the host-side tool:pre-call subscribers will see, and they
    // decide whether to permit / route / deny it.
    expect(classifySdkToolName('mcp__other-server__foo')).toEqual({
      kind: 'builtin',
      axName: 'mcp__other-server__foo',
    });
  });

  it('treats empty string as builtin pass-through (no crash)', () => {
    // Empty is degenerate — propagate rather than invent classification logic
    // the host shouldn't encode. Host-side subscribers will reject nameless
    // tool calls on their own terms.
    expect(classifySdkToolName('')).toEqual({ kind: 'builtin', axName: '' });
  });
});
