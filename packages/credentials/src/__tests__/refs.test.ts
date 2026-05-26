import { describe, expect, it } from 'vitest';
import { refForDestination, type Destination } from '../refs.js';
import { KNOWN_DESTINATION_FIXTURES } from '../refs-fixtures.js';
import { PluginError } from '@ax/core';

describe('refForDestination', () => {
  it('computes provider ref', () => {
    expect(refForDestination({ kind: 'provider', provider: 'anthropic' }))
      .toBe('provider:anthropic');
  });
  it('computes skill-slot ref', () => {
    expect(refForDestination({
      kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN',
    })).toBe('skill:linear-tracker:LINEAR_TOKEN');
  });
  it('computes mcp-env ref', () => {
    expect(refForDestination({
      kind: 'mcp-env', serverId: 'gh', envName: 'GH_TOKEN',
    })).toBe('mcp:gh:env:GH_TOKEN');
  });
  it('computes mcp-header ref', () => {
    expect(refForDestination({
      kind: 'mcp-header', serverId: 'gh', headerName: 'Authorization',
    })).toBe('mcp:gh:header:Authorization');
  });
  it('computes routine-hmac ref', () => {
    expect(refForDestination({
      kind: 'routine-hmac', agentId: 'agt-1', routinePath: '.ax/routines/cron.md',
    })).toBe('routine:agt-1:.ax/routines/cron.md:hmac');
  });

  it('canonical refs match KNOWN_DESTINATION_FIXTURES (drift guard)', () => {
    for (const { destination, expectedRef } of KNOWN_DESTINATION_FIXTURES) {
      expect(refForDestination(destination)).toBe(expectedRef);
    }
  });

  it('rejects identifiers containing the reserved char ":"', () => {
    const tries: Destination[] = [
      { kind: 'provider', provider: 'an:thropic' as 'anthropic' },
      { kind: 'skill-slot', skillId: 'a:b', slot: 'SLOT' },
      { kind: 'skill-slot', skillId: 'ok', slot: 'A:B' },
      { kind: 'mcp-env', serverId: 'srv:1', envName: 'X' },
      { kind: 'mcp-env', serverId: 'ok', envName: 'X:Y' },
      { kind: 'mcp-header', serverId: 'srv:1', headerName: 'X' },
      { kind: 'mcp-header', serverId: 'ok', headerName: 'X:Y' },
      { kind: 'routine-hmac', agentId: 'a:b', routinePath: '.ax/r.md' },
      { kind: 'routine-hmac', agentId: 'ok', routinePath: 'has:colon' },
    ];
    for (const d of tries) {
      expect(() => refForDestination(d)).toThrow(PluginError);
    }
  });

  // JIT P2 — service-keyed user vault.
  it('mints account:<service> for an account destination', () => {
    expect(refForDestination({ kind: 'account', service: 'linear' })).toBe('account:linear');
  });

  it('rejects an account service containing the ref separator', () => {
    expect(() => refForDestination({ kind: 'account', service: 'lin:ear' })).toThrow(
      /must not contain/,
    );
  });
});
