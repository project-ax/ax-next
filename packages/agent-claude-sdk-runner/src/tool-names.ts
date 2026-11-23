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
//      Since TASK-1200 these four are a subset: every SDK built-in outside
//      `ALLOWED_SDK_BUILTINS` is kept from the agent (see that constant), and
//      the classifier refuses any built-in name outside the allowlist. The
//      four keep their own refusal sentences and their `@ax/tool-policy`
//      rail rows; `Agent` (Task's wire name) reuses Task's, the scheduling
//      built-ins share one sentence, and everything else shares another.
//      On the rail, `CronCreate` has a row too (`builtins.cron-create`,
//      TASK-1207). Every other denied name has no row, and the drift guard's
//      `OFF_RAIL` holds the written reason why (see `DISABLED_BUILTIN_REASONS`).
//
//      WHERE THE ENFORCEMENT ACTUALLY LIVES: `main.ts` passes
//      `ALLOWED_SDK_BUILTINS` as the SDK's `tools` option (the base set of
//      built-ins loaded at all) and every other known built-in as
//      `disallowedTools`, and the SDK's own typing for that option
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
//      reads USER skills only from $CLAUDE_CONFIG_DIR/skills/ (the host's
//      read-only projection). The CLI also ships its own BUNDLED skills
//      (`loop`, `update-config`, `simplify`, `init`, …) inside the binary,
//      and the same `Skill` tool would open them (TASK-1207). `loop` and
//      `claude-api` are switched off at the source (`buildBundledSkillsEnv()`,
//      bundled-skills-env.ts); nothing switches off the rest, so pre-tool-use.ts
//      refuses a `Skill` call for any name that is not a folder in the
//      projection (projected-skills.ts). `settingSources` is `['user']`, so nothing
//      the agent writes in its home (`.claude/skills/`, `.claude/settings.json`,
//      `CLAUDE.md`) is loaded. Skill is NOT a nested-agent bypass; `Task`
//      still is.
//
//   4. Connector MCP tools (TASK-734). Connector MCP servers run INSIDE the
//      sandbox via the per-directory `.mcp.json` the runner materializes
//      (`@ax/agent-runner-core` installed-skills) and then loads into
//      `query()`'s `mcpServers` itself (`projected-mcp-servers.ts` → runner-core's
//      loader, TASK-760/826 — the SDK never reads a skill dir's `.mcp.json`). The
//      host keys each server by an opaque, host-minted `toolNamespace` (`c` + 10
//      lowercase hex) — never the connector author's free-text `spec.name` — so
//      the SDK names their tools `mcp__<toolNamespace>__<tool>`. We lift exactly
//      that shape to the canonical connector tool key
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
// A non-`mcp__` name off `ALLOWED_SDK_BUILTINS` is refused as 'disabled'
// (TASK-1200). MCP tools from a DIFFERENT server (not ours) fall through as
// kind 'builtin' with the full name preserved. That's a deliberate fallback: third-party MCP servers are out of scope for v1 but
// the classifier shouldn't silently swallow them if one shows up. The
// host-side subscribers will see the full `mcp__<other>__<tool>` name and
// can decide how to handle it (most likely: reject).
// ---------------------------------------------------------------------------

