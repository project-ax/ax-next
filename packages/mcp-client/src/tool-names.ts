// ---------------------------------------------------------------------------
// Tool-name namespacing (Task 12).
//
// MCP servers advertise tools with arbitrary names. Two servers can advertise
// the same name; any server can collide with a built-in AX tool (`read_file`,
// `bash`, etc.). To keep the dispatcher's catalog (single source of truth —
// invariant I4) collision-free, every MCP-sourced tool is re-keyed as:
//
//     mcp.${serverId}.${sanitized(remoteName)}
//
// The dispatcher's TOOL_NAME_RE is `/^[a-z][a-z0-9_.-]{0,63}$/`. We:
//
//   1. Lowercase the whole output.
//   2. Replace every disallowed char in the remote name with `_`.
//   3. On collision WITHIN a single server (two remote names sanitize to the
//      same string), append a stable 6-hex-char hash suffix to BOTH entries.
//      Hashing both — rather than "first wins keeps clean name" — makes the
//      result independent of discovery order, which matters because
//      `listTools()` doesn't promise any order and we'd otherwise flake
//      on reconnects.
//   4. If the total exceeds 64 chars, truncate the sanitized remote name to
//      fit `mcp.${serverId}.<truncated>_<hash6>` within 64 chars. Pathological
//      serverIds (where even the prefix+hash overflows) throw — by then
//      there's no well-defined name to hand out.
//
// We also build a reverse map from namespacedName → originalRemoteName so
// Task 13's plugin layer can route `tool:execute:mcp.fs.read_file` back to
// `client.callTool('read_file', ...)` on the right connection.
//
// Every descriptor is marked `executesIn: 'host'` — MCP tools run on the
// host side (the plugin forwards calls out over stdio/http/sse), never in
// the sandbox.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { PluginError, type ToolDescriptor } from '@ax/core';
import type { McpToolDescriptor } from './connection.js';

const PLUGIN_NAME = '@ax/mcp-client';
const MCP_NAMESPACE_PREFIX = 'mcp.';
// Dispatcher's TOOL_NAME_RE caps at 64 chars total. Keep our outputs within
// that bound so registration never fails catalog validation.
const MAX_NAME_LEN = 64;
// 6 hex chars = 24 bits of entropy — plenty for per-server disambiguation
// (a server would need to advertise millions of colliding names before a
// second-order collision becomes plausible).
const HASH_LEN = 6;

/** A namespaced tool paired with the remote name needed to dispatch a call. */
export interface NamespacedTool {
  /** Full namespaced name as stored in the dispatcher catalog. */
  namespacedName: string;
  /** Original name as the MCP server knows it. Required for round-tripping via callTool. */
  originalName: string;
}

/** Result of namespacing one server's tool list. */
export interface NamespaceResult {
  /** Tool descriptors with namespaced names and `executesIn:'host'`. Ready for tool:register. */
  descriptors: ToolDescriptor[];
  /** Map from namespacedName → originalName, for callTool() routing. */
  nameMap: Map<string, string>;
}

/**
 * True if `ch` is a single character that the dispatcher regex accepts in
 * the body of a tool name. First-char rules (must be `[a-z]`) are handled
 * separately because our output always begins with `mcp.` — a lowercase `m`.
 */
function isAllowedBodyChar(ch: string): boolean {
  return /^[a-z0-9_.\-]$/.test(ch);
}

function sanitize(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    out += isAllowedBodyChar(ch) ? ch : '_';
  }
  return out;
}

function shortHash(serverId: string, remoteName: string): string {
  return createHash('sha256').update(`${serverId}:${remoteName}`).digest('hex').slice(0, HASH_LEN);
}

/**
 * Build the namespaced name for a single tool. Exported for unit testability
 * and for callers that need to compute a name without building a full
 * NamespaceResult. Does NOT resolve collisions — that's `namespaceTools`'s
 * job, because collision resolution needs the whole set.
 */
export function buildNamespacedName(serverId: string, remoteName: string): string {
  const sanitized = sanitize(remoteName);
  const candidate = `${MCP_NAMESPACE_PREFIX}${serverId}.${sanitized}`;
  if (candidate.length <= MAX_NAME_LEN) return candidate;

  // Overflow path: reserve room for `_${hash}` and truncate the sanitized
  // suffix to fit. Hash comes from the original (unsanitized) remote name
  // so long names sharing a sanitized prefix still get distinct hashes.
  const hash = shortHash(serverId, remoteName);
  const prefix = `${MCP_NAMESPACE_PREFIX}${serverId}.`;
  const reserved = 1 + hash.length; // underscore + hash chars
  const room = MAX_NAME_LEN - prefix.length - reserved;
  if (room < 1) {
    throw new PluginError({
      code: 'name-too-long',
      plugin: PLUGIN_NAME,
      message:
        `serverId '${serverId}' too long to fit any namespaced tool name within ` +
        `${MAX_NAME_LEN} chars`,
    });
  }
  return `${prefix}${sanitized.slice(0, room)}_${hash}`;
}

/**
 * Namespace one server's tools. Sanitizes names, resolves collisions, and
 * returns descriptors ready for `tool:register` along with the reverse map
 * from namespaced names to the original names the server knows.
 *
 * Invariants:
 *   - `descriptors.length === tools.length`
 *   - every `d.name` in `descriptors` is a key in `nameMap`
 *   - every descriptor has `executesIn: 'host'`
 *   - descriptions/inputSchemas are preserved verbatim (no editorializing)
 */
export function namespaceTools(
  serverId: string,
  tools: McpToolDescriptor[],
): NamespaceResult {
  // First pass: compute each tool's initial candidate name.
  const candidates = tools.map((t) => ({
    original: t,
    candidate: buildNamespacedName(serverId, t.name),
  }));

  // Second pass: find candidate names that appear more than once within
  // this server's batch. Those entries get hash-suffixed; non-colliding
  // candidates keep their clean form.
  const counts = new Map<string, number>();
  for (const c of candidates) {
    counts.set(c.candidate, (counts.get(c.candidate) ?? 0) + 1);
  }

  const descriptors: ToolDescriptor[] = [];
  const nameMap = new Map<string, string>();
  for (const c of candidates) {
    let finalName = c.candidate;
    if ((counts.get(c.candidate) ?? 0) > 1) {
      // Re-derive with a hash suffix. We use the same overflow-aware layout
      // as `buildNamespacedName`'s long-name path so the 64-char cap still
      // holds even when two long names collide.
      const hash = shortHash(serverId, c.original.name);
      const prefix = `${MCP_NAMESPACE_PREFIX}${serverId}.`;
      const reserved = 1 + hash.length;
      const room = MAX_NAME_LEN - prefix.length - reserved;
      if (room < 1) {
        throw new PluginError({
          code: 'name-too-long',
          plugin: PLUGIN_NAME,
          message:
            `serverId '${serverId}' too long to fit any namespaced tool name within ` +
            `${MAX_NAME_LEN} chars`,
        });
      }
      const sanitized = sanitize(c.original.name).slice(0, room);
      finalName = `${prefix}${sanitized}_${hash}`;
    }

    // Conditional spread is required under exactOptionalPropertyTypes — passing
    // `description: undefined` would violate `ToolDescriptor`'s optional field.
    const descriptor: ToolDescriptor = {
      name: finalName,
      inputSchema: c.original.inputSchema,
      executesIn: 'host',
      ...(c.original.description !== undefined ? { description: c.original.description } : {}),
    };
    descriptors.push(descriptor);
    nameMap.set(finalName, c.original.name);
  }
  return { descriptors, nameMap };
}
