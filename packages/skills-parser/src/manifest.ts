import { load as yamlLoad, YAMLException } from 'js-yaml';

export type ManifestCode =
  | 'invalid-yaml'
  | 'invalid-manifest'
  | 'inline-secret-forbidden'
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-version'
  | 'capability-block-forbidden'
  | 'invalid-connector';

export interface ParsedManifest {
  id: string;
  description: string;
  version: number;
  sourceUrl?: string;       // optional metadata pointer for refresh
  /**
   * Soft-dependency reference list: the IDs of the connectors this skill uses
   * (connectors-first-class design). Always present; defaults to `[]` when
   * absent. This is a DECLARED REFERENCE only — the connector definitions
   * (allowedHosts / credentials / mcpServers / packages) live in the
   * @ax/connectors store, NOT here. A skill no longer carries a capability
   * block at all (TASK-100 closed the half-wired window); ALL of a skill's
   * reach flows from the connectors it references, resolved through
   * `connectors:resolve` (the human-approved/curated table — a pending connector
   * grants ZERO reach). Backing-mechanism vocab never appears in this list — it
   * is a flat list of opaque connector-id slugs.
   */
  connectors: string[];
  /**
   * Unknown frontmatter keys — every top-level key the parser does NOT model
   * (i.e. everything except name/description/version/sourceUrl/connectors).
   * Always present; `{}` when there are none (TASK-133).
   *
   * Why: the form-first skill editor round-trips a manifest through this parser
   * (the single authority) and re-serializes it with `buildSkillManifestYaml`.
   * Without capturing the leftover keys, a raw-editor power-user's custom
   * frontmatter (e.g. `license:`, `author:`) would be silently dropped the
   * moment they opened the form. `extra` carries them through unchanged.
   *
   * SECURITY: the forbidden capability keys (`capabilities`, `allowedHosts`,
   * `credentials`, `mcpServers`, `packages`) and any inline-secret key are
   * HARD-REJECTED earlier in this function, so they can NEVER appear in `extra`.
   * `extra` is therefore reach-free + secret-free by construction.
   */
  extra: Record<string, unknown>;
}

// Top-level keys the parser models directly. Anything outside this set is
// collected into `extra` for round-trip preservation.
const MODELED_KEYS = new Set(['name', 'description', 'version', 'sourceUrl', 'connectors']);

export type ParseResult =
  | { ok: true; value: ParsedManifest }
  | { ok: false; code: ManifestCode; message: string };

const SECRET_KEYS = new Set(['apiKey', 'token', 'password', 'secret']);

// Recursively walk the parsed YAML tree looking for secret key names.
// Arrays are traversed element-by-element; plain objects have all their keys checked.
// The recursion does NOT conflate object keys (like "slot") with the secret-key set.
//
// js-yaml's `load()` can produce cyclic object graphs from YAML alias/anchor
// references (e.g. `caps: &a {x: *a}`). We thread a WeakSet of visited
// objects/arrays through the recursion so a cyclic manifest terminates instead
// of overflowing the call stack. Non-cyclic input is unaffected.
function findSecretKey(node: unknown, visited: WeakSet<object> = new WeakSet()): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (visited.has(node)) return undefined;
  visited.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findSecretKey(item, visited);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEYS.has(key)) return key;
    const found = findSecretKey(obj[key], visited);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Hostname regex: labels of 1-63 chars (lowercase alphanum + hyphen), at least two labels.
// Matches e.g. "api.github.com" but not bare "localhost". Used by `sourceUrl`
// host validation (the only host the manifest still validates — connectors own
// allowedHosts now).
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Skill name: starts with a-z, followed by up to 63 more chars of a-z0-9 or hyphen.
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Connector id reference (connectors-first-class design). A flat list of opaque
// connector-id slugs a skill declares as soft dependencies. The grammar +
// length bound MIRROR the @ax/connectors store's own connectorId rules
// (`/^[a-z0-9][a-z0-9_-]*$/`, ≤ 128 chars) — re-declared here, NOT imported,
// per invariant I2 (no runtime cross-plugin import; this is a pure parser
// package). The count cap is defense-in-depth against an over-large reference
// list in untrusted self-authored frontmatter.
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CONNECTOR_ID_LEN_MAX = 128;
const CONNECTORS_MAX = 64;

// Capability keys that USED to live under the (now-removed) `capabilities:`
// mapping. After TASK-100 a skill manifest carries NO capability block: reach
// lives only on the connectors a skill references. These keys are REJECTED
// (hard fail) wherever they appear — both at the top level and nested under a
// stray `capabilities:` mapping — so an author who still writes them gets a
// structural error instead of silently-stranded reach (invariant #4, one source
// of truth; the human scope decision was REJECT, not ignore-with-warning).
const FORBIDDEN_CAP_KEYS = ['allowedHosts', 'credentials', 'mcpServers', 'packages'];

function err(code: ManifestCode, message: string): ParseResult {
  return { ok: false, code, message };
}

type ConnectorsResult =
  | { ok: true; value: string[] }
  | { ok: false; code: 'invalid-connector'; message: string };