import { CONNECTOR_TOOL_NAMESPACE_RE } from '@ax/agent-runner-core';

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
 * The SDK built-ins AX offers the agent — an ALLOWLIST, passed to the SDK as
 * its `tools` option ("the base set of available built-in tools", sdk.d.ts).
 * Anything not named here is never loaded into the session, so a new SDK
 * release cannot hand the agent a new capability without someone adding it
 * here on purpose (TASK-1200).
 *
 * Why the denylist alone was not enough: CLI 2.1.119 (SDK 0.2.119) ships
 * ~30 default built-ins (the exact set varies with env flags), most of them DEFERRED — not in the model's first tool
 * list, but loadable by name through `ToolSearch`. The walk for TASK-1192
 * caught an agent doing exactly that: it loaded `CronCreate`, scheduled a
 * sandbox-local job that skipped the `routine_create` hold and could never
 * run (the sandbox is ephemeral; AX's scheduler never saw it), and told the
 * person it was done.
 *
 * What each allowed name is for:
 *   - `Bash` `Read` `Write` `Edit` `Glob` `Grep` — the sandbox file and shell
 *     tools (`@ax/tool-policy`'s `sandbox.*` rows; the aisdk runner registers
 *     the same six).
 *   - `TodoWrite` — an in-turn checklist; it holds nothing past the turn.
 *   - `Skill` — SDK-native skill discovery (I-P0-1, see the header).
 *   - `ToolSearch` — keeps deferred tool schemas (AX's host tools, connector
 *     tools) out of the first request and loads them by name when needed.
 *     Without it the CLI loads every MCP tool up front instead, so this is a
 *     context-size choice, not a reachability one. It only ever loads tools
 *     already in the session, so it cannot widen this list (measured).
 *
 * Every other entry in `KNOWN_SDK_BUILTINS` is kept from the agent: it
 * schedules (`CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`,
 * `RemoteTrigger`), spawns or messages other agents (`Task`, `SendMessage`,
 * `TeamCreate`, `TeamDelete`), reaches the network (`WebFetch`, `WebSearch`,
 * `PushNotification`), or is simply not needed by any AX flow (`Monitor`,
 * `TaskOutput`, `TaskStop` — background tasks are off
 * (`buildBackgroundTasksEnv()`); `Read` and `Bash` still read files and stop processes), needs an
 * interactive UI we do not have (`AskUserQuestion`, `EnterPlanMode`,
 * `ExitPlanMode`), moves the working tree (`EnterWorktree`, `ExitWorktree`),
 * or duplicates `Edit` without the sandbox rows describing it (`NotebookEdit`).
 */
export const ALLOWED_SDK_BUILTINS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
  'Skill',
  'ToolSearch',
] as const;

/**
 * Every built-in tool name the pinned SDK has been OBSERVED to offer (a union,
 * not an exact count — env flags change the set): the `tools` list of the
 * CLI's `system/init` message with no `tools` option, the names on the wire
 * in its first model request (where `Task` goes out as `Agent`), `ToolSearch`
 * (added at request time), and the two MCP resource tools the CLI adds when a
 * server declares resources. CLI 2.1.119 / SDK 0.2.119.
 *
 * `tool-allowlist-real-sdk.e2e.test.ts` re-measures the init list and the
 * first request on the installed binary and fails when either names a tool
 * missing from here — so an
 * SDK upgrade that adds a built-in stops the build until someone decides which
 * side of `ALLOWED_SDK_BUILTINS` it belongs on.
 */
export const KNOWN_SDK_BUILTINS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/**
 * The SDK built-ins kept from the agent: every known built-in outside the
 * allowlist. Passed as `disallowedTools` on top of the `tools` allowlist, so
 * either one alone still keeps them out.
 */
export const DENIED_SDK_BUILTINS: readonly string[] = [
  ...DISABLED_BUILTINS,
  ...KNOWN_SDK_BUILTINS.filter(
    (name) =>
      !(ALLOWED_SDK_BUILTINS as readonly string[]).includes(name) &&
      !(DISABLED_BUILTINS as readonly string[]).includes(name),
  ),
];

const SCHEDULING_BUILTINS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
];

/**
 * Refusal sentence for a built-in outside the allowlist that is not one of the
 * four in `DISABLED_BUILTIN_REASONS`. Like those, it is only ever read if the
 * `tools` allowlist and `disallowedTools` have both regressed.
 */
