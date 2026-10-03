import { describe, expect, it } from 'vitest';
import { connectorToolLabel as coreConnectorToolLabel } from '@ax/core/humanize';
import {
  CONNECTOR_TOOL_NAMESPACE_RE,
  connectorNamesFromRows,
  connectorNamesToRows,
  connectorToolLabel,
  parseConnectorToolName,
  toolMatchName,
  type ConnectorNames,
} from '../connector-tool-label';
import { shapeSteps } from '../workspace-steps';

// The literal @ax/connectors' and the runner's tests pin as a real derived
// namespace (TASK-734). Pinned here too: the shape is re-stated, not imported.
const NS = 'c5e0235982f';
const NAMES: ConnectorNames = new Map([[NS, { name: 'Linear' }]]);

describe('parseConnectorToolName', () => {
  it('reads both spellings of a connector tool', () => {
    expect(NS).toMatch(CONNECTOR_TOOL_NAMESPACE_RE);
    expect(parseConnectorToolName(`mcp__${NS}__create_issue`)).toEqual({ toolNamespace: NS, tool: 'create_issue' });
    expect(parseConnectorToolName(`mcp.${NS}.create_issue`)).toEqual({ toolNamespace: NS, tool: 'create_issue' });
  });
  it('refuses everything that is not a host-minted namespace', () => {
    for (const name of [
      'mcp__linear__create_issue',
      'mcp__ax-host-tools__web_search',
      'mcp.linear.create_issue',
      `mcp__${NS.toUpperCase()}__x`,
      `mcp__${NS}__`,
      'Bash',
    ]) {
      expect(parseConnectorToolName(name)).toBeNull();
    }
  });
});

describe('toolMatchName', () => {
  it('maps both connector spellings to one key and strips other mcp__ wrappers', () => {
    expect(toolMatchName(`mcp__${NS}__create_issue`)).toBe(`mcp.${NS}.create_issue`);
    expect(toolMatchName(`mcp.${NS}.create_issue`)).toBe(`mcp.${NS}.create_issue`);
    expect(toolMatchName('mcp__ax-host-tools__web_extract')).toBe('web_extract');
    expect(toolMatchName('Bash')).toBe('Bash');
  });
});

describe('connectorToolLabel', () => {
  it('names the connector and the tool when the namespace is known', () => {
    expect(connectorToolLabel(`mcp__${NS}__create_issue`, NAMES)).toBe('Linear · Create issue');
    expect(connectorToolLabel(`mcp.${NS}.create_issue`, NAMES)).toBe('Linear · Create issue');
  });
  it('falls back to the tool alone for an unknown namespace or no map', () => {
    expect(connectorToolLabel('mcp__c0123456789__create_issue', NAMES)).toBe('Create issue');
    expect(connectorToolLabel(`mcp__${NS}__create_issue`, undefined)).toBe('Create issue');
  });
  it('is undefined for a tool that is not a connector tool', () => {
    expect(connectorToolLabel('Bash', NAMES)).toBeUndefined();
    expect(connectorToolLabel('mcp__linear__create_issue', NAMES)).toBeUndefined();
  });
  it('never returns the namespace, even when the tool part is unreadable', () => {
    expect(connectorToolLabel(`mcp.${NS}.​`, undefined)).toBe('Connector tool');
    expect(connectorToolLabel(`mcp.${NS}.​`, NAMES)).toBe('Linear');
  });
  it('fences an untrusted connector name and tool name to one bounded line', () => {
    const hostile: ConnectorNames = new Map([[NS, { name: `Evil‮\nname${'x'.repeat(200)}` }]]);
    const label = connectorToolLabel(`mcp__${NS}__${'y'.repeat(300)}`, hostile)!;
    expect(label).not.toMatch(/[\n‮]/);
    expect([...label].length).toBeLessThanOrEqual(40 + 3 + 48);
  });
});

describe('shapeSteps names connector tools (TASK-744)', () => {
  it('uses the connector label over the stripped tool name, and the phrase over both', () => {
    const panel = shapeSteps(
      [
        { id: '1', name: `mcp__${NS}__create_issue`, status: 'done' },
        { id: '2', name: `mcp__${NS}__create_issue`, phrase: 'Filing an issue', status: 'done' },
        { id: '3', name: 'mcp__c0123456789__list_files', status: 'done' },
      ],
      NAMES,
    );
    expect(panel?.steps.map((s) => s.text)).toEqual([
      'Linear · Create issue',
      'Filing an issue',
      'List files',
    ]);
  });
});

