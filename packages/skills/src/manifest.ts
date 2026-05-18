import { load as yamlLoad, YAMLException } from 'js-yaml';
import type { CapabilitySlot, SkillCapabilities } from './types.js';

export type ManifestCode =
  | 'invalid-yaml'
  | 'invalid-manifest'
  | 'inline-secret-forbidden'
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-version'
  | 'capability-deferred'
  | 'invalid-host'
  | 'invalid-slot'
  | 'duplicate-slot'
  | 'invalid-kind';

export interface ParsedManifest {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
}

export type ParseResult =
  | { ok: true; value: ParsedManifest }
  | { ok: false; code: ManifestCode; message: string };

const SECRET_KEYS = new Set(['apiKey', 'token', 'password', 'secret']);

// Recursively walk the parsed YAML tree looking for secret key names.
// Arrays are traversed element-by-element; plain objects have all their keys checked.
// The recursion does NOT conflate object keys (like "slot") with the secret-key set.
function findSecretKey(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findSecretKey(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEYS.has(key)) return key;
    const found = findSecretKey(obj[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Hostname regex: labels of 1-63 chars (lowercase alphanum + hyphen), at least two labels.
// Matches e.g. "api.github.com" but not bare "localhost".
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Skill name: starts with a-z, followed by up to 63 more chars of a-z0-9 or hyphen.
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Credential slot: SCREAMING_SNAKE_CASE, starts with A-Z.
const SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function err(code: ManifestCode, message: string): ParseResult {
  return { ok: false, code, message };
}

// Matches wildcard host patterns like *.example.com that appear inside
// allowedHosts flow sequences or block lists, before YAML parsing.
// YAML treats bare `*` as an alias sigil, so the parser would throw
// YAMLException instead of reaching the host validator — we catch the
// pattern pre-parse to return the correct code.
const WILDCARD_HOST_IN_YAML_RE = /allowedHosts[^\n]*\*[a-zA-Z0-9.]/;

export function parseSkillManifest(yaml: string): ParseResult {
  // Pre-check: wildcard host patterns cause YAMLException (alias sigil).
  // Detect them before parsing so we can return 'invalid-host' not 'invalid-yaml'.
  if (WILDCARD_HOST_IN_YAML_RE.test(yaml)) {
    return err('invalid-host', 'Wildcard hosts are not allowed in allowedHosts.');
  }

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

  // Step 3: inline-secret scan at all depths
  const secretKey = findSecretKey(doc);
  if (secretKey !== undefined) {
    return err('inline-secret-forbidden', `Field "${secretKey}" must not appear in a SKILL.md manifest. Credentials belong in capabilities.credentials slots.`);
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

  // Step 7 & 8 & 9: capabilities
  let allowedHosts: string[] = [];
  let credentials: CapabilitySlot[] = [];

  if ('capabilities' in doc) {
    const rawCaps = doc['capabilities'];
    if (rawCaps === null || typeof rawCaps !== 'object' || Array.isArray(rawCaps)) {
      return err('invalid-manifest', '"capabilities" must be a mapping object.');
    }
    const caps = rawCaps as Record<string, unknown>;

    // Step 7: reserved mcpServers key
    if ('mcpServers' in caps) {
      return err('capability-deferred', '"capabilities.mcpServers" is reserved for a future phase and may not be used.');
    }

    // Step 8: allowedHosts
    if ('allowedHosts' in caps) {
      const rawHosts = caps['allowedHosts'];
      if (!Array.isArray(rawHosts)) {
        return err('invalid-host', '"capabilities.allowedHosts" must be an array.');
      }
      for (const h of rawHosts) {
        if (typeof h !== 'string') {
          return err('invalid-host', `Each allowedHost must be a string, got: ${JSON.stringify(h)}`);
        }
        // Reject wildcards
        if (h.includes('*')) {
          return err('invalid-host', `Wildcard hosts are not allowed: "${h}"`);
        }
        // Reject if it contains a scheme (://)
        if (h.includes('://')) {
          return err('invalid-host', `Hosts must not include a scheme: "${h}"`);
        }
        // Reject if it contains a path (/)
        if (h.includes('/')) {
          return err('invalid-host', `Hosts must not include a path: "${h}"`);
        }
        // Reject IPv4 literals
        if (IPV4_RE.test(h)) {
          return err('invalid-host', `IP address literals are not allowed: "${h}"`);
        }
        // Must match hostname pattern
        if (!HOSTNAME_RE.test(h)) {
          return err('invalid-host', `"${h}" is not a valid hostname.`);
        }
      }
      // Deduplicate
      allowedHosts = [...new Set(rawHosts as string[])];
    }

    // Step 9: credentials
    if ('credentials' in caps) {
      const rawCreds = caps['credentials'];
      if (!Array.isArray(rawCreds)) {
        return err('invalid-slot', '"capabilities.credentials" must be an array.');
      }
      const seenSlots = new Set<string>();
      for (const rawCred of rawCreds) {
        if (rawCred === null || typeof rawCred !== 'object' || Array.isArray(rawCred)) {
          return err('invalid-slot', 'Each credential entry must be a mapping object.');
        }
        const cred = rawCred as Record<string, unknown>;

        // slot
        const rawSlot = cred['slot'];
        if (typeof rawSlot !== 'string' || !SLOT_RE.test(rawSlot)) {
          return err('invalid-slot', `"slot" must match /^[A-Z][A-Z0-9_]{0,63}$/, got: ${JSON.stringify(rawSlot)}`);
        }

        // duplicate slot
        if (seenSlots.has(rawSlot)) {
          return err('duplicate-slot', `Duplicate slot name "${rawSlot}" in credentials.`);
        }
        seenSlots.add(rawSlot);

        // kind
        const rawKind = cred['kind'];
        if (rawKind !== 'api-key') {
          return err('invalid-kind', `"kind" must be "api-key", got: ${JSON.stringify(rawKind)}`);
        }

        // description (optional)
        const slot: CapabilitySlot = {
          slot: rawSlot,
          kind: 'api-key',
          ...(typeof cred['description'] === 'string' ? { description: cred['description'] } : {}),
        };
        credentials.push(slot);
      }
    }
  }

  return {
    ok: true,
    value: {
      id: name,
      description,
      version,
      capabilities: { allowedHosts, credentials },
    },
  };
}
