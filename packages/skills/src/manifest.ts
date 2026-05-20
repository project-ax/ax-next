import { load as yamlLoad, YAMLException } from 'js-yaml';
import type { CapabilitySlot, McpServerSpec, SkillCapabilities } from './types.js';

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
  | 'invalid-kind'
  | 'invalid-mcp-command'
  | 'invalid-mcp-transport';

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

// MCP stdio commands the parser will accept. Anything else is rejected with
// `invalid-mcp-command` at parse time so the sandbox never sees a manifest
// that asks it to spawn `/bin/sh`, `curl`, `bash -c …`, etc. See
// docs/plans/2026-05-20-skills-mcp-bundling-security-note.md §1.
const MCP_COMMAND_ALLOW = new Set(['npx', 'node', 'bun', 'uvx', 'python', 'python3']);

// Max servers per skill — defense-in-depth bound also enforced by the
// sandbox zod schema (see security note §1 "Array length DoS bound").
const MCP_SERVERS_MAX = 8;
const MCP_ARGS_MAX = 32;
const MCP_ARG_LEN_MAX = 256;

type HostValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'invalid-host'; message: string };

// Shared host-string validator (no scheme, no path, no wildcard, no IPv4,
// must match HOSTNAME_RE). Used by both top-level `allowedHosts` and the
// per-mcpServer `allowedHosts` list.
function validateHost(h: unknown): HostValidation {
  if (typeof h !== 'string') {
    return { ok: false, code: 'invalid-host', message: `Each allowedHost must be a string, got: ${JSON.stringify(h)}` };
  }
  if (h.includes('*')) {
    return { ok: false, code: 'invalid-host', message: `Wildcard hosts are not allowed: "${h}"` };
  }
  if (h.includes('://')) {
    return { ok: false, code: 'invalid-host', message: `Hosts must not include a scheme: "${h}"` };
  }
  if (h.includes('/')) {
    return { ok: false, code: 'invalid-host', message: `Hosts must not include a path: "${h}"` };
  }
  if (IPV4_RE.test(h)) {
    return { ok: false, code: 'invalid-host', message: `IP address literals are not allowed: "${h}"` };
  }
  if (!HOSTNAME_RE.test(h)) {
    return { ok: false, code: 'invalid-host', message: `"${h}" is not a valid hostname.` };
  }
  return { ok: true, value: h };
}

type CredentialListResult =
  | { ok: true; value: CapabilitySlot[] }
  | { ok: false; code: ManifestCode; message: string };

// Shared credentials-list parser. Same shape rules as top-level
// `capabilities.credentials`: each entry must have a SCREAMING_SNAKE slot
// matching SLOT_RE, kind: 'api-key', optional string description; duplicate
// slot names within a single list are rejected with `duplicate-slot`.
function parseCredentialList(raw: unknown): CredentialListResult {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid-slot', message: '"credentials" must be an array.' };
  }
  const out: CapabilitySlot[] = [];
  const seen = new Set<string>();
  for (const rawCred of raw) {
    if (rawCred === null || typeof rawCred !== 'object' || Array.isArray(rawCred)) {
      return { ok: false, code: 'invalid-slot', message: 'Each credential entry must be a mapping object.' };
    }
    const cred = rawCred as Record<string, unknown>;

    const rawSlot = cred['slot'];
    if (typeof rawSlot !== 'string' || !SLOT_RE.test(rawSlot)) {
      return { ok: false, code: 'invalid-slot', message: `"slot" must match /^[A-Z][A-Z0-9_]{0,63}$/, got: ${JSON.stringify(rawSlot)}` };
    }
    if (seen.has(rawSlot)) {
      return { ok: false, code: 'duplicate-slot', message: `Duplicate slot name "${rawSlot}" in credentials.` };
    }
    seen.add(rawSlot);

    const rawKind = cred['kind'];
    if (rawKind !== 'api-key') {
      return { ok: false, code: 'invalid-kind', message: `"kind" must be "api-key", got: ${JSON.stringify(rawKind)}` };
    }

    const rawDescription = cred['description'];
    if (rawDescription !== undefined && typeof rawDescription !== 'string') {
      return {
        ok: false,
        code: 'invalid-slot',
        message: `"description" on slot "${rawSlot}" must be a string when provided, got: ${JSON.stringify(rawDescription)}`,
      };
    }
    out.push({
      slot: rawSlot,
      kind: 'api-key',
      ...(rawDescription !== undefined ? { description: rawDescription } : {}),
    });
  }
  return { ok: true, value: out };
}

type McpServersResult =
  | { ok: true; value: McpServerSpec[] }
  | { ok: false; code: ManifestCode; message: string };

