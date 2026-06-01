/**
 * connector-form — shared connector create/edit form state + capability
 * (de)serialization. The single source of truth for the connector form logic
 * (invariant #4), used by `ConnectorEditDialog` (inline admin curation, folded
 * into ConnectorsTab in TASK-127) and — once TASK-129 lands the user-authoring
 * entry points — the user authoring path. No React here: pure form-state
 * derivation, unit-testable on its own.
 *
 * MECHANISM-FIRST (TASK-128). The form leads with a `mechanism` choice —
 * MCP server / Direct API / Command-line tool — that reshapes which slice of the
 * opaque `capabilities` it edits. The "Advanced — how it connects" disclosure is
 * gone. `mechanism` is a FORM-ONLY enum, NEVER a stored connector field: the
 * backing-mechanism vocabulary (transport / command / url / mcp / packages) stays
 * inside the opaque `ConnectorCapabilities` spec (invariant #1). On edit the
 * mechanism is INFERRED from the loaded capabilities (packages → cli; leading
 * mcpServer → mcp; else direct-api).
 *
 *   - MCP server   → builds the leading `mcpServers[0]` (stdio command+args, or
 *                    http url); credential slots are its secrets (env for stdio,
 *                    headers for http — a UI label difference only).
 *   - Direct API   → no mcpServer, no packages; top-level `allowedHosts` +
 *                    credential slots (the proxy-injected key(s)).
 *   - Command-line → `packages.{npm|pypi}` (a single leading package) +
 *                    top-level `allowedHosts` + credential slots (env secrets).
 *                    "Downloadable binary" folds in here — no fourth type.
 *
 * Round-trip discipline: `capabilitiesFromForm` MERGES onto the loaded
 * connector's original capabilities so un-surfaced fill — beyond-first mcpServers
 * / packages, the leading server's inner env/hosts/creds — is PRESERVED on edit,
 * never wiped. Switching mechanism CLEARS the now-irrelevant LEADING fill (the
 * leading mcpServer for non-MCP; the leading package for non-CLI) while leaving
 * beyond-first entries untouched.
 */
import {
  emptyCapabilities,
  type Connector,
  type ConnectorSummary,
  type ConnectorCapabilities,
  type ConnectorKeyMode,
  type ConnectorVisibility,
  type ConnectorMcpServerSpec,
  type ConnectorCredentialSlot,
} from './connectors';

export type Transport = 'stdio' | 'http';

/** Which backing mechanism the form is shaping. FORM-ONLY — never stored. */
export type Mechanism = 'mcp' | 'direct-api' | 'cli';

/** Which public registry a Command-line tool's package comes from. */
export type PackageRegistry = 'npm' | 'pypi';

/**
 * A structured credential-slot row (TASK-128 — replaces the old comma-string).
 * `slot` is the machine name (env var / header name); `description` is the
 * human label ("Personal access token"); `account` optionally shares one stored
 * key across connectors/skills by service (empty ⟹ fall back to the connector
 * id). Maps to one {@link ConnectorCredentialSlot}; an empty `slot` drops the row.
 */
export interface CredentialSlotRow {
  slot: string;
  description: string;
  account: string;
}

export const emptySlotRow = (): CredentialSlotRow => ({
  slot: '',
  description: '',
  account: '',
});

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
  /** The chosen backing mechanism — reshapes which fields the form edits. */
  mechanism: Mechanism;
  // MCP fields (mechanism === 'mcp').
  transport: Transport;
  command: string;
  args: string; // space-separated
  url: string;
  // Command-line fields (mechanism === 'cli'). A single leading package.
  packageRegistry: PackageRegistry;
  packageName: string;
  // Shared across direct-api + cli (and surfaced for mcp too).
  allowedHosts: string; // comma-separated
  /** Structured credential-slot rows (TASK-124 per-slot shape). */
  credentialSlots: CredentialSlotRow[];
  /**
   * The loaded connector's full capabilities (empty for a new connector). The
   * form edits the LEADING slice for the chosen mechanism; beyond-first
   * mcpServers / packages and the leading server's inner env/hosts/creds are
   * carried here and MERGED on submit, never wiped.
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
  mechanism: 'mcp',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  packageRegistry: 'npm',
  packageName: '',
  allowedHosts: '',
  credentialSlots: [],
  baseCapabilities: emptyCapabilities(),
});

export const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Infer the mechanism from a connector's capabilities (edit mode). A connector
 * with a declared package is a Command-line tool; one with a leading MCP server
 * is an MCP connector; everything else (top-level hosts + keys only) is Direct
 * API. Packages win over an mcpServer in the (unexpected) case both are present
 * so the package field stays editable.
 */
function inferMechanism(c: ConnectorCapabilities): Mechanism {
  if (c.packages.npm.length > 0 || c.packages.pypi.length > 0) return 'cli';
  if (c.mcpServers.length > 0) return 'mcp';
  return 'direct-api';
}

