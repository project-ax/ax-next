import { z } from 'zod';
import { ServicesArraySchema, type ServiceDescriptor } from './service-descriptor.js';

export type { ServiceDescriptor, Healthcheck } from './service-descriptor.js';
export {
  ServiceDescriptorSchema,
  ServicesArraySchema,
  HealthcheckSchema,
  SERVICES_MAX,
} from './service-descriptor.js';

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
  /**
   * Dev SERVICES this unit of work wants alongside its sandbox (a database, a
   * cache, …). TASK-150 — capabilities live on CONNECTORS now (TASK-100); the
   * connector store round-trips this through {@link CapabilitiesSchema}. The
   * orchestrator folds it onto the `sandbox:open-session` payload, where
   * @ax/sandbox-protocol re-validates the same shape at the wire.
   *
   * OPTIONAL on the interface (back-compat: existing `Capabilities` literals
   * across the tree don't all set it). `CapabilitiesSchema` `.default([])`s it,
   * so a PARSED capabilities object always carries `services` as an array.
   */
  services?: ServiceDescriptor[];
}

/**
 * Back-compat alias for {@link Capabilities}. Skills (and everything already
 * importing this name) keep working unchanged. New code referencing the
 * shared shape should prefer the neutral `Capabilities`.
 */
export type SkillCapabilities = Capabilities;

// ---------------------------------------------------------------------------
// Runtime Zod validator for the neutral {@link Capabilities} shape (TASK-150).
//
// Until now @ax/skills-parser carried only the TS interface — @ax/connectors
// re-declared its OWN zod locally (type-only import). With `services` joining
// the shape, this package becomes the CANONICAL home of both the interface AND
// a zod validator, so the descriptor grammar is authored once. @ax/connectors
// keeps its local re-declaration (its deliberate type-only stance) and
// @ax/sandbox-protocol re-validates at the wire — same defense-in-depth as the
// existing McpServerSpec/McpServerSchema split.
//
// Cast to `z.ZodType<Capabilities>`: zod's `.optional()`/`.default()` infer
// `field?: T | undefined`, which `exactOptionalPropertyTypes: true` won't prove
// directly assignable to the interface. The structure matches; the
// capabilities-type test is the drift guard.
// ---------------------------------------------------------------------------
const CapabilitySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  account: z.string().optional(),
});

const McpServerSpecSchema = z.object({
  name: z.string(),
  transport: z.union([z.literal('stdio'), z.literal('http')]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
});

const PackagesSpecSchema = z.object({
  npm: z.array(z.string()),
  pypi: z.array(z.string()),
});

export const CapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
  mcpServers: z.array(McpServerSpecSchema),
  packages: PackagesSpecSchema,
  services: ServicesArraySchema,
}) as unknown as z.ZodType<Capabilities>;
