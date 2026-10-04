import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import { BUILTIN_RULES } from '../rules.js';
import type { PolicyRule, PolicyVerdict } from '../types.js';
import {
  ceilingFor,
  implicitMcpCeiling,
  isLooserThan,
  isMcpSpelled,
  isMcpToolKey,
  isOverridableKey,
  layeredVerdict,
  parseConnectorToolKey,
  staticCeiling,
  strictest,
} from '../verdicts.js';

/**
 * TASK-736 — the precedence matrix. `effective = strictest(static, connector
 * ceiling, agent override)`, with an implicit `hold` ceiling on a connector tool
 * nobody set a default for. This file pins the pure half; the bus half is
 * `verdict-hooks.test.ts`.
 */

const V: PolicyVerdict[] = ['allow', 'hold', 'deny'];
const RANK: Record<PolicyVerdict, number> = { allow: 0, hold: 1, deny: 2 };
const max = (...vs: PolicyVerdict[]): PolicyVerdict =>
  vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow');

/** `c5e0235982f` is a real `deriveToolNamespace` output, pinned in @ax/connectors' tests too. */
const NS = 'c5e0235982f';
const CONNECTOR_KEY = `mcp.${NS}.send_message`;

describe('strictest', () => {
  it('orders allow < hold < deny and ignores undefined', () => {
    expect(strictest()).toBe('allow');
    expect(strictest('allow', undefined, 'hold')).toBe('hold');
    expect(strictest('deny', 'allow')).toBe('deny');
    expect(strictest('hold', 'allow')).toBe('hold');
  });

  it('reads an unrecognised verdict as deny — a corrupt row can only tighten', () => {
    expect(strictest('allow', 'yes' as unknown as PolicyVerdict)).toBe('deny');
  });
});

describe('layeredVerdict — the full static × ceiling × override matrix', () => {
  for (const staticVerdict of V) {
    for (const connectorDefault of [...V, undefined]) {
      for (const override of [...V, undefined]) {
        const expected = max(staticVerdict, connectorDefault ?? 'hold', override ?? 'allow');
        it(`connector key: static=${staticVerdict} default=${connectorDefault ?? '∅'} override=${override ?? '∅'} → ${expected}`, () => {
          expect(
            layeredVerdict({ toolName: CONNECTOR_KEY, staticVerdict, connectorDefault, override, agentSourced: false }),
          ).toBe(expected);
        });
      }
    }
  }

  it('never loosens a static verdict, whatever is stored', () => {
    for (const staticVerdict of V) {
      for (const override of V) {
        const out = layeredVerdict({
          toolName: 'Bash',
          staticVerdict,
          connectorDefault: undefined,
          override,
          agentSourced: false,
        });
        expect(RANK[out]).toBeGreaterThanOrEqual(RANK[staticVerdict]);
      }
    }
  });

  it('an unknown connector tool (no default, no override) is held — Ask first', () => {
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: undefined,
        override: undefined,
        agentSourced: false,
      }),
    ).toBe('hold');
  });

  it('TASK-699: an admin host MCP tool is held by default too — it used to keep the static allow', () => {
    expect(
      layeredVerdict({
        toolName: 'mcp.github.list_issues',
        staticVerdict: 'allow',
        connectorDefault: undefined,
        override: undefined,
        agentSourced: false,
      }),
    ).toBe('hold');
  });

  it('TASK-699: no stored row can loosen a non-connector MCP tool past hold', () => {
    for (const toolName of ['mcp.github.create_issue', 'mcp__linear__create_issue']) {
      for (const override of [undefined, 'allow', 'hold'] as const) {
        // A connector default is meaningless for these keys and must not be
        // honoured even if a caller passes one.
        expect(
          layeredVerdict({ toolName, staticVerdict: 'allow', connectorDefault: 'allow', override, agentSourced: false }),
        ).toBe('hold');
      }
      expect(
        layeredVerdict({ toolName, staticVerdict: 'allow', connectorDefault: undefined, override: 'deny', agentSourced: false }),
      ).toBe('deny');
    }
  });

  it('an admin Allow is honoured; an admin tightening after a snapshot still applies', () => {
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: 'allow',
        override: 'allow',
        agentSourced: false,
      }),
    ).toBe('allow');
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: 'deny',
        override: 'allow',
        agentSourced: false,
      }),
    ).toBe('deny');
  });

  it('a snapshot hold survives an admin LOOSENING the default to allow', () => {
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: 'allow',
        override: 'hold',
        agentSourced: false,
      }),
    ).toBe('hold');
  });
});

