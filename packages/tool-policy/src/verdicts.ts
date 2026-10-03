import type { PolicyRule, PolicyVerdict } from './types.js';

/**
 * Per-tool verdicts (TASK-736, connectors rail slice 3) — the PURE half.
 *
 * Three layers decide what happens to a call:
 *
 *   1. the STATIC rule table (`rules.ts`, reviewed in a diff) — evaluated per
 *      call, egress relaxation included;
 *   2. the CONNECTOR CEILING — the per-tool default whoever can edit the
 *      connector set (an admin for a shared one). A connector tool nobody set
 *      a default for has an implicit `hold` ceiling: "Ask first";
 *   3. the AGENT OVERRIDE — the agent's own choice, copied from the ceiling on
 *      attach (`origin: 'snapshot'`) or picked by a person (`origin: 'user'`).
 *
 * THE EFFECTIVE VERDICT IS THE STRICTEST OF THE THREE. That one sentence is
 * the whole tighten-only guarantee, and it holds by construction rather than by
 * a check somebody has to remember: `strictest` can only ever move a verdict
 * toward `deny`, so no stored row — however it got there, including one written
 * before a ceiling was tightened, or one a buggy writer let through — can turn
 * a static `deny` or `hold` into something looser. The write-time ceiling check
 * in `set-agent-override` exists so a person is TOLD they cannot loosen; it is
 * not what stops them.
 *
 * No I/O, no clock, no throw — same contract as `evaluate()`.
 */

/** allow < hold < deny. */
const SEVERITY: Readonly<Record<PolicyVerdict, number>> = { allow: 0, hold: 1, deny: 2 };

/**
 * The stricter of the verdicts given. An unrecognised value is treated as
 * `deny` — the same direction `@ax/decisions` routes an unknown verdict — so a
 * corrupted row can tighten but never loosen.
 */
export function strictest(...verdicts: readonly (PolicyVerdict | undefined)[]): PolicyVerdict {
  let out: PolicyVerdict = 'allow';
  for (const v of verdicts) {
    if (v === undefined) continue;
    const s = SEVERITY[v];
    if (s === undefined) return 'deny';
    if (s > SEVERITY[out]) out = v;
  }
  return out;
}

/** True when `candidate` would grant more than `ceiling` allows. */
export function isLooserThan(candidate: PolicyVerdict, ceiling: PolicyVerdict): boolean {
  return SEVERITY[candidate] < SEVERITY[ceiling];
}

export function isPolicyVerdict(v: unknown): v is PolicyVerdict {
  return v === 'allow' || v === 'hold' || v === 'deny';
}

/**
 * The host-wide abilities a person may switch off for one agent (design §3:
 * "Ability toggles are agent-level tighten-only overrides"). A closed list on
 * purpose: `WebFetch`, `Task`, `request_capability`, the `*_propose` tools and
 * every other static rule are NOT overridable at all, so there is no row a
 * person could write against them even in principle.
 */
export const ABILITY_TOOLS: readonly string[] = Object.freeze(['web_search', 'web_extract', 'Bash']);

/** Upper bound on a stored tool key. Real ones are ~20 + the tool's own name. */
export const MAX_TOOL_KEY_CHARS = 200;

/**
 * Shape of a host-minted connector namespace: `c` + 10 lowercase hex
 * (`@ax/connectors` `deriveToolNamespace`, TASK-734). Mirrored, not imported
 * (invariant 2); the drift pin is the literal `c5e0235982f` that the connectors,
 * orchestrator and runner tests also pin.
 */
export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;

/**
 * The tool half of a key: printable, no whitespace, no control characters.
 * Dots are allowed (MCP tool names may contain them); the namespace is split
 * at the FIRST dot after `mcp.`, so a dotted tool name cannot forge a
 * different namespace.
 */
const TOOL_NAME_RE = /^[\x21-\x7e]+$/;

export interface ConnectorToolKey {
  toolNamespace: string;
  tool: string;
}