// Parse the top-level `connectors:` reference list. Absent → `[]` (additive
// default; pre-connector skills load unchanged). Present → must be an array of
// connector-id slugs, each matching CONNECTOR_ID_RE and ≤ CONNECTOR_ID_LEN_MAX,
// at most CONNECTORS_MAX entries. The list is preserved as declared (a reference
// list, deliberately not deduped/sorted) so the author's intent round-trips.
function parseConnectors(raw: unknown): ConnectorsResult {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid-connector', message: '"connectors" must be an array of connector ids.' };
  }
  if (raw.length > CONNECTORS_MAX) {
    return { ok: false, code: 'invalid-connector', message: `"connectors" may list at most ${CONNECTORS_MAX} ids, got ${raw.length}.` };
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > CONNECTOR_ID_LEN_MAX) {
      return { ok: false, code: 'invalid-connector', message: `Each "connectors" entry must be a 1-${CONNECTOR_ID_LEN_MAX} char connector id string, got: ${JSON.stringify(entry)}` };
    }
    if (!CONNECTOR_ID_RE.test(entry)) {
      return { ok: false, code: 'invalid-connector', message: `"connectors" entry must match ${CONNECTOR_ID_RE.source} (lowercase slug), got: ${JSON.stringify(entry)}` };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

export function parseSkillManifest(yaml: string): ParseResult {
  // Step 1: parse YAML
  let parsed: unknown;
  try {
    parsed = yamlLoad(yaml);
  } catch (e) {
    if (e instanceof YAMLException) {
      return err('invalid-yaml', e.message);
    }
    return err('invalid-yaml', String(e));
  }

  // Step 2: must be a plain object
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('invalid-manifest', 'Manifest must be a YAML mapping object.');
  }

  const doc = parsed as Record<string, unknown>;

  // Step 2.5 (TASK-100, SECURITY): a skill manifest carries NO capability block.
  // Reach lives only on the connectors a skill references (resolved through the
  // human-approved/curated connectors table). REJECT any leftover `capabilities:`
  // mapping AND any of the capability keys at the top level — fail loud, never
  // silently drop. The human scope decision was REJECT (not ignore-with-warning):
  // a silently-stranded skill is the exact capability-loss bypass TASK-79
  // hardened against; here we go further and forbid the block entirely now that
  // connectors are the one source of truth (invariant #4).
  if ('capabilities' in doc) {
    return err(
      'capability-block-forbidden',
      'A skill manifest must not declare a "capabilities" block — capabilities live on connectors now. Reference the connector(s) this skill uses via the top-level "connectors:" list instead.',
    );
  }
  for (const k of FORBIDDEN_CAP_KEYS) {
    if (k in doc) {
      return err(
        'capability-block-forbidden',
        `"${k}" is no longer a valid skill manifest field — capabilities live on connectors now. Reference the connector(s) this skill uses via the top-level "connectors:" list instead.`,
      );
    }
  }

  // Step 3: inline-secret scan at all depths
  const secretKey = findSecretKey(doc);
  if (secretKey !== undefined) {
    return err('inline-secret-forbidden', `Field "${secretKey}" must not appear in a SKILL.md manifest. Credentials belong on a connector, never in a skill.`);
  }

  // Step 4: name
  const rawName = doc['name'];
  if (typeof rawName !== 'string' || !NAME_RE.test(rawName)) {
    return err('invalid-name', `"name" must match /^[a-z][a-z0-9-]{0,63}$/, got: ${JSON.stringify(rawName)}`);
  }
  const name = rawName;

  // Step 5: description
  const rawDesc = doc['description'];
  if (typeof rawDesc !== 'string' || rawDesc.length === 0) {
    return err('invalid-description', '"description" must be a non-empty string.');
  }
  if (rawDesc.length > 240) {
    return err('invalid-description', `"description" must be ≤ 240 characters, got ${rawDesc.length}.`);
  }
  const description = rawDesc;

  // Step 6: version (optional, defaults to 0)
  let version = 0;
  if ('version' in doc) {
    const rawVersion = doc['version'];
    if (
      typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 0
    ) {
      return err('invalid-version', `"version" must be a non-negative integer, got: ${JSON.stringify(rawVersion)}`);
    }
    version = rawVersion;
  }

  // Step 6.5: sourceUrl (optional, top-level — NOT a capability, it's
  // an admin-visible pointer to where this skill came from so the
  // refresh hook can fetch the latest manifest).
  let sourceUrl: string | undefined;
  if ('sourceUrl' in doc) {
    const raw = doc['sourceUrl'];
    if (typeof raw !== 'string') {
      return err('invalid-manifest', '"sourceUrl" must be a string.');
    }
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return err('invalid-manifest', '"sourceUrl" must be a valid URL.');
    }
    if (u.protocol !== 'https:') {
      return err('invalid-manifest', '"sourceUrl" must use https://.');
    }
    if (IPV4_RE.test(u.hostname)) {
      return err('invalid-manifest', '"sourceUrl" host must not be an IPv4 literal.');
    }
    if (!HOSTNAME_RE.test(u.hostname)) {
      return err('invalid-manifest', '"sourceUrl" host is not a valid hostname.');
    }
    sourceUrl = raw;
  }

  // Step 7: top-level `connectors` reference list (connectors-first-class
  // design). Additive + storage-agnostic: a soft-dependency list of opaque
  // connector-id slugs, parsed from the manifest YAML (the source of truth).
  // Defaults to [] when absent so a pre-connector skill loads unchanged. This is
  // the ONLY way a skill declares reach now — the connectors it names are
  // resolved into sandbox caps by the orchestrator (the skill→connector bridge,
  // TASK-111) and the human-approved/curated table is the source of truth.
  const connectorsResult = parseConnectors(doc['connectors']);
  if (!connectorsResult.ok) return err(connectorsResult.code, connectorsResult.message);
  const connectors = connectorsResult.value;

  // Step 8 (TASK-133): collect every UNMODELED top-level key into `extra` so the
  // form-first editor's parse→build round-trip preserves custom frontmatter the
  // parser doesn't surface as a typed field. The forbidden capability keys and
  // inline-secret keys were already hard-rejected above, so `extra` is reach-free
  // and secret-free by construction.
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) {
    if (!MODELED_KEYS.has(k)) extra[k] = doc[k];
  }

  return {
    ok: true,
    value: {
      id: name,
      description,
      version,
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      connectors,
      extra,
    },
  };
}
