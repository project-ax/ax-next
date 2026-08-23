import { describe, expect, it } from 'vitest';
import { capabilityRows, fullyDescribedTools } from '../plugin.js';
import type { PolicyRule } from '../types.js';

const RULES: PolicyRule[] = [
  {
    id: 'z.deny',
    match: { tool: 'z' },
    verdict: 'deny',
    capability: 'delete anything',
    subject: 'agent',
  },
  {
    id: 'a.allow.second',
    match: { tool: 'a2' },
    verdict: 'allow',
    capability: 'search the web',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'b.hold',
    match: { tool: 'b' },
    verdict: 'hold',
    capability: 'write to a customer',
    subject: 'agent',
  },
  {
    id: 'a.allow.first',
    match: { tool: 'a1' },
    verdict: 'allow',
    capability: 'read a web page you name',
    subject: 'agent',
    provenance: 'catalog',
  },
];

describe('capabilityRows — outOfReach (the scope subtraction)', () => {
  /*
    The rule table is GLOBAL: it describes what the product enforces, not what a
    particular agent is wired to reach. Returned unfiltered to a per-agent
    surface, it asserts reach the agent may not have — "Can search the web — on
    its own" for an agent that cannot call `web_search` — which is a false ALLOW
    claim on a blast-radius display and the one direction design H3/H4 says
    never to be wrong in.

    The caller does the subtraction because only it holds the tool catalog; this
    plugin applies it, because only it holds `match.tool`.
  */
  it('drops an allow whose tool the caller proved unreachable', () => {
    const sources = capabilityRows(RULES, { outOfReach: ['a2'] }).map((r) => r.source);
    expect(sources).not.toContain('rule:a.allow.second');
    expect(sources).toContain('rule:a.allow.first');
  });

  it('drops a hold too — an "asks you first" it cannot reach is the same lie', () => {
    const sources = capabilityRows(RULES, { outOfReach: ['b'] }).map((r) => r.source);
    expect(sources).not.toContain('rule:b.hold');
  });

  it('KEEPS a deny, whatever the scope says', () => {
    // A deny for a tool the agent could not reach anyway is still true, and it
    // is reassurance rather than reach. Dropping it would understate our own
    // restrictions: it costs the reader information and endangers nobody.
    const sources = capabilityRows(RULES, { outOfReach: ['z', 'a2', 'b', 'a1'] }).map(
      (r) => r.source,
    );
    expect(sources).toEqual(['rule:z.deny']);
  });

  it('drops nothing when the caller proved nothing', () => {
    const all = capabilityRows(RULES).map((r) => r.source);
    expect(capabilityRows(RULES, {}).map((r) => r.source)).toEqual(all);
    expect(capabilityRows(RULES, { outOfReach: [] }).map((r) => r.source)).toEqual(all);
    expect(
      capabilityRows(RULES, { outOfReach: undefined }).map((r) => r.source),
    ).toEqual(all);
  });

  it('keeps the allow → hold → deny order and the authored order inside a group', () => {
    expect(capabilityRows(RULES, { outOfReach: ['a1'] }).map((r) => r.source)).toEqual([
      'rule:a.allow.second',
      'rule:b.hold',
      'rule:z.deny',
    ]);
  });

  it('never exposes the tool it filtered on', () => {
    // `match.tool` stays inside this module. Putting an identifier on a display
    // row is a foot-gun on a surface whose mechanical rows ARE tool names.
    for (const row of capabilityRows(RULES, { outOfReach: ['a2'] })) {
      expect(Object.keys(row).sort()).toEqual([
        'capability',
        'conditional',
        'described',
        'provenance',
        'source',
        'verdict',
      ]);
    }
  });
});

