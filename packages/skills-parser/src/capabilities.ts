export interface CapabilitySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
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

export interface SkillCapabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
  mcpServers: McpServerSpec[];   // always present, defaults to []
}
