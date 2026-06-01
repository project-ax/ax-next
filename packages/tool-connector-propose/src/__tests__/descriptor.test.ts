import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_PROPOSE_DESCRIPTOR,
  CONNECTOR_PROPOSE_TOOL_NAME,
} from '../descriptor.js';

describe('CONNECTOR_PROPOSE_DESCRIPTOR', () => {
  it('is a host-executed tool named connector_propose', () => {
    expect(CONNECTOR_PROPOSE_TOOL_NAME).toBe('connector_propose');
    expect(CONNECTOR_PROPOSE_DESCRIPTOR.name).toBe('connector_propose');
    // Host-executed (pure-JSON args; no /ephemeral draft dir to read) — mirrors
    // request_capability, NOT the sandbox skill_propose path.
    expect(CONNECTOR_PROPOSE_DESCRIPTOR.executesIn).toBe('host');
  });

  it('declares the connector-draft input shape (connectorId/name/keyMode required)', () => {
    const schema = CONNECTOR_PROPOSE_DESCRIPTOR.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    for (const k of [
      'connectorId',
      'name',
      'hosts',
      'slots',
      'packages',
      'mcpServers',
      'usageNote',
      'keyMode',
    ]) {
      expect(schema.properties[k]).toBeDefined();
    }
    expect(schema.required).toEqual(
      expect.arrayContaining(['connectorId', 'name', 'keyMode']),
    );
  });

  it('description carries the keyMode meaning and next-turn-availability guidance', () => {
    const d = CONNECTOR_PROPOSE_DESCRIPTOR.description ?? '';
    expect(d).toMatch(/personal/i);
    expect(d).toMatch(/workspace/i);
    // The spawn-time-discovery constraint (a proposed connector is usable next
    // turn, not this one) — same posture as skill_propose.
    expect(d).toMatch(/next/i);
  });
});
