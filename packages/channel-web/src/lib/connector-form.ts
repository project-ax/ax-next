/**
 * connector-form — shared connector create/edit form state + capability
 * (de)serialization, extracted from the (now nav-orphaned) ConnectorRegistry so
 * the inline admin curation folded into ConnectorsTab (TASK-127) and the legacy
 * registry component share ONE source of truth for the form logic (invariant
 * #4). No React here — pure form-state derivation, unit-testable on its own.
 *
 * The backing MECHANISM (transport / command / url / args) is still surfaced
 * only behind an Advanced disclosure in the UI; this module just shuttles it
 * between the flat FormState and the opaque ConnectorCapabilities fill, MERGING
 * onto a loaded connector's original capabilities so un-surfaced fields
 * (`packages`, beyond-first mcpServers, env) are never wiped on edit.
 *
 * TASK-128 will reshape this into a mechanism-first form; until then it keeps
 * the existing Advanced-disclosure shape so the fold is behavior-preserving.
 */
import {
  emptyCapabilities,
  type Connector,
  type ConnectorSummary,
  type ConnectorCapabilities,
  type ConnectorKeyMode,
  type ConnectorVisibility,
  type ConnectorMcpServerSpec,
} from './connectors';

export type Transport = 'stdio' | 'http';

export interface ConnectorFormState {
  connectorId: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: ConnectorKeyMode;
  visibility: ConnectorVisibility;
  /**
   * Default-on for every agent (the connector half of the admin Catalog). When
   * true the connector flows into every agent's effective set via
   * `connectors:list-defaults`. Admin-only curation control.
   */
  defaultAttached: boolean;
  // Mechanism (Advanced) — at most one MCP server in this form. Empty command
  // AND empty url ⟹ a non-MCP connector (CLI / direct-API), still valid.
  transport: Transport;
  command: string;
  args: string; // space-separated
  url: string;
  allowedHosts: string; // comma-separated
  credentialSlots: string; // comma-separated slot names
  /**
   * The loaded connector's full capabilities (empty for a new connector). The
   * form only edits allowedHosts / credentials / the single leading mcpServer;
   * `packages` and any beyond-first mcpServer / extra mcpServer fields (env) are
   * NOT surfaced — carried here and MERGED onto on submit, never wiped.
   */
  baseCapabilities: ConnectorCapabilities;
}

export const emptyConnectorForm = (): ConnectorFormState => ({
  connectorId: '',
  name: '',
  description: '',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  allowedHosts: '',
  credentialSlots: '',
  baseCapabilities: emptyCapabilities(),
});

export const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Derive form state from a fetched connector (edit mode). Reads the single
 *  leading mcpServer if present, otherwise leaves mechanism fields empty. */
export function formFromConnector(c: Connector): ConnectorFormState {
  const mcp = c.capabilities.mcpServers[0];
  const credSlots = c.capabilities.credentials.map((s) => s.slot);
  return {
    connectorId: c.id,
    name: c.name,
    description: c.description,
    usageNote: c.usageNote,
    keyMode: c.keyMode,
    visibility: c.visibility,
    defaultAttached: c.defaultAttached,
    transport: mcp?.transport ?? 'stdio',
    command: mcp?.command ?? '',
    args: (mcp?.args ?? []).join(' '),
    url: mcp?.url ?? '',
    allowedHosts: c.capabilities.allowedHosts.join(', '),
    credentialSlots: credSlots.join(', '),
    baseCapabilities: c.capabilities,
  };
}

/**
 * Assemble the opaque capabilities fill. MERGES the form's edited fields
 * (allowedHosts / credentials / the single leading mcpServer) onto the loaded
 * connector's original capabilities so the un-surfaced fill — `packages`, any
 * beyond-first mcpServer, extra mcpServer fields (env) — is PRESERVED, never
 * wiped on edit. For a new connector the base is empty so this is a plain build.
 */
export function capabilitiesFromForm(
  form: ConnectorFormState,
): ConnectorCapabilities {
  const base = form.baseCapabilities;
  const allowedHosts = splitList(form.allowedHosts);
  const credentials = splitList(form.credentialSlots).map((slot) => ({
    slot,
    kind: 'api-key' as const,
  }));
  const hasMcp =
    (form.transport === 'http' && form.url.trim().length > 0) ||
    (form.transport === 'stdio' && form.command.trim().length > 0);
  let mcpServers = base.mcpServers;
  if (hasMcp) {
    const existing = base.mcpServers[0];
    // Preserve any extra mcpServer fields (env, the server's own allowedHosts /
    // credentials) the form doesn't surface; overlay transport/command/args/url.
    const server: ConnectorMcpServerSpec = {
      name: existing?.name ?? form.connectorId ?? form.name.trim().toLowerCase(),
      allowedHosts: existing?.allowedHosts ?? [],
      credentials: existing?.credentials ?? [],
      ...(existing?.env !== undefined ? { env: existing.env } : {}),
      transport: form.transport,
      ...(form.transport === 'stdio'
        ? {
            command: form.command.trim(),
            args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
          }
        : { url: form.url.trim() }),
    };
    // Replace the leading server; keep any beyond-first servers untouched.
    mcpServers = [server, ...base.mcpServers.slice(1)];
  }
  return {
    allowedHosts,
    credentials,
    mcpServers,
    packages: base.packages,
  };
}

/** Map a summary into the subset of form fields it carries (edit fallback). */
export function summaryToForm(c: ConnectorSummary): Partial<ConnectorFormState> {
  return {
    connectorId: c.id,
    name: c.name,
    description: c.description,
    usageNote: c.usageNote,
    keyMode: c.keyMode,
    visibility: c.visibility,
    defaultAttached: c.defaultAttached,
  };
}

/** Slugify a display name into a stable connector id (create path). */
export function connectorIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
