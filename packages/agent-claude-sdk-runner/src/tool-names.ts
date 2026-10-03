// ---------------------------------------------------------------------------
// Tool-name classifier for claude-agent-sdk tool names.
//
// The claude-agent-sdk surfaces four flavors of tool in `canUseTool` and
// `PostToolUse`:
//
//   1. Built-in SDK tools — names like `Bash`, `Read`, `Edit`, ... These
//      arrive verbatim. Our host-side `tool:pre-call` subscribers see the
//      name as-is and decide whether to permit them.
//
//   2. MCP-hosted tools served from one of our two in-process MCP servers:
//      `ax-host-tools` (host-mcp-server.ts — `executesIn: 'host'`) and
//      `ax-sandbox-tools` (sandbox-mcp-server.ts — `executesIn: 'sandbox'`).
//      The SDK renames them to `mcp__<server>__<tool>` at the canUseTool
//      boundary. We strip the appropriate `mcp__<server>__` prefix so
//      subscribers see the ax-native tool name they registered.
//
//   3. Disabled built-ins — things we don't want the agent reaching at
//      all: WebFetch / WebSearch (raw network egress that bypasses the
//      credential-proxy / egress policy), `Task` (the nested-agent surface
//      that would spawn a sub-agent outside our hook bus), and
//      `AskUserQuestion` (the SDK's interactive multiple-choice picker,
//      answered by the CLI's own UI). We run the CLI headless over
//      stream-json with no such UI and no control-protocol round-trip wired
//      to feed a user-chosen answer back as the tool_result — so if the
//      model called AskUserQuestion it would emit a question the user could
//      never actually answer (the chat UI just renders it as an inert tool
//      blob). Disabling it forces the model to ask in plain chat instead,
//      which renders normally and is answerable in the ordinary turn flow
//      (the runner's clarifying-questions system-prompt note steers this —
//      see system-prompt.ts).
//
//      WHERE THE ENFORCEMENT ACTUALLY LIVES: `main.ts` passes these four
//      names as `disallowedTools`, and the SDK's own typing for that option
//      says the tools "will be removed from the model's context and cannot
//      be used" (@anthropic-ai/claude-agent-sdk 0.2.119, sdk.d.ts:1185-1189
//      and :3209-3212). So in a healthy session the model never sees one,
//      never emits a call for one, and `kind: 'disabled'` never comes back
//      from this function at runtime. The classification — and the two
//      call-site refusals it drives (pre-tool-use.ts, can-use-tool.ts) — are
//      defence in depth for the day `disallowedTools` regresses or the SDK
//      changes what it means. `DISABLED_BUILTIN_REASONS` below gives each of
//      the four its own sentence so that, if that day comes, the refusal says
//      WHICH of four different things was refused instead of one flat string.
//
//      NOTE on `Skill`: previously also denied here on the same
//      "bypass our hook bus" rationale, but Phase 0 of the skill-install
//      workflow (I-P0-1, docs/plans/2026-05-17-skill-install-phase-0-impl.md)
//      flips Skill from "denied at every layer" to "the intended SDK-native
//      skill-discovery path." Skill is now in `allowedTools` and the SDK
//      reads skills from $CLAUDE_CONFIG_DIR/skills/ (host-controlled) and
//      <workspace>/.claude/skills/ (a narrow symlink to .ax/draft-skills,
//      gated at workspace:pre-apply by @ax/validator-skill — see commit
//      521f206c, which vetoes agent writes to .claude/settings.json,
//      CLAUDE.md, and other SDK-config paths that would let an agent
//      escalate via the now-enabled user/project setting sources).
//      Skill is NOT a nested-agent bypass; `Task` still is.
//
//   4. Connector MCP tools (TASK-734). Connector MCP servers run INSIDE the
//      sandbox via the per-directory `.mcp.json` the runner materializes
//      (`@ax/agent-runner-core` installed-skills). The host keys each server
//      by an opaque, host-minted `toolNamespace` (`c` + 10 lowercase hex) —
//      never the connector author's free-text `spec.name` — so the SDK names
//      their tools `mcp__<toolNamespace>__<tool>`. We lift exactly that shape
//      to the canonical connector tool key
//
//          toolKey = `mcp.<toolNamespace>.<tool>`
//
//      which is what `tool.pre-call` / `event.tool-post-call` and therefore
//      `@ax/tool-policy` see. The namespace is stable per connector record
//      (same record -> same namespace for every user/agent/session), so a
//      policy rule can address one connector's tool without being spoofable
//      by a second connector that happens to pick the same server name.
//      The `<tool>` part is passed through verbatim (it may contain `__`,
//      `.` or `-`; the SDK's own name is the only source of truth for it).
//
//      The shape mirrors `@ax/connectors`' `TOOL_NAMESPACE_RE`. It is written
//      out here rather than imported on purpose: that would be a cross-plugin
//      import (invariant 2), and the runner runs in the sandbox where the
//      connectors plugin does not exist. Only host-minted namespaces are
//      lifted; a foreign `mcp__linear__x` is NOT (see below), so an agent
//      cannot reach the canonical keyspace by naming a server cleverly.
//
// Anything else — including MCP tools from a DIFFERENT server (not ours) —
// falls through as kind 'builtin' with the full name preserved. That's a
// deliberate fallback: third-party MCP servers are out of scope for v1 but
// the classifier shouldn't silently swallow them if one shows up. The
// host-side subscribers will see the full `mcp__<other>__<tool>` name and
// can decide how to handle it (most likely: reject).
// ---------------------------------------------------------------------------

