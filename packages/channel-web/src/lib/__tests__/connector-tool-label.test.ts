import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_TOOL_NAMESPACE_RE,
  connectorToolLabel,
  parseConnectorToolName,
  toolMatchName,
} from '../connector-tool-label';
import { shapeSteps } from '../workspace-steps';

// The literal @ax/connectors' and the runner's tests pin as a real derived
// namespace (TASK-734). Pinned here too: the shape is re-stated, not imported.
const NS = 'c5e0235982f';
const NAMES = new Map([[NS, 'Linear']]);

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
    const hostile = new Map([[NS, `Evil‮\nname${'x'.repeat(200)}`]]);
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