describe('capabilityRows', () => {
  it('sorts allow → hold → deny (§4.3.2)', () => {
    expect(capabilityRows(RULES).map((r) => r.verdict)).toEqual([
      'allow',
      'allow',
      'hold',
      'deny',
    ]);
  });

  it('is stable inside a verdict group — authored order is reading order', () => {
    // `a.allow.second` is declared before `a.allow.first` in the table, so it
    // must stay first. A sort that reordered inside the group would make the
    // rail's reading order an accident.
    expect(capabilityRows(RULES).slice(0, 2).map((r) => r.source)).toEqual([
      'rule:a.allow.second',
      'rule:a.allow.first',
    ]);
  });

  it('stamps every built-in row described:true with a rule: source', () => {
    for (const row of capabilityRows(RULES)) {
      expect(row.described).toBe(true);
      expect(row.source.startsWith('rule:')).toBe(true);
      expect(row.theirDescription).toBeUndefined();
      expect(row.mechanicalLabel).toBeUndefined();
    }
  });

  it('carries provenance separately from the display source string', () => {
    const rows = capabilityRows(RULES);
    // The renderer switches on `provenance`; `source` is opaque display text
    // it must never parse (see the boundary review).
    expect(rows.find((r) => r.source === 'rule:a.allow.first')!.provenance).toBe('catalog');
    expect(rows.find((r) => r.source === 'rule:z.deny')!.provenance).toBe('rule');
  });

  it('does not mutate the rule table it was handed', () => {
    const before = JSON.stringify(RULES);
    capabilityRows(RULES);
    expect(JSON.stringify(RULES)).toBe(before);
  });
});

/*
  TASK-267. Two facts about a rule that the rail cannot get from
  `tool-policy:evaluate`, because `evaluate` answers about ONE CALL and the rail
  is not making one.

    - `conditional` — this rule's verdict applies to some calls and not others.
      A row that renders "Can X — asks you first" for a rule that only holds
      when an argument takes a particular value is asserting a restriction the
      table does not enforce.
    - `describedTools` — which tools the table names AT ALL, predicate or no
      predicate. This is what tells a caller "a described row already covers
      this tool", and it is a property of the TABLE, so no fabricated argument
      set can change the answer.
*/
const WHEN_RULES: PolicyRule[] = [
  {
    id: 'files.delete-recursive',
    match: { tool: 'delete_file', when: { field: 'recursive', equals: true } },
    verdict: 'hold',
    capability: 'delete a folder and everything in it',
    subject: 'agent',
  },
  {
    id: 'files.delete',
    match: { tool: 'delete_file' },
    verdict: 'allow',
    capability: 'delete a file it made',
    subject: 'agent',
  },
  {
    id: 'net.reach',
    match: { tool: 'web_search' },
    verdict: 'allow',
    capability: 'search the web',
    subject: 'agent',
  },
];

describe('capabilityRows — conditional', () => {
  it('marks a row whose rule carries a predicate, and only that row', () => {
    const rows = capabilityRows(WHEN_RULES);
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(bySource.get('rule:files.delete-recursive')?.conditional).toBe(true);
    expect(bySource.get('rule:files.delete')?.conditional).toBe(false);
    expect(bySource.get('rule:net.reach')?.conditional).toBe(false);
  });

  it('is false on every rule in a table with no predicates — not undefined', () => {
    // `undefined` would render the same as `false` today and differently the
    // day a renderer switches on it. The field is a boolean on every row.
    for (const row of capabilityRows(RULES)) {
      expect(row.conditional).toBe(false);
    }
  });
});

describe('fullyDescribedTools', () => {
  it('names a tool that has an unconditional rule, predicate rules or not', () => {
    // `delete_file` carries both a `when` rule and a broad one; the broad one
    // is what speaks for every call, so the table accounts for the tool.
    expect(fullyDescribedTools(WHEN_RULES).sort()).toEqual(['delete_file', 'web_search']);
  });

  it('OMITS a tool every one of whose rules is conditional', () => {
    /*
      The distinction the whole field exists for. Such a tool IS named by the
      table, and its row says what happens to the calls the predicate catches —
      but nothing says what happens to the rest, which for an exception table
      over an allow baseline is the tool running on its own. A caller told this
      tool was accounted for would render the gate and swallow the reach.
    */
    const onlyConditional: PolicyRule[] = [WHEN_RULES[0] as PolicyRule];
    expect(fullyDescribedTools(onlyConditional)).toEqual([]);
  });

  it('deduplicates — two unconditional rules for one tool is one entry', () => {
    const twice: PolicyRule[] = [
      { id: 'a', match: { tool: 't' }, verdict: 'allow', capability: 'do a thing', subject: 'agent' },
      { id: 'b', match: { tool: 't' }, verdict: 'deny', capability: 'do another thing', subject: 'agent' },
    ];
    expect(fullyDescribedTools(twice)).toEqual(['t']);
  });

  it('is empty for an empty table', () => {
    expect(fullyDescribedTools([])).toEqual([]);
  });
});
