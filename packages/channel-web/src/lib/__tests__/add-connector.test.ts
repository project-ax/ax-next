/**
 * TASK-827 — the Add subview's data rules for shared-key connectors.
 */
import { describe, expect, it } from 'vitest';
import { addActionFor, agentKeyEntries, availableConnectors } from '../add-connector';
import { emptyCapabilities, type Connector, type ConnectorSummary } from '../connectors';

function summary(
  id: string,
  keyMode: 'personal' | 'workspace',
  visibility: 'private' | 'shared' = 'shared',
): ConnectorSummary {
  return {
    id,
    name: id,
    description: '',
    usageNote: '',
    keyMode,
    visibility,
    createdAt: '',
    updatedAt: '',
  };
}

function withKey(id: string, keyMode: 'personal' | 'workspace'): Connector {
  const caps = emptyCapabilities();
  caps.credentials = [{ slot: 'token', kind: 'api-key' }];
  return { ...summary(id, keyMode), capabilities: caps };
}

describe('availableConnectors', () => {
  it('lists shared-key connectors (for everyone) minus what the agent already has', () => {
    const list = availableConnectors(
      [summary('b', 'workspace'), summary('a', 'personal'), summary('c', 'personal')],
      new Set(['c']),
    );
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
  });

  // SIGNINS-7 — an agent can hold a sign-in or key only for a SHARED
  // connector, so a private one can't be added any more. It is left out,
  // never quietly made shared.
  it('leaves out private connectors', () => {
    const list = availableConnectors(
      [summary('p', 'personal', 'private'), summary('w', 'workspace', 'private'), summary('s', 'personal')],
      new Set(),
    );
    expect(list.map((c) => c.id)).toEqual(['s']);
  });
});

// Slice 3 — what Add does is decided by the connector's KIND alone. Nobody's
// saved keys or sign-ins are read: every Add signs in (OAuth) or takes the
// agent's own keys (per-agent key), all or nothing.
describe('addActionFor — by connector kind', () => {
  function withOAuth(id: string): Connector {
    const caps = emptyCapabilities();
    caps.credentials = [{ slot: 'notion', kind: 'oauth', server: 'notion' }];
    return { ...summary(id, 'personal'), capabilities: caps };
  }

  it('an OAuth connector signs in — even one that also declares a header key', () => {
    expect(addActionFor(withOAuth('notion'))).toBe('sign-in');
    const both = withOAuth('both');
    both.capabilities.credentials.push({ slot: 'TOKEN', kind: 'api-key' });
    expect(addActionFor(both)).toBe('sign-in');
  });

  it('a per-agent key connector asks for its key', () => {
    expect(addActionFor(withKey('zen', 'personal'))).toBe('key');
  });

  it('a shared-key connector adds straight away (the server checks the key is there)', () => {
    expect(addActionFor(withKey('crm', 'workspace'))).toBe('add');
  });

  it('a connector with nothing to set up adds straight away', () => {
    expect(addActionFor({ ...summary('open', 'personal'), capabilities: emptyCapabilities() })).toBe('add');
  });
});

describe('agentKeyEntries', () => {
  it("lists the api-key slots, never the connector's own OAuth client secret", () => {
    const c = withKey('multi', 'personal');
    c.capabilities.credentials.push({ slot: 'SECOND', kind: 'api-key' });
    c.capabilities.credentials.push({ slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' });
    expect(agentKeyEntries(c).map((e) => e.slot)).toEqual(['token', 'SECOND']);
  });
});