export const MCP_HOST_SERVER_NAME = 'ax-host-tools';
export const MCP_SANDBOX_SERVER_NAME = 'ax-sandbox-tools';

export const DISABLED_BUILTINS = [
  'WebFetch',
  'WebSearch',
  'Task',
  'AskUserQuestion',
] as const;

export type DisabledBuiltin = (typeof DISABLED_BUILTINS)[number];

/**
 * One sentence per disabled built-in, naming the sanctioned alternative where
 * there is one. These are NOT the strings the model or a person reads in the
 * normal course of a turn: `disallowedTools` keeps all four out of the model's
 * context, so no call for them is ever emitted and neither refusal site runs
 * (see the header comment). They exist so that when defence in depth is the
 * thing that fires — a regressed `disallowedTools`, a changed SDK — whoever is
 * reading the transcript or the pod log can tell the four causes apart.
 *
 * Written out longhand on purpose. `@ax/tool-policy`'s `BUILTIN_RULES` carries
 * the human-facing rail sentences for the same four tools, but importing them
 * here would be a cross-plugin import (invariant 2) — and in the direction
 * `rules.ts` already refuses to import THIS module. That makes this the third
 * place the four names are written down — though only two of the three can
 * drift: this record's keys are `Record<DisabledBuiltin, string>`, so the
 * compiler ties them to the array three lines up.
 *
 * The hand-maintained copy in `rules.ts` is the drift-prone one, and TASK-245
 * ruled it should STAY hand-maintained: that rail is runner-agnostic and holds
 * the names both runners keep from the agent, not this runner's list. It is
 * held honest from outside instead —
 * `scripts/__tests__/disabled-builtin-rail-drift.test.js` reads this array as
 * text and fails if the rail stops matching. Which matters most when a new SDK
 * arrives and `SECURITY.md` sends the upgrader here to add a name.
 */
export const DISABLED_BUILTIN_REASONS: Record<DisabledBuiltin, string> = {
  WebFetch:
    'WebFetch is disabled: it reaches websites outside the recorded connection. ' +
    'Use the web_extract tool instead.',
  WebSearch:
    'WebSearch is disabled: it searches the web outside the recorded connection. ' +
    'Use the web_search tool instead.',
  Task:
    'Task is disabled: it would start a helper agent no one here can see or ' +
    'approve. There is no substitute — do the work in this session.',
  AskUserQuestion:
    'AskUserQuestion is disabled: this session has no way to hand a chosen ' +
    'answer back. Ask in your reply instead, list the options, and wait.',
};

/**
 * Shape of a host-minted connector `toolNamespace`: `c` + 10 lowercase hex.
 * Mirrors `@ax/connectors`' `TOOL_NAMESPACE_RE` (no cross-plugin import, I2).
 * Anchored and case-sensitive on purpose — `C0123456789`, 9/11 hex chars and
 * non-hex characters are all NOT host-minted and are not lifted.
 */
export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;

export type SdkToolClass =
  | { kind: 'builtin'; axName: string }
  | { kind: 'mcp-host'; axName: string }
  | { kind: 'mcp-sandbox'; axName: string }
  // A connector MCP tool, `mcp__<toolNamespace>__<tool>` on the SDK wire.
  // `axName` is the canonical toolKey `mcp.<toolNamespace>.<tool>`.
  | { kind: 'mcp-connector'; axName: string }
  // No `axName`: a disabled built-in is refused by name at the call site and
  // never reaches `tool:pre-call`, so there is no ax-native name to carry.
  // `reason` is the per-cause sentence from `DISABLED_BUILTIN_REASONS`.
  | { kind: 'disabled'; name: DisabledBuiltin; reason: string };

const MCP_HOST_PREFIX = `mcp__${MCP_HOST_SERVER_NAME}__`;
const MCP_SANDBOX_PREFIX = `mcp__${MCP_SANDBOX_SERVER_NAME}__`;
const MCP_PREFIX = 'mcp__';

function isDisabledBuiltin(sdkName: string): sdkName is DisabledBuiltin {
  return (DISABLED_BUILTINS as readonly string[]).includes(sdkName);
}

/**
 * Split `mcp__<toolNamespace>__<tool>` into its two parts, or `undefined` when
 * the name does not carry a host-minted namespace. A valid namespace is `c` +
 * hex and so can never contain `__`: the FIRST `__` after the `mcp__` lead is
 * therefore the separator, and everything after it is the tool part verbatim
 * (it may itself contain `__`, `.` or `-`). `CONNECTOR_TOOL_NAMESPACE_RE` is
 * the single place the namespace shape is written down.
 */