function notAllowedReason(name: string): string {
  // `Agent` is the name `Task` goes out under on the wire; same refusal.
  if (name === 'Agent') return `Agent (Task) ${DISABLED_BUILTIN_REASONS.Task.replace(/^Task /, '')}`;
  if (SCHEDULING_BUILTINS.includes(name)) {
    return (
      `${name} is disabled: it is part of Claude Code's own scheduler, and a ` +
      'schedule made there would skip the approval routines ask for. To schedule ' +
      'recurring work, create a routine instead.'
    );
  }
  return (
    `${name} is not available here: it would act outside what this workspace ` +
    'can see or approve. Use the tools you were given.'
  );
}

function isAllowedSdkBuiltin(sdkName: string): boolean {
  return (ALLOWED_SDK_BUILTINS as readonly string[]).includes(sdkName);
}

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
 * compiler ties them to `DISABLED_BUILTINS`.
 *
 * The hand-maintained copy in `rules.ts` is the drift-prone one, and TASK-245
 * ruled it should STAY hand-maintained: that rail is runner-agnostic and holds
 * the names both runners keep from the agent, not this runner's list. It is
 * held honest from outside instead —
 * `scripts/__tests__/disabled-builtin-rail-drift.test.js` reads
 * `KNOWN_SDK_BUILTINS`, `ALLOWED_SDK_BUILTINS` and `DISABLED_BUILTINS` as text
 * (renaming any of the three breaks it loudly), recomputes the denied set the
 * way `DENIED_SDK_BUILTINS` does, and fails unless every name both runners keep
 * from the agent is a `builtins.*` rail row (these four, plus `CronCreate`
 * since TASK-1207) or has a written reason in its `OFF_RAIL`, never both. That
 * matters most when a new SDK arrives: a name added to `KNOWN_SDK_BUILTINS`
 * and left off `ALLOWED_SDK_BUILTINS` stays red there until someone writes a
 * row or a reason.
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

// The namespace shape lives in @ax/agent-runner-core (TASK-826) so the aisdk
// runner reads the same one. Re-exported for this runner's existing callers.
export { CONNECTOR_TOOL_NAMESPACE_RE };

export type SdkToolClass =
  | { kind: 'builtin'; axName: string }
  | { kind: 'mcp-host'; axName: string }
  | { kind: 'mcp-sandbox'; axName: string }
  // A connector MCP tool, `mcp__<toolNamespace>__<tool>` on the SDK wire.
  // `axName` is the canonical toolKey `mcp.<toolNamespace>.<tool>`.
  | { kind: 'mcp-connector'; axName: string }
  // No `axName`: a disabled built-in is refused by name at the call site and
  // never reaches `tool:pre-call`, so there is no ax-native name to carry.
  // `reason` is the per-cause sentence from `DISABLED_BUILTIN_REASONS`, or a
  // generic one for any other built-in outside `ALLOWED_SDK_BUILTINS`.
  | { kind: 'disabled'; name: string; reason: string };

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
export function splitConnectorToolName(
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
  // Every non-`mcp__` name at this boundary is a CLI built-in (our host,
  // sandbox and connector tools all arrive `mcp__`-prefixed). The one
  // exception is the CLI's `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` switch, which
  // sends in-process server tools bare; the runner never sets it (the
  // subprocess env is a fixed allowlist in agent-runner-core's
  // proxy-startup.ts), and if it were set every AX tool would be refused
  // here — loudly, not silently. One outside the
  // allowlist fails CLOSED — whether or not it is in `KNOWN_SDK_BUILTINS`, and
  // whatever its spelling, so a built-in a new SDK added (or an alias like
  // `Agent` for `Task`) is refused, not passed on (TASK-1200). Defence in
  // depth behind the `tools` option.
  if (!sdkName.startsWith(MCP_PREFIX) && !isAllowedSdkBuiltin(sdkName)) {
    return { kind: 'disabled', name: sdkName, reason: notAllowedReason(sdkName) };
  }
  // Fallback: pass the name through unchanged. Covers the allowed SDK
  // built-ins (Bash, Read, Edit, …) AND unknown-to-us MCP tools from other
  // servers (`mcp__linear__x`). Host-side subscribers see the verbatim name
  // and decide.
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