/**
 * `mcp.<toolNamespace>.<tool>` → its parts, or `null` when the key is not a
 * connector tool key. ONLY the host-minted `c<10 hex>` namespace qualifies:
 * an admin-configured host MCP server (`@ax/mcp-client`, `mcp.<serverId>.x`)
 * shares the `mcp.` keyspace but is not a connector and has no connector
 * ceiling. That split relies on mcp-client refusing a `c<10 hex>` server id
 * (TASK-752); otherwise an admin server could pass for a connector here.
 */
export function parseConnectorToolKey(key: unknown): ConnectorToolKey | null {
  if (typeof key !== 'string' || key.length > MAX_TOOL_KEY_CHARS) return null;
  if (!key.startsWith('mcp.')) return null;
  const rest = key.slice('mcp.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const toolNamespace = rest.slice(0, dot);
  const tool = rest.slice(dot + 1);
  if (!CONNECTOR_TOOL_NAMESPACE_RE.test(toolNamespace)) return null;
  if (tool.length === 0 || !TOOL_NAME_RE.test(tool)) return null;
  return { toolNamespace, tool };
}

/** True for any well-formed `mcp.<segment>.<tool>` key. */
export function isMcpToolKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > MAX_TOOL_KEY_CHARS) return false;
  if (!key.startsWith('mcp.')) return false;
  const rest = key.slice('mcp.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return false;
  return TOOL_NAME_RE.test(rest);
}

/**
 * Whether an agent override may be stored under this key: an ability, or an
 * `mcp.*` tool. Everything else — `WebFetch`, `Task`, `request_capability`,
 * a sandbox builtin other than `Bash` — is refused.
 */
export function isOverridableKey(key: unknown): key is string {
  return (typeof key === 'string' && ABILITY_TOOLS.includes(key)) || isMcpToolKey(key);
}

/**
 * Whether a call to this tool has to consult the verdict store at all. The
 * same set as `isOverridableKey`: a tool no override can name and no ceiling
 * can cover pays nothing on the `tool:pre-call` path.
 */
export function consultsVerdictStore(toolName: string): boolean {
  return isOverridableKey(toolName);
}

/**
 * The verdict the static table gives a tool for EVERY call — the first rule
 * naming it with no `when` predicate — or `allow` when no unconditional rule
 * speaks. An `egress` relaxation is ignored: it loosens some calls, and a
 * ceiling has to be what the tool can do at most WITHOUT a host being allowed.
 */
export function staticCeiling(rules: readonly PolicyRule[], tool: string): PolicyVerdict {
  for (const rule of rules) {
    if (rule.match.tool !== tool) continue;
    if (rule.match.when !== undefined) continue;
    return rule.verdict;
  }
  return 'allow';
}

/**
 * The most an agent may choose for `toolKey`: the static ceiling, tightened by
 * the connector default when the key is a connector tool — and a connector tool
 * with NO default is capped at `hold` (design: "no admin default and never
 * inventoried → Ask first").
 */
export function ceilingFor(
  rules: readonly PolicyRule[],
  toolKey: string,
  connectorDefault: PolicyVerdict | undefined,
): PolicyVerdict {
  const base = staticCeiling(rules, toolKey);
  if (parseConnectorToolKey(toolKey) === null) return base;
  return strictest(base, connectorDefault ?? 'hold');
}

/**
 * The verdict a call actually gets, given what the static table said about
 * THIS call (`staticVerdict`, egress relaxation already applied) and the two
 * stored layers. See the module comment: strictest wins, always.
 */
export function layeredVerdict(args: {
  toolName: string;
  staticVerdict: PolicyVerdict;
  connectorDefault: PolicyVerdict | undefined;
  override: PolicyVerdict | undefined;
}): PolicyVerdict {
  const connectorCeiling =
    parseConnectorToolKey(args.toolName) === null ? undefined : (args.connectorDefault ?? 'hold');
  return strictest(args.staticVerdict, connectorCeiling, args.override);
}