function splitConnectorToolName(
  sdkName: string,
): { toolNamespace: string; tool: string } | undefined {
  if (!sdkName.startsWith(MCP_PREFIX)) return undefined;
  const sep = sdkName.indexOf('__', MCP_PREFIX.length);
  if (sep === -1) return undefined;
  const toolNamespace = sdkName.slice(MCP_PREFIX.length, sep);
  const tool = sdkName.slice(sep + 2);
  if (tool.length === 0 || !CONNECTOR_TOOL_NAMESPACE_RE.test(toolNamespace)) {
    return undefined;
  }
  return { toolNamespace, tool };
}

/**
 * Shape of an SDK built-in tool name (`Bash`, `Read`, `NotebookEdit`, …):
 * PascalCase ASCII letters. AX host/sandbox catalog tools are snake_case
 * (`web_search`, `artifact_publish`) and connector keys are `mcp.<ns>.<tool>`,
 * so neither can match.
 */
const SDK_BUILTIN_NAME_RE = /^[A-Z][A-Za-z]*$/;

/**
 * Map the agent's canonical DENIED tool names (`agentConfig.disallowedTools`:
 * `Bash`, `web_search`, `mcp.<toolNamespace>.<tool>`, …) to the names the
 * claude-agent-sdk's `disallowedTools` option understands. The inverse of
 * `classifySdkToolName` for the two kinds the SDK itself surfaces:
 *
 *   - an SDK built-in (`Bash`) passes through verbatim;
 *   - a connector key `mcp.<toolNamespace>.<tool>` with a host-minted
 *     namespace (`CONNECTOR_TOOL_NAMESPACE_RE`) becomes
 *     `mcp__<toolNamespace>__<tool>`.
 *
 * Everything else is SKIPPED: host/sandbox catalog tools (`web_search`,
 * `web_extract`, any other `mcp.*`) are already dropped from the catalog by
 * `@ax/agent-runner-core` before the in-process MCP servers are built, so
 * they never reach the SDK. Catalog hygiene only — enforcement stays host-side
 * on `tool.pre-call`. Deduped, input order preserved.
 */
export function sdkDisallowedToolNames(canonical: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of canonical) {
    if (SDK_BUILTIN_NAME_RE.test(name)) {
      out.add(name);
      continue;
    }
    if (!name.startsWith('mcp.')) continue;
    const rest = name.slice('mcp.'.length);
    const dot = rest.indexOf('.');
    if (dot === -1) continue;
    const toolNamespace = rest.slice(0, dot);
    const tool = rest.slice(dot + 1);
    if (tool.length === 0 || !CONNECTOR_TOOL_NAMESPACE_RE.test(toolNamespace)) continue;
    out.add(`${MCP_PREFIX}${toolNamespace}__${tool}`);
  }
  return [...out];
}

export function classifySdkToolName(sdkName: string): SdkToolClass {
  if (isDisabledBuiltin(sdkName)) {
    return {
      kind: 'disabled',
      name: sdkName,
      reason: DISABLED_BUILTIN_REASONS[sdkName],
    };
  }
  if (sdkName.startsWith(MCP_HOST_PREFIX)) {
    return { kind: 'mcp-host', axName: sdkName.slice(MCP_HOST_PREFIX.length) };
  }
  if (sdkName.startsWith(MCP_SANDBOX_PREFIX)) {
    return { kind: 'mcp-sandbox', axName: sdkName.slice(MCP_SANDBOX_PREFIX.length) };
  }
  // After the ax host/sandbox prefixes (those names are ours and win) and
  // before the verbatim fallback. Only a host-minted namespace is lifted.
  const connector = splitConnectorToolName(sdkName);
  if (connector !== undefined) {
    return {
      kind: 'mcp-connector',
      axName: `mcp.${connector.toolNamespace}.${connector.tool}`,
    };
  }
  // Fallback: pass the name through unchanged. Covers built-in SDK tools
  // (Bash, Read, Edit, …) AND unknown-to-us MCP tools from other servers.
  // Host-side subscribers see the verbatim name and decide.
  return { kind: 'builtin', axName: sdkName };
}

/**
 * Resolve an SDK wire name to the catalog's host-authored activityPhrase
 * (TASK-271), or `undefined` when there is none to show. Normalizes via
 * `classifySdkToolName` so `mcp__<server>__<tool>` hits the bare-name-keyed
 * map; disabled and unknown names miss and emit without a phrase.
 */
export function activityPhraseForSdkName(
  phraseByAxName: ReadonlyMap<string, string>,
  sdkName: string,
): string | undefined {
  const cls = classifySdkToolName(sdkName);
  if (cls.kind === 'disabled') return undefined;
  return phraseByAxName.get(cls.axName);
}
