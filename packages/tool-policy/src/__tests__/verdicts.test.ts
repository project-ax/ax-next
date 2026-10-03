import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import { BUILTIN_RULES } from '../rules.js';
import type { PolicyVerdict } from '../types.js';
import {
  ceilingFor,
  isLooserThan,
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
            layeredVerdict({ toolName: CONNECTOR_KEY, staticVerdict, connectorDefault, override }),
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
      }),
    ).toBe('hold');
  });

  it('the implicit hold is for CONNECTOR keys only — an admin host MCP tool keeps its static answer', () => {
    expect(
      layeredVerdict({
        toolName: 'mcp.github.list_issues',
        staticVerdict: 'allow',
        connectorDefault: undefined,
        override: undefined,
      }),
    ).toBe('allow');
  });

  it('an admin Allow is honoured; an admin tightening after a snapshot still applies', () => {
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: 'allow',
        override: 'allow',
      }),
    ).toBe('allow');
    expect(
      layeredVerdict({
        toolName: CONNECTOR_KEY,
        staticVerdict: 'allow',
        connectorDefault: 'deny',
        override: 'allow',
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
      }),
    ).toBe('hold');
  });
});

describe('ceilingFor — what set-agent-override accepts', () => {
  it('admin Ask → the agent may pick Ask or Deny, never Allow', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'hold');
    expect(ceiling).toBe('hold');
    expect(isLooserThan('allow', ceiling)).toBe(true);
    expect(isLooserThan('hold', ceiling)).toBe(false);
    expect(isLooserThan('deny', ceiling)).toBe(false);
  });

  it('admin Deny → nothing but Deny', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'deny');
    expect(isLooserThan('allow', ceiling)).toBe(true);
    expect(isLooserThan('hold', ceiling)).toBe(true);
    expect(isLooserThan('deny', ceiling)).toBe(false);
  });

  it('admin Allow → anything', () => {
    const ceiling = ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, 'allow');
    for (const v of V) expect(isLooserThan(v, ceiling)).toBe(false);
  });

  it('no admin default → capped at Ask first', () => {
    expect(ceilingFor(BUILTIN_RULES, CONNECTOR_KEY, undefined)).toBe('hold');
  });

  it('abilities are capped by their static rule: web_extract cannot be set to allow', () => {
    expect(ceilingFor(BUILTIN_RULES, 'web_extract', undefined)).toBe('hold');
    expect(ceilingFor(BUILTIN_RULES, 'web_search', undefined)).toBe('allow');
    expect(ceilingFor(BUILTIN_RULES, 'Bash', undefined)).toBe('allow');
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
      layeredVerdict({ toolName: 'WebFetch', staticVerdict: base.verdict, connectorDefault: undefined, override: 'allow' }),
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