describe('one label on every surface (TASK-753)', () => {
  // `@ax/decisions` writes the approval card's label with the SAME core
  // composer (its own test pins that half against `@ax/core/humanize` too), so
  // equality with the core composer here is equality with the card.
  it.each([
    ['create_pdf', 'Create PDF'],
    ['create_issue', 'Create issue'],
    ['getFileContents', 'Get file contents'],
    ['list-projects', 'List projects'],
    ['export_csv', 'Export CSV'],
  ])('%s reads %s on the activity rail, the transcript and the card', (tool, expected) => {
    const rail = connectorToolLabel(`mcp__${NS}__${tool}`, NAMES);
    const card = coreConnectorToolLabel('Linear', tool);
    expect(rail).toBe(`Linear · ${expected}`);
    expect(rail).toBe(card);
    // Both spellings of the same call agree, too.
    expect(connectorToolLabel(`mcp.${NS}.${tool}`, NAMES)).toBe(rail);
  });
});

describe("cached server tool titles (TASK-753)", () => {
  const TITLED: ConnectorNames = new Map([
    [NS, { name: 'Linear', tools: new Map([['create_issue', 'Open a ticket']]) }],
  ]);
  it("prefers the server's own title over the humanized name", () => {
    expect(connectorToolLabel(`mcp__${NS}__create_issue`, TITLED)).toBe('Linear · Open a ticket');
    expect(connectorToolLabel(`mcp.${NS}.create_issue`, TITLED)).toBe('Linear · Open a ticket');
    expect(connectorToolLabel(`mcp__${NS}__create_issue`, TITLED)).toBe(
      coreConnectorToolLabel('Linear', 'create_issue', 'Open a ticket'),
    );
  });
  it('falls back to the humanizer for a tool with no cached title', () => {
    expect(connectorToolLabel(`mcp__${NS}__create_pdf`, TITLED)).toBe('Linear · Create PDF');
  });
  it('shapeSteps uses the title on the step row', () => {
    const panel = shapeSteps([{ id: '1', name: `mcp__${NS}__create_issue`, status: 'done' }], TITLED);
    expect(panel?.steps.map((s) => s.text)).toEqual(['Linear · Open a ticket']);
  });
});

describe('connectorNamesFromRows / connectorNamesToRows (TASK-753)', () => {
  it('parses names and titles, fencing both, and round-trips through the wire', () => {
    const names = connectorNamesFromRows([
      {
        toolNamespace: NS,
        connectorId: 'linear',
        name: 'Linear',
        tools: [
          { name: 'create_issue', title: 'Open\n a\u202E ticket' },
          { name: 'list_issues', title: 'x'.repeat(500) },
        ],
      },
    ]);
    const tools = names.get(NS)!.tools!;
    expect(tools.get('create_issue')).toBe('Open a ticket');
    expect([...tools.get('list_issues')!]).toHaveLength(48);
    const rows = connectorNamesToRows(names);
    expect(rows).toEqual([
      {
        toolNamespace: NS,
        name: 'Linear',
        tools: [
          { name: 'create_issue', title: 'Open a ticket' },
          { name: 'list_issues', title: tools.get('list_issues') },
        ],
      },
    ]);
    expect(connectorNamesFromRows(rows)).toEqual(names);
  });
  it('drops what it cannot trust', () => {
    const names = connectorNamesFromRows([
      null,
      'x',
      { toolNamespace: 'linear', name: 'Not a namespace' },
      { toolNamespace: 'c0123456789', name: '   ' },
      { toolNamespace: 'c1111111111', name: 7 },
      {
        toolNamespace: NS,
        name: 'Linear',
        tools: [null, { name: '', title: 'x' }, { name: 'a', title: 3 }, { name: 'b', title: '\u200B' }, { name: 'y'.repeat(300), title: 'long key' }],
      },
    ]);
    expect([...names.keys()]).toEqual([NS]);
    expect(names.get(NS)).toEqual({ name: 'Linear' });
    expect(connectorNamesToRows(names)).toEqual([{ toolNamespace: NS, name: 'Linear' }]);
    expect(connectorNamesFromRows(undefined).size).toBe(0);
    expect(connectorNamesFromRows({ connectors: [] }).size).toBe(0);
  });
  it('bounds how many titles one namespace may carry', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, title: `T ${i}` }));
    const names = connectorNamesFromRows([{ toolNamespace: NS, name: 'Linear', tools: many }]);
    expect(names.get(NS)!.tools!.size).toBe(200);
  });
});
