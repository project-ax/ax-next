/**
 * TASK-827 — the Add subview's data rules for shared-key connectors.
 */
import { describe, expect, it } from 'vitest';
import { addActionFor, availableConnectors } from '../add-connector';
import { emptyCapabilities, type Connector, type ConnectorSummary } from '../connectors';
import type { CredentialMeta } from '../credentials';

function summary(id: string, keyMode: 'personal' | 'workspace'): ConnectorSummary {
  return {
    id,
    name: id,
    description: '',
    usageNote: '',
    keyMode,
    visibility: 'shared',
    createdAt: '',
    updatedAt: '',
  };
}

function withKey(id: string, keyMode: 'personal' | 'workspace'): Connector {
  const caps = emptyCapabilities();
  caps.credentials = [{ slot: 'token', kind: 'api-key' }];
  return { ...summary(id, keyMode), capabilities: caps };
}

const sharedKey: CredentialMeta = {
  scope: 'global',
  ownerId: null,
  ref: 'account:crm',
  kind: 'api-key',
  createdAt: '',
};

describe('availableConnectors', () => {
  it('lists shared-key connectors (for everyone) minus what the agent already has', () => {
    const list = availableConnectors(
      [summary('b', 'workspace'), summary('a', 'personal'), summary('c', 'personal')],
      new Set(['c']),
    );
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('addActionFor — shared keys', () => {
  it('null workspace keys (a non-admin) counts the shared key as present: "Add"', async () => {
    expect(
      await addActionFor(withKey('crm', 'workspace'), { agentId: 'a', userCreds: [], globalCreds: null }),
    ).toBe('add');
  });

  it('an admin with the shared key missing gets "Add key"; with it present, "Add"', async () => {
    const c = withKey('crm', 'workspace');
    expect(await addActionFor(c, { agentId: 'a', userCreds: [], globalCreds: [] })).toBe('key');
    expect(await addActionFor(c, { agentId: 'a', userCreds: [], globalCreds: [sharedKey] })).toBe('add');
  });

  it('a per-person key is still asked for when globalCreds is null', async () => {
    expect(
      await addActionFor(withKey('zen', 'personal'), { agentId: 'a', userCreds: [], globalCreds: null }),
    ).toBe('key');
  });
});