describe('ceilingFor — what set-agent-override accepts', () => {
  it('admin Ask → the agent may pick Ask or Deny, never Allow', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'hold', false);
    expect(ceiling).toBe('hold');
    expect(isLooserThan('allow', ceiling)).toBe(true);
    expect(isLooserThan('hold', ceiling)).toBe(false);
    expect(isLooserThan('deny', ceiling)).toBe(false);
  });

  it('admin Deny → nothing but Deny', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'deny', false);
    expect(isLooserThan('allow', ceiling)).toBe(true);
    expect(isLooserThan('hold', ceiling)).toBe(true);
    expect(isLooserThan('deny', ceiling)).toBe(false);
  });

  it('admin Allow → anything', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'allow', false);
    for (const v of V) expect(isLooserThan(v, ceiling)).toBe(false);
  });

  it('no admin default → capped at Ask first', () => {
    expect(ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, undefined, false)).toBe('hold');
  });

  it('abilities are capped by their static rule: web_extract cannot be set to allow', () => {
    expect(ceilingFor(BUILTIN_RULES, 'web_extract', undefined, false)).toBe('hold');
    expect(ceilingFor(BUILTIN_RULES, 'web_search', undefined, false)).toBe('allow');
    expect(ceilingFor(BUILTIN_RULES, 'Bash', undefined, false)).toBe('allow');
  });

  it('staticCeiling reads the first UNCONDITIONAL rule', () => {
    expect(staticCeiling(BUILTIN_RULES, 'WebFetch')).toBe('deny');
    expect(
      staticCeiling(
        [
          { id: 'x.narrow', match: { tool: 'x', when: { field: 'a', equals: 1 } }, verdict: 'deny', capability: 'c', subject: 'agent' },
          { id: 'x.broad', match: { tool: 'x' }, verdict: 'hold', capability: 'c', subject: 'agent' },
        ],
        'x',
      ),
    ).toBe('hold');
  });
});

describe('which keys an override may name', () => {
  it('accepts the three abilities and mcp.* keys', () => {
    for (const k of ['web_search', 'web_extract', 'Bash', CONNECTOR_KEY, 'mcp.github.list_issues']) {
      expect(isOverridableKey(k)).toBe(true);
    }
  });

  it('refuses every static rule a person must not be able to touch — cannot loosen WebFetch', () => {
    for (const k of [
      'WebFetch',
      'WebSearch',
      'Task',
      'AskUserQuestion',
      'request_capability',
      'connector_propose',
      'skill_propose',
      'Read',
      'Write',
      'memory_note',
    ]) {
      expect(isOverridableKey(k)).toBe(false);
    }
    // …and even if one were stored, the static deny wins.
    const base = evaluate(BUILTIN_RULES, { name: 'WebFetch', input: {} });
    expect(base.verdict).toBe('deny');
    expect(
      layeredVerdict({ toolName: 'WebFetch', staticVerdict: base.verdict, connectorDefault: undefined, override: 'allow', agentSourced: false }),
    ).toBe('deny');
  });

  it('refuses malformed mcp keys', () => {
    for (const k of ['mcp.', 'mcp..x', 'mcp.x', 'mcp.x.', 'mcp.x.has space', `mcp.x.${'a'.repeat(300)}`, 42, null]) {
      expect(isMcpToolKey(k)).toBe(false);
    }
  });
});

describe('parseConnectorToolKey', () => {
  it('splits a connector key at the first dot after the namespace', () => {
    expect(parseConnectorToolKey(`mcp.${NS}.files.read`)).toEqual({ toolNamespace: NS, tool: 'files.read' });
  });

  it('only a host-minted c<10 hex> namespace is a connector', () => {
    expect(parseConnectorToolKey('mcp.github.list_issues')).toBeNull();
    expect(parseConnectorToolKey('mcp.C5E0235982F.x')).toBeNull();
    expect(parseConnectorToolKey('mcp.c5e0235982.x')).toBeNull();
    expect(parseConnectorToolKey(`mcp__${NS}__x`)).toBeNull();
    expect(parseConnectorToolKey(`mcp.${NS}.`)).toBeNull();
  });
});

