import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_TOOL_NAMESPACE_RE,
  DISABLED_BUILTINS,
  DISABLED_BUILTIN_REASONS,
  MCP_HOST_SERVER_NAME,
  MCP_SANDBOX_SERVER_NAME,
  activityPhraseForSdkName,
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

  it.each(DISABLED_BUILTINS)('classifies %s as disabled, carrying its own reason', (name) => {
    expect(classifySdkToolName(name)).toEqual({
      kind: 'disabled',
      name,
      reason: DISABLED_BUILTIN_REASONS[name],
    });
  });

  it('gives each disabled built-in a DISTINCT reason', () => {
    // The point of the record. `disallowedTools` means neither the model nor a
    // person meets these strings in a healthy session (see tool-names.ts) — but
    // the two refusal sites are defence in depth, and a defence that fires
    // should say which of four different things it caught. One shared string
    // could not.
    const reasons = DISABLED_BUILTINS.map(
      (name) => DISABLED_BUILTIN_REASONS[name],
    );
    expect(new Set(reasons).size).toBe(DISABLED_BUILTINS.length);
  });

  it('names the sanctioned alternative for the three tools that have one', () => {
    // WebFetch/WebSearch have host-side replacements; AskUserQuestion has plain
    // chat. `Task` deliberately has none — it is refused outright — so this
    // pins the asymmetry rather than pretending all four route somewhere.
    expect(DISABLED_BUILTIN_REASONS.WebFetch).toContain('web_extract');
    expect(DISABLED_BUILTIN_REASONS.WebSearch).toContain('web_search');
    expect(DISABLED_BUILTIN_REASONS.AskUserQuestion).toContain('in your reply');
    expect(DISABLED_BUILTIN_REASONS.Task).toContain('no substitute');
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
    expect(classifySdkToolName('AskUserQuestion')).toEqual({
      kind: 'disabled',
      name: 'AskUserQuestion',
      reason: DISABLED_BUILTIN_REASONS.AskUserQuestion,
    });
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

  describe('host-minted connector namespaces (TASK-734)', () => {
    // Connector MCP servers are written to the sandbox `.mcp.json` keyed by an
    // opaque host-minted `toolNamespace` (`c` + 10 hex), so the SDK names
    // their tools `mcp__<ns>__<tool>`. Those — and only those — are lifted
    // into the canonical `mcp.<ns>.<tool>` key tool-policy sees.
    it('lifts mcp__<ns>__<tool> to the canonical mcp.<ns>.<tool> key', () => {
      expect(classifySdkToolName('mcp__c0123456789__send_message')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.c0123456789.send_message',
      });
    });

    it('accepts any lowercase-hex digit in the 10-char suffix', () => {
      expect(classifySdkToolName('mcp__cabcdef0123__t')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.cabcdef0123.t',
      });
    });

    it('preserves a tool part that itself contains `__` verbatim', () => {
      expect(classifySdkToolName('mcp__c0123456789__issue__create_v2')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.c0123456789.issue__create_v2',
      });
    });

    it('preserves a tool part containing dots and dashes verbatim', () => {
      expect(classifySdkToolName('mcp__c0123456789__list-issues.v2')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.c0123456789.list-issues.v2',
      });
    });

    it('lifts a tool part carrying a newline too (cannot sidestep a namespace-scoped rule)', () => {
      expect(classifySdkToolName('mcp__c0123456789__a\nb')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.c0123456789.a\nb',
      });
    });

    it.each([
      ['a foreign (non-namespace) server name', 'mcp__linear__x'],
      ['an uppercase C prefix', 'mcp__C0123456789__x'],
      ['uppercase hex digits', 'mcp__c01234567AB__x'],
      ['9 hex chars (too short)', 'mcp__c012345678__x'],
      ['11 hex chars (too long)', 'mcp__c01234567890__x'],
      ['a non-hex namespace char', 'mcp__cg123456789__x'],
      ['an empty tool part', 'mcp__c0123456789__'],
      ['a missing tool separator', 'mcp__c0123456789'],
    ])('does NOT lift %s — verbatim builtin pass-through', (_label, name) => {
      expect(classifySdkToolName(name)).toEqual({ kind: 'builtin', axName: name });
    });

    it('does not lift a namespace-looking name without the mcp__ lead', () => {
      expect(classifySdkToolName('xmcp__c0123456789__x')).toEqual({
        kind: 'builtin',
        axName: 'xmcp__c0123456789__x',
      });
    });

    it('leaves the ax host/sandbox prefixed names unchanged (they win)', () => {
      expect(
        classifySdkToolName(`mcp__${MCP_HOST_SERVER_NAME}__c0123456789__x`),
      ).toEqual({ kind: 'mcp-host', axName: 'c0123456789__x' });
      expect(
        classifySdkToolName(`mcp__${MCP_SANDBOX_SERVER_NAME}__c0123456789__x`),
      ).toEqual({ kind: 'mcp-sandbox', axName: 'c0123456789__x' });
    });

    it('exports a namespace regex that matches the host-minted shape only', () => {
      expect(CONNECTOR_TOOL_NAMESPACE_RE.test('c0123456789')).toBe(true);
      expect(CONNECTOR_TOOL_NAMESPACE_RE.test('c012345678')).toBe(false);
      expect(CONNECTOR_TOOL_NAMESPACE_RE.test('C0123456789')).toBe(false);
      expect(CONNECTOR_TOOL_NAMESPACE_RE.test('xc0123456789')).toBe(false);
      expect(CONNECTOR_TOOL_NAMESPACE_RE.test('c0123456789\n')).toBe(false);
    });

    it('lifts a REAL namespace @ax/connectors derives (cross-package drift pin)', () => {
      // `c5e0235982f` is the literal @ax/connectors' tool-namespace.test.ts pins
      // for deriveToolNamespace('userA','linear','linear'). The regex is
      // hand-mirrored (I2); if either side's shape drifts, one of the two pins
      // reddens instead of real connector tools silently passing through raw.
      expect(classifySdkToolName('mcp__c5e0235982f__create_issue')).toEqual({
        kind: 'mcp-connector',
        axName: 'mcp.c5e0235982f.create_issue',
      });
    });
  });

  it('treats empty string as builtin pass-through (no crash)', () => {
    // Empty is degenerate — propagate rather than invent classification logic
    // the host shouldn't encode. Host-side subscribers will reject nameless
    // tool calls on their own terms.
    expect(classifySdkToolName('')).toEqual({ kind: 'builtin', axName: '' });
  });
});