/** The leading package as a (registry, name) pair, npm preferred. */
function leadingPackage(c: ConnectorCapabilities): {
  registry: PackageRegistry;
  name: string;
} {
  if (c.packages.npm.length > 0) return { registry: 'npm', name: c.packages.npm[0]! };
  if (c.packages.pypi.length > 0) return { registry: 'pypi', name: c.packages.pypi[0]! };
  return { registry: 'npm', name: '' };
}

/** Map a capability slot into a structured form row (description/account → ''). */
function slotToRow(s: ConnectorCredentialSlot): CredentialSlotRow {
  return {
    slot: s.slot,
    description: s.description ?? '',
    account: s.account ?? '',
  };
}

/** Derive form state from a fetched connector (edit mode). Infers the mechanism
 *  and fills the matching fields; un-surfaced fill rides along in baseCapabilities. */
export function formFromConnector(c: Connector): ConnectorFormState {
  const caps = c.capabilities;
  const mechanism = inferMechanism(caps);
  const mcp = caps.mcpServers[0];
  const pkg = leadingPackage(caps);
  return {
    connectorId: c.id,
    name: c.name,
    description: c.description,
    usageNote: c.usageNote,
    keyMode: c.keyMode,
    visibility: c.visibility,
    defaultAttached: c.defaultAttached,
    mechanism,
    transport: mcp?.transport ?? 'stdio',
    command: mcp?.command ?? '',
    args: (mcp?.args ?? []).join(' '),
    url: mcp?.url ?? '',
    packageRegistry: pkg.registry,
    packageName: pkg.name,
    allowedHosts: caps.allowedHosts.join(', '),
    credentialSlots: caps.credentials.map(slotToRow),
    baseCapabilities: caps,
  };
}

/** Map structured rows → capability slots: drop empty-slot rows; include
 *  description/account only when non-empty (exactOptionalPropertyTypes). */
function rowsToSlots(rows: CredentialSlotRow[]): ConnectorCredentialSlot[] {
  return rows
    .filter((r) => r.slot.trim().length > 0)
    .map((r) => {
      const slot: ConnectorCredentialSlot = { slot: r.slot.trim(), kind: 'api-key' };
      if (r.description.trim().length > 0) slot.description = r.description.trim();
      if (r.account.trim().length > 0) slot.account = r.account.trim();
      return slot;
    });
}

/** Build the leading MCP server, overlaying transport/command/args/url onto any
 *  existing leading server so its un-surfaced inner fields (env, inner hosts /
 *  credentials) survive. */
function buildLeadingMcpServer(
  form: ConnectorFormState,
  existing: ConnectorMcpServerSpec | undefined,
): ConnectorMcpServerSpec {
  return {
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
}

/**
 * Assemble the opaque capabilities fill for the chosen mechanism. MERGES the
 * edited LEADING slice onto the loaded connector's original capabilities so the
 * un-surfaced fill (beyond-first mcpServers / packages) is PRESERVED, never
 * wiped. Switching mechanism clears the now-irrelevant LEADING entry while
 * keeping beyond-first ones. For a new connector the base is empty so this is a
 * plain build.
 */
export function capabilitiesFromForm(
  form: ConnectorFormState,
): ConnectorCapabilities {
  const base = form.baseCapabilities;
  const allowedHosts = splitList(form.allowedHosts);
  const credentials = rowsToSlots(form.credentialSlots);

  // mcpServers — only an MCP connector keeps a LEADING server. Beyond-first
  // servers (index ≥ 1) are always preserved; the leading slot is the edited /
  // cleared one.
  let mcpServers = base.mcpServers.slice(1);
  if (form.mechanism === 'mcp') {
    const hasMcp =
      (form.transport === 'http' && form.url.trim().length > 0) ||
      (form.transport === 'stdio' && form.command.trim().length > 0);
    if (hasMcp) {
      mcpServers = [buildLeadingMcpServer(form, base.mcpServers[0]), ...mcpServers];
    }
  }

  // packages — only a Command-line connector keeps a LEADING package. We treat
  // npm[0]/pypi[0] as the "leading" slot of each registry list; beyond-first
  // entries (index ≥ 1) are un-surfaced fill and always preserved, while the
  // leading slot is the edited / cleared one. This mirrors the mcpServers rule:
  // switching AWAY from cli drops the leading package so a Direct API / MCP
  // connector doesn't silently retain an egress+exec package from a prior cli
  // shape (and the empty Direct-API / MCP package surface the design intends).
  const packages = {
    npm: base.packages.npm.slice(1),
    pypi: base.packages.pypi.slice(1),
  };
  if (form.mechanism === 'cli') {
    const name = form.packageName.trim();
    const reg = form.packageRegistry;
    if (name) packages[reg] = [name, ...packages[reg]];
  }

  return {
    allowedHosts,
    credentials,
    mcpServers,
    packages,
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