describe('implicitMcpCeiling — the MCP "Ask first" floor (TASK-699)', () => {
  it('holds every MCP spelling nobody set a default for', () => {
    for (const k of [
      CONNECTOR_KEY, // connector, no default
      'mcp.github.list_issues', // admin host MCP server
      'mcp__linear__create_issue', // unlifted SDK wire name
      `mcp__${NS}__send_message`, // a connector shape that arrived unlifted
      `mcp.github.${'a'.repeat(300)}`, // over MAX_TOOL_KEY_CHARS — server-chosen length
      `mcp.${NS}.${'a'.repeat(300)}`, // over-long CONNECTOR key no longer parses as one
      'mcp.x', // no tool half
      'mcp.x.has space',
    ]) {
      expect(isMcpSpelled(k)).toBe(true);
      expect(implicitMcpCeiling(k, undefined, false)).toBe('hold');
    }
  });

  it('only a well-formed connector key can be loosened, and only by its connector default', () => {
    expect(implicitMcpCeiling(CONNECTOR_KEY, 'allow', false)).toBe('allow');
    expect(implicitMcpCeiling(CONNECTOR_KEY, 'deny', false)).toBe('deny');
    expect(implicitMcpCeiling('mcp.github.list_issues', 'allow', false)).toBe('hold');
    expect(implicitMcpCeiling(`mcp.${NS}.${'a'.repeat(300)}`, 'allow', false)).toBe('hold');
  });

  it('a non-MCP tool is not newly held — the floor says nothing about it', () => {
    for (const k of ['Read', 'Bash', 'web_search', 'gmail_send', 'MCP.github.x', 'xmcp.github.x', 'mcp_github_x', '']) {
      expect(isMcpSpelled(k)).toBe(false);
      expect(implicitMcpCeiling(k, undefined, false)).toBeUndefined();
    }
    expect(isMcpSpelled(42)).toBe(false);
    expect(isMcpSpelled(null)).toBe(false);
  });

  it('ceilingFor caps a host MCP tool at hold, so an agent cannot pick Allow for it', () => {
    expect(ceilingFor(BUILTIN_RULES, 'mcp.github.list_issues', undefined, false)).toBe('hold');
    expect(ceilingFor(BUILTIN_RULES, 'Bash', undefined, false)).toBe(staticCeiling(BUILTIN_RULES, 'Bash'));
  });
});

// TASK-809 — a connector tool namespace whose ceiling source is the AGENT: no
// admin ceiling, a person chooses per agent, and a tool nobody chose is held.
describe('agent-sourced namespaces (TASK-809)', () => {
  const lv = (
    override: PolicyVerdict | undefined,
    connectorDefault?: PolicyVerdict,
    staticVerdict: PolicyVerdict = 'allow',
  ) =>
    layeredVerdict({ toolName: CONNECTOR_KEY, staticVerdict, connectorDefault, override, agentSourced: true });

  it('ceilingFor is the static ceiling only — no implicit connector floor, default ignored', () => {
    expect(ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, undefined, true)).toBe('allow');
    expect(ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'deny', true)).toBe('allow');
    expect(implicitMcpCeiling(CONNECTOR_KEY, 'deny', true)).toBeUndefined();
    // A static rule naming the tool still caps it.
    const rules: PolicyRule[] = [
      { id: 'x.y', match: { tool: CONNECTOR_KEY }, verdict: 'deny', capability: 'do x', subject: 'agent' },
    ];
    expect(ceilingFor(rules, CONNECTOR_KEY, undefined, true)).toBe('deny');
  });

  it('no override → hold; override allow → allow; the connector default is ignored', () => {
    expect(lv(undefined)).toBe('hold');
    expect(lv(undefined, 'allow')).toBe('hold');
    expect(lv('allow')).toBe('allow');
    expect(lv('allow', 'deny')).toBe('allow');
    expect(lv('allow', 'hold')).toBe('allow');
    expect(lv('deny', 'allow')).toBe('deny');
  });

  it('a static verdict still wins over an agent Allow', () => {
    expect(lv('allow', undefined, 'deny')).toBe('deny');
    expect(lv('allow', undefined, 'hold')).toBe('hold');
  });

  it('the agent-sourced flag means nothing for a non-connector key', () => {
    for (const toolName of ['mcp.github.create_issue', 'mcp__linear__create_issue']) {
      expect(
        layeredVerdict({
          toolName,
          staticVerdict: 'allow',
          connectorDefault: undefined,
          override: 'allow',
          agentSourced: true,
        }),
      ).toBe('hold');
      expect(ceilingFor(BUILTIN_RULES, toolName, undefined, true)).toBe('hold');
    }
    expect(ceilingFor(BUILTIN_RULES, 'web_extract', undefined, true)).toBe('hold');
  });

  it('connector-sourced is unchanged: default allow + override allow = allow; no default + override allow = hold', () => {
    const base = { toolName: CONNECTOR_KEY, staticVerdict: 'allow' as const, override: 'allow' as const, agentSourced: false };
    expect(layeredVerdict({ ...base, connectorDefault: 'allow' })).toBe('allow');
    expect(layeredVerdict({ ...base, connectorDefault: undefined })).toBe('hold');
    expect(ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, undefined, false)).toBe('hold');
  });
});
