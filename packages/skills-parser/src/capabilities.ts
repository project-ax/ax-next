export interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  /**
   * Optional service identifier (JIT P2/P7.2, decision #13). When set, the
   * slot binds to the user's SHARED service-keyed vault entry (`account:<service>`)
   * instead of a per-skill ref. Lowercase slug; absent = today's per-skill behavior.
   */
  account?: string;
}

export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedHosts: string[];     // unioned with the url host on parse
  credentials: CapabilitySlot[];
}

export interface PackagesSpec {
  npm: string[];
  pypi: string[];
}

export interface SkillCapabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
  mcpServers: McpServerSpec[];   // always present, defaults to []
  packages: PackagesSpec;        // always present; empty arrays when none declared
}
