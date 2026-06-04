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
  translateComposeToServices,
  type ComposeDrop,
  type ComposeInvalid,
} from '@ax/skills-parser';
import {
  emptyCapabilities,
  type Connector,
  type ConnectorSummary,
  type ConnectorCapabilities,
  type ConnectorKeyMode,
  type ConnectorVisibility,
  type ConnectorMcpServerSpec,
  type ConnectorCredentialSlot,
  type ServiceDescriptor,
} from './connectors';

export type Transport = 'stdio' | 'http';

/** Which backing mechanism the form is shaping. FORM-ONLY — never stored. */
export type Mechanism = 'mcp' | 'direct-api' | 'cli';

/** Which public registry a Command-line tool's package comes from. */
export type PackageRegistry = 'npm' | 'pypi';

/**
 * A structured credential-slot row (TASK-128 — replaces the old comma-string).
 * `slot` is the machine name (env var / header name); `description` is the human
 * label ("Personal access token"). There is NO share-by-service `account` field:
 * each connector owns its own key, keyed by the connector id. Maps to one
 * {@link ConnectorCredentialSlot}; an empty `slot` drops the row.
 */
export interface CredentialSlotRow {
  slot: string;
  description: string;
}

export const emptySlotRow = (): CredentialSlotRow => ({
  slot: '',
  description: '',
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
   * TASK-154 — declared dev SERVICES (the "service bundle" slice). Independent of
   * the backing-mechanism choice (an MCP / Direct API / CLI connector may ALSO
   * declare services). Edited directly as descriptors (digest-pinned image +
   * ports/env/writablePaths) and carried onto the proposal verbatim. The form
   * either edits them by hand or fills them from a pasted compose file via
   * {@link applyComposeToForm}.
   */
  services: ServiceDescriptor[];
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
  services: [],
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

/** Map a capability slot into a structured form row (description → ''). */
function slotToRow(s: ConnectorCredentialSlot): CredentialSlotRow {
  return {
    slot: s.slot,
    description: s.description ?? '',
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
    // TASK-154 — declared services ride alongside the mechanism slice; read them
    // straight off the loaded capabilities (absent ⟹ no services).
    services: caps.services ?? [],
    baseCapabilities: caps,
  };
}

/** Map structured rows → capability slots: drop empty-slot rows; include
 *  description only when non-empty (exactOptionalPropertyTypes). */
function rowsToSlots(rows: CredentialSlotRow[]): ConnectorCredentialSlot[] {
  return rows
    .filter((r) => r.slot.trim().length > 0)
    .map((r) => {
      const slot: ConnectorCredentialSlot = { slot: r.slot.trim(), kind: 'api-key' };
      if (r.description.trim().length > 0) slot.description = r.description.trim();
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

  // TASK-154 — declared services are independent of the mechanism slice (any
  // connector may also be a service bundle), so they're carried verbatim from the
  // form, NOT derived from baseCapabilities. Omitting the key when empty keeps a
  // non-service connector's proposal byte-identical to before (back-compat: the
  // server defaults `services` to []).
  return {
    allowedHosts,
    credentials,
    mcpServers,
    packages,
    ...(form.services.length > 0 ? { services: form.services } : {}),
  };
}

// ---------------------------------------------------------------------------
// Services (TASK-154) — manual row edits + curated compose paste.
// ---------------------------------------------------------------------------

/** A blank service row for manual entry. `image` un-pinned by default so the
 *  author pastes a real digest-pinned ref; `writablePaths` defaults to []. */
export const emptyServiceRow = (): ServiceDescriptor => ({
  name: '',
  image: '',
  ports: [],
  env: {},
  writablePaths: [],
});

/** A labelled starter service the author can drop into the form with one click. */
export interface StarterServiceExample {
  /** Short pick-list label (e.g. "MongoDB"). */
  label: string;
  /** One line on what it is + why these writable paths (the locked-sidecar hint). */
  description: string;
  /** The ready-to-edit descriptor — digest-pinned image + the proven writablePaths. */
  service: ServiceDescriptor;
}

/**
 * TASK-159 — a SMALL set of PROVEN starter examples, NOT an exhaustive catalog.
 *
 * The `services` capability is image-agnostic: any digest-pinned image + the
 * writable paths it needs + admin approval. We deliberately do NOT ship a curated
 * image registry — that's a version/CVE-churn treadmill, and authors usually bring
 * their own services (the Compose paste above translates an existing
 * docker-compose.yml). These are just a running start.
 *
 * The whole trick (see `packages/sandbox-k8s/SECURITY.md` → "Dev-service sidecars:
 * declare every writable path"): a sidecar inherits the runner pod's locked posture
 * (read-only root filesystem, non-root, all caps dropped), so it must declare a
 * writable path for EVERY directory the image writes — data dir, `/tmp` for unix
 * sockets and lock files, and any cache/install dir the image scribbles into. Miss
 * one and the container dies at startup with an opaque EROFS / permission error.
 *
 * The Mongo and Kafka-native refs + writable paths below were proven on a real kind
 * cluster (the TASK-156 acceptance walk). Kafka has a cautionary twin: the JVM
 * `apache/kafka` image FAILS under the read-only rootfs because it writes a
 * Class-Data-Sharing archive (`.jsa`) into its install dir `/opt/kafka` — so we
 * point at the GraalVM `apache/kafka-native` build, which has no CDS step. When in
 * doubt, a rootless/native build beats a JVM image here.
 *
 * Each example's image is digest-pinned (`…@sha256:<64 hex>`) and each writable
 * path is absolute — the same shape the descriptor schema enforces server-side.
 */
export const STARTER_SERVICE_EXAMPLES: readonly StarterServiceExample[] = [
  {
    label: 'MongoDB',
    description:
      'Document database. Writes its data files to /data/db and uses /tmp for its socket.',
    service: {
      name: 'mongo',
      image:
        'docker.io/library/mongo@sha256:4b5bf3c2bb7516164f6dcb44acce4fdcb428abfe5771a1128304a0f34ab9ff7c',
      ports: [27017],
      env: {},
      writablePaths: ['/data/db', '/tmp'],
    },
  },
  {
    label: 'Kafka (native)',
    description:
      'Event broker, GraalVM-native build (no JVM Class-Data-Sharing write). The JVM apache/kafka image fails on a read-only rootfs — use this one.',
    service: {
      name: 'kafka',
      image:
        'docker.io/apache/kafka-native@sha256:c20b97f0a3990771f52bf7855ccb9ae82ac683a357a101482ba349dfb2ae0cdb',
      ports: [9092],
      env: {},
      writablePaths: [
        '/var/lib/kafka/data',
        '/tmp',
        '/opt/kafka/config',
        '/opt/kafka/logs',
        '/mnt/shared/config',
      ],
    },
  },
];

// Postgres/Redis are obvious next candidates, but a real digest can't be derived
// without pulling the registry, and a made-up sha256 would resolve to nothing — so
// we ship only the two examples we actually proved (Mongo + Kafka-native) rather
// than fabricate pins. Pasting your own docker-compose.yml (with real digests) is
// the supported path for everything else; the approval wall is the curation point.

/** The outcome of pasting a compose file into the form. `ok:false` carries a
 *  human-readable reason the paste was unusable (not YAML / not a mapping / no
 *  services). `ok:true` carries the new form (services REPLACED, not appended, so
 *  a re-paste is idempotent) plus what we removed (`drops`, I10) and flagged
 *  (`invalid`, e.g. un-pinned images, I8) for the author to see. */
export type ApplyComposeResult =
  | { ok: true; form: ConnectorFormState; drops: ComposeDrop[]; invalid: ComposeInvalid[] }
  | { ok: false; error: string };

/**
 * Translate a pasted `docker-compose.yml` and fold the resulting descriptors
 * into the form's `services`. CURATED: the heavy lifting (drop host mounts /
 * privileged / cap_add / network_mode:host / socket mounts, flag un-pinned
 * images, never shell out) lives in the pure `@ax/skills-parser`
 * `translateComposeToServices` — this is just the form-state glue. Services are
 * REPLACED (not appended) so re-pasting a corrected file doesn't duplicate.
 */
export function applyComposeToForm(
  form: ConnectorFormState,
  composeYaml: string,
): ApplyComposeResult {
  const r = translateComposeToServices(composeYaml);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    form: { ...form, services: r.services },
    drops: r.drops,
    invalid: r.invalid,
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