// Parses `capabilities.mcpServers`. Per-server `allowedHosts` and the http
// transport's URL host are folded into `allowedHostsAcc` so the final union
// at the top of parseSkillManifest picks them up (the credential-proxy gates
// egress on the unioned skill-level list — see security note §1).
function parseMcpServers(raw: unknown, allowedHostsAcc: Set<string>): McpServersResult {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid-manifest', message: '"capabilities.mcpServers" must be an array.' };
  }
  if (raw.length > MCP_SERVERS_MAX) {
    return { ok: false, code: 'invalid-manifest', message: `"capabilities.mcpServers" may declare at most ${MCP_SERVERS_MAX} servers, got ${raw.length}.` };
  }
  const out: McpServerSpec[] = [];
  const seenNames = new Set<string>();

  for (const rawEntry of raw) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { ok: false, code: 'invalid-manifest', message: 'Each mcpServers entry must be a mapping object.' };
    }
    const entry = rawEntry as Record<string, unknown>;

    // name (required, NAME_RE, unique within manifest)
    const rawName = entry['name'];
    if (typeof rawName !== 'string' || !NAME_RE.test(rawName)) {
      return { ok: false, code: 'invalid-manifest', message: `mcpServers entry "name" must match /^[a-z][a-z0-9-]{0,63}$/, got: ${JSON.stringify(rawName)}` };
    }
    if (seenNames.has(rawName)) {
      return { ok: false, code: 'invalid-manifest', message: `Duplicate mcpServers name "${rawName}".` };
    }
    seenNames.add(rawName);

    // transport (required, enum)
    const rawTransport = entry['transport'];
    if (rawTransport !== 'stdio' && rawTransport !== 'http') {
      return { ok: false, code: 'invalid-mcp-transport', message: `mcpServers entry "transport" must be "stdio" or "http", got: ${JSON.stringify(rawTransport)}` };
    }

    // per-server allowedHosts (optional). Validated with the shared host
    // validator; collected into both the per-server list and the parent
    // accumulator for the top-level union.
    const perServerHosts = new Set<string>();
    if ('allowedHosts' in entry) {
      const rawHosts = entry['allowedHosts'];
      if (!Array.isArray(rawHosts)) {
        return { ok: false, code: 'invalid-host', message: `mcpServers entry "allowedHosts" must be an array.` };
      }
      for (const h of rawHosts) {
        const v = validateHost(h);
        if (!v.ok) return { ok: false, code: 'invalid-host', message: v.message };
        perServerHosts.add(v.value);
        allowedHostsAcc.add(v.value);
      }
    }

    // per-server credentials (optional). Same shape as top-level credentials.
    let perServerCreds: CapabilitySlot[] = [];
    if ('credentials' in entry) {
      const credResult = parseCredentialList(entry['credentials']);
      if (!credResult.ok) {
        return { ok: false, code: credResult.code, message: credResult.message };
      }
      perServerCreds = credResult.value;
    }

    // transport-specific fields
    let command: string | undefined;
    let args: string[] | undefined;
    let env: Record<string, string> | undefined;
    let url: string | undefined;

    if (rawTransport === 'stdio') {
      const rawCommand = entry['command'];
      if (typeof rawCommand !== 'string' || rawCommand.length === 0) {
        return { ok: false, code: 'invalid-mcp-command', message: `mcpServers stdio entry requires "command", got: ${JSON.stringify(rawCommand)}` };
      }
      if (!MCP_COMMAND_ALLOW.has(rawCommand)) {
        return {
          ok: false,
          code: 'invalid-mcp-command',
          message: `mcpServers "command" must be one of ${[...MCP_COMMAND_ALLOW].join(', ')}; got: ${JSON.stringify(rawCommand)}`,
        };
      }
      command = rawCommand;

      if ('args' in entry) {
        const rawArgs = entry['args'];
        if (!Array.isArray(rawArgs)) {
          return { ok: false, code: 'invalid-manifest', message: `mcpServers "args" must be an array.` };
        }
        if (rawArgs.length > MCP_ARGS_MAX) {
          return { ok: false, code: 'invalid-manifest', message: `mcpServers "args" may have at most ${MCP_ARGS_MAX} entries, got ${rawArgs.length}.` };
        }
        const parsedArgs: string[] = [];
        for (const a of rawArgs) {
          if (typeof a !== 'string') {
            return { ok: false, code: 'invalid-manifest', message: `Each mcpServers "args" entry must be a string, got: ${JSON.stringify(a)}` };
          }
          if (a.length > MCP_ARG_LEN_MAX) {
            return { ok: false, code: 'invalid-manifest', message: `mcpServers "args" entries must be ≤ ${MCP_ARG_LEN_MAX} chars, got ${a.length}.` };
          }
          parsedArgs.push(a);
        }
        args = parsedArgs;
      }

      if ('env' in entry) {
        const rawEnv = entry['env'];
        if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
          return { ok: false, code: 'invalid-manifest', message: `mcpServers "env" must be a mapping object.` };
        }
        const envOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            return { ok: false, code: 'invalid-manifest', message: `mcpServers "env.${k}" must be a string, got: ${JSON.stringify(v)}` };
          }
          envOut[k] = v;
        }
        env = envOut;
      }

      // stdio entries must NOT carry a url.
      if ('url' in entry) {
        return { ok: false, code: 'invalid-manifest', message: 'mcpServers stdio entry must not declare "url".' };
      }
    } else {
      // transport === 'http'
      const rawUrl = entry['url'];
      if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
        return { ok: false, code: 'invalid-host', message: `mcpServers http entry requires "url", got: ${JSON.stringify(rawUrl)}` };
      }
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { ok: false, code: 'invalid-host', message: `mcpServers "url" must be a valid URL, got: ${JSON.stringify(rawUrl)}` };
      }
      if (parsed.protocol !== 'https:') {
        return { ok: false, code: 'invalid-host', message: `mcpServers "url" must use https://, got: ${JSON.stringify(rawUrl)}` };
      }
      const host = parsed.hostname;
      if (IPV4_RE.test(host)) {
        return { ok: false, code: 'invalid-host', message: `mcpServers "url" host may not be an IP literal: "${host}"` };
      }
      if (!HOSTNAME_RE.test(host)) {
        return { ok: false, code: 'invalid-host', message: `mcpServers "url" host "${host}" is not a valid hostname.` };
      }
      url = rawUrl;
      // Fold the URL host into both the per-server list and the parent acc
      // so the top-level union (and downstream credential-proxy) sees it.
      perServerHosts.add(host);
      allowedHostsAcc.add(host);

      // http entries must NOT carry stdio-only fields.
      for (const k of ['command', 'args', 'env']) {
        if (k in entry) {
          return { ok: false, code: 'invalid-manifest', message: `mcpServers http entry must not declare "${k}".` };
        }
      }
    }

    out.push({
      name: rawName,
      transport: rawTransport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(url !== undefined ? { url } : {}),
      allowedHosts: [...perServerHosts],
      credentials: perServerCreds,
    });
  }

  return { ok: true, value: out };
}

