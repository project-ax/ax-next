import { PluginError, type ToolDescriptor } from '@ax/core';

// Tool names must match this shape. A leading lowercase letter keeps the
// first segment parseable as an identifier; the `.` allows namespacing
// like `memory.recall` without needing a second registry. The 64-char cap
// matches what the wire protocol is comfortable forwarding.
//
// Intentionally more permissive than the prior `tool:execute:${name}`
// regex: that one had to compose with hook-name suffixes, so it banned
// `.` to avoid ambiguity. `tool:register` carries the name as a
// payload field, not a hook-name segment, so the namespace separator
// is safe here.
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

const PLUGIN_NAME = '@ax/tool-dispatcher';

// Render an arbitrary value as a printable diagnostic string without
// ever throwing. `JSON.stringify` blows up on BigInts, circular refs,
// and custom `toJSON`s that throw — any of which would bubble out of
// `validateDescriptor` as a raw `TypeError` instead of our structured
// `PluginError('invalid-payload')`.
function safeDisplay(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s === 'string') return s;
  } catch {
    // fall through
  }
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

/**
 * In-memory tool catalog. Single source of truth (invariant I4) — only
 * `@ax/tool-dispatcher` owns the map. Other plugins read via `tool:list`
 * and mutate via `tool:register`; they must not cache the result.
 *
 * Life cycle:
 *  - `register(d)` accepted until the first `list()` call.
 *  - First `list()` seals the catalog.
 *  - Subsequent `register(d)` throws `catalog-sealed` — belt-and-suspenders
 *    against a future bug where tool registration drifts past `init()`.
 *    Plugins should register during `init()`; the bus guarantees all
 *    `init()` hooks run before any chat starts, so this is only a
 *    safety net.
 */
export class ToolCatalog {
  // Insertion order is preserved (Map iteration order is insertion order in
  // JS), so `list()` returns descriptors in registration order.
  private readonly byName = new Map<string, ToolDescriptor>();
  private sealed = false;

  register(input: unknown): void {
    // Validate shape BEFORE consulting sealed state, so a malformed
    // payload reports `invalid-payload` instead of being hidden behind
    // `catalog-sealed` when both apply.
    const descriptor = validateDescriptor(input);

    if (this.sealed) {
      throw new PluginError({
        code: 'catalog-sealed',
        plugin: PLUGIN_NAME,
        hookName: 'tool:register',
        message:
          `cannot register tool '${descriptor.name}': catalog was sealed by a prior tool:list call`,
      });
    }

    if (this.byName.has(descriptor.name)) {
      throw new PluginError({
        code: 'duplicate-tool',
        plugin: PLUGIN_NAME,
        hookName: 'tool:register',
        message: `tool '${descriptor.name}' is already registered`,
      });
    }

    this.byName.set(descriptor.name, descriptor);
  }

  list(): ToolDescriptor[] {
    this.sealed = true;
    // Shallow copy so callers can't mutate the array we hand back and
    // corrupt future `list()` results. The descriptors themselves are
    // plain data and shared by reference; that's fine because subscribers
    // are contractually read-only on descriptor contents.
    return [...this.byName.values()];
  }
}

function validateDescriptor(input: unknown): ToolDescriptor {
  if (input === null || typeof input !== 'object') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'tool:register',
      message: 'descriptor must be an object',
    });
  }
  const d = input as Record<string, unknown>;

  if (typeof d.name !== 'string' || !TOOL_NAME_RE.test(d.name)) {
    // JSON.stringify(undefined) === undefined, and JSON.stringify throws on
    // BigInts or circular objects / throwing toJSON's. Guard both paths so
    // the caller always gets a PluginError, not a raw TypeError.
    const display = safeDisplay(d.name).slice(0, 64);
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'tool:register',
      message: `invalid tool name: ${display}`,
    });
  }

  if (d.description !== undefined && typeof d.description !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'tool:register',
      message: `tool '${d.name}': description must be a string when provided`,
    });
  }

  if (
    d.inputSchema === null ||
    typeof d.inputSchema !== 'object' ||
    Array.isArray(d.inputSchema)
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'tool:register',
      message: `tool '${d.name}': inputSchema must be an object (JSON Schema)`,
    });
  }

  if (d.executesIn !== 'sandbox' && d.executesIn !== 'host') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'tool:register',
      message:
        `tool '${d.name}': executesIn must be 'sandbox' or 'host' (got ${String(d.executesIn)})`,
    });
  }

  const descriptor: ToolDescriptor = {
    name: d.name,
    inputSchema: d.inputSchema as Record<string, unknown>,
    executesIn: d.executesIn,
  };
  if (typeof d.description === 'string') {
    descriptor.description = d.description;
  }
  return descriptor;
}
