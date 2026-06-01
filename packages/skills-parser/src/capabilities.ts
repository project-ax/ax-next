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

/**
 * The neutral capability shape: what a unit of work is allowed to reach
 * (`allowedHosts` / `credentials` / `mcpServers` / `packages`). Named without
 * a `Skill` prefix on purpose — the CONNECTOR is the consumer now. A skill
 * manifest no longer carries this shape at all (TASK-100 closed the half-wired
 * window; a skill only NAMES the connectors it uses). @ax/connectors references
 * the SAME shape, and per CLAUDE.md invariant #2 it must do so without a
 * cross-plugin import; this type IS that shared contract, living in
 * `@ax/skills-parser` (a pure, dependency-free parser package both sides import).
 */
export interface Capabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
  mcpServers: McpServerSpec[];   // always present, defaults to []
  packages: PackagesSpec;        // always present; empty arrays when none declared
}

/**
 * Back-compat alias for {@link Capabilities}. Skills (and everything already
 * importing this name) keep working unchanged. New code referencing the
 * shared shape should prefer the neutral `Capabilities`.
 */
export type SkillCapabilities = Capabilities;