// Matches wildcard host patterns like *.example.com inside an
// allowedHosts entry, before YAML parsing. YAML treats bare `*` as an
// alias sigil, so the parser would throw YAMLException instead of
// reaching the host validator — catch pre-parse to return the correct
// code. Covers both shapes the editor / user might submit:
//   allowedHosts: [*.example.com, ...]                (flow sequence)
//   allowedHosts:                                     (block list)
//     - *.example.com
const WILDCARD_HOST_IN_YAML_RE =
  /(?:^|\n)\s*allowedHosts\s*:\s*(?:\[[^\]]*\*[^\]]*\]|(?:\n[ \t]*-[ \t]*[^\n]*\*[^\n]*)+)/;

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
  let mcpServers: McpServerSpec[] = [];

  if ('capabilities' in doc) {
    const rawCaps = doc['capabilities'];
    if (rawCaps === null || typeof rawCaps !== 'object' || Array.isArray(rawCaps)) {
      return err('invalid-manifest', '"capabilities" must be a mapping object.');
    }
    const caps = rawCaps as Record<string, unknown>;

    // Accumulator: top-level allowedHosts plus every per-server allowedHosts
    // (incl. the http transport's implicit URL host) are unioned here so the
    // credential-proxy sees the full skill-level egress allowlist. See
    // docs/plans/2026-05-20-skills-mcp-bundling-security-note.md §1.
    const allowedHostsAcc = new Set<string>();

    // Step 7 (was: reserved mcpServers key): parse mcpServers.
    if ('mcpServers' in caps) {
      const r = parseMcpServers(caps['mcpServers'], allowedHostsAcc);
      if (!r.ok) return err(r.code, r.message);
      mcpServers = r.value;
    }

    // Step 8: top-level allowedHosts
    if ('allowedHosts' in caps) {
      const rawHosts = caps['allowedHosts'];
      if (!Array.isArray(rawHosts)) {
        return err('invalid-host', '"capabilities.allowedHosts" must be an array.');
      }
      for (const h of rawHosts) {
        const v = validateHost(h);
        if (!v.ok) return err('invalid-host', v.message);
        allowedHostsAcc.add(v.value);
      }
    }

    // Materialize the unioned host list (insertion-ordered, deduped).
    allowedHosts = [...allowedHostsAcc];

    // Step 9: top-level credentials
    if ('credentials' in caps) {
      const r = parseCredentialList(caps['credentials']);
      if (!r.ok) return err(r.code, r.message);
      credentials = r.value;
    }
  }

  return {
    ok: true,
    value: {
      id: name,
      description,
      version,
      capabilities: { allowedHosts, credentials, mcpServers },
    },
  };
}