describe('activityPhraseForSdkName (TASK-271)', () => {
  const phrases = new Map([
    ['artifact_publish', 'Publishing a file'],
    ['memory_search', 'Searching memory'],
  ]);

  it('resolves an MCP-namespaced sandbox tool to its catalog phrase', () => {
    expect(
      activityPhraseForSdkName(
        phrases,
        `mcp__${MCP_SANDBOX_SERVER_NAME}__artifact_publish`,
      ),
    ).toBe('Publishing a file');
  });

  it('resolves an MCP-namespaced host tool to its catalog phrase', () => {
    expect(
      activityPhraseForSdkName(
        phrases,
        `mcp__${MCP_HOST_SERVER_NAME}__memory_search`,
      ),
    ).toBe('Searching memory');
  });

  it('returns undefined for a connector-namespaced tool (not in the catalog)', () => {
    expect(
      activityPhraseForSdkName(phrases, 'mcp__c0123456789__artifact_publish'),
    ).toBeUndefined();
  });

  it('returns undefined for names missing from the catalog', () => {
    expect(activityPhraseForSdkName(phrases, 'Bash')).toBeUndefined();
    expect(
      activityPhraseForSdkName(phrases, 'mcp__other-server__foo'),
    ).toBeUndefined();
  });

  it('returns undefined for disabled built-ins even when catalogued', () => {
    const withDisabled = new Map([...phrases, ['WebFetch', 'Fetching the web']]);
    expect(activityPhraseForSdkName(withDisabled, 'WebFetch')).toBeUndefined();
  });
});
