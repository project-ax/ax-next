import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials';

export type Destination =
  | { kind: 'provider'; provider: string }
  | { kind: 'skill-slot'; skillId: string; slot: string }
  | { kind: 'mcp-env'; serverId: string; envName: string }
  | { kind: 'mcp-header'; serverId: string; headerName: string }
  | { kind: 'routine-hmac'; agentId: string; routinePath: string };

function assertNoColon(field: string, value: string): void {
  if (value.includes(':')) {
    throw new PluginError({
      code: 'invalid-destination-identifier',
      plugin: PLUGIN_NAME,
      message: `${field} must not contain ':' (reserved as ref separator)`,
    });
  }
}

export function refForDestination(dest: Destination): string {
  switch (dest.kind) {
    case 'provider':
      assertNoColon('provider', dest.provider);
      return `provider:${dest.provider}`;
    case 'skill-slot':
      assertNoColon('skillId', dest.skillId);
      assertNoColon('slot', dest.slot);
      return `skill:${dest.skillId}:${dest.slot}`;
    case 'mcp-env':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('envName', dest.envName);
      return `mcp:${dest.serverId}:env:${dest.envName}`;
    case 'mcp-header':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('headerName', dest.headerName);
      return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':
      assertNoColon('agentId', dest.agentId);
      assertNoColon('routinePath', dest.routinePath);
      return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
  }
}
