// ---------------------------------------------------------------------------
// PostToolUse → event.tool-post-call IPC adapter.
//
// Wraps our fire-and-forget post-call event into claude-agent-sdk's hook
// callback shape. Registered by the runner in `hooks.PostToolUse` so the
// host observes every completed tool invocation (audit log, chat
// orchestrator, transcript rendering — all downstream of this signal).
//
// Phase 3 simplification: this hook USED to also drive workspace-diff
// observation (record file-mutating SDK tool outputs into a per-turn
// diff accumulator, drained at turn end). That's gone — the runner now
// detects workspace changes via `git status` against /permanent at turn
// end (`commitTurnAndBundle` in main.ts). git status catches ALL
// writes regardless of tool, including the Bash deletes and MCP writes
// the legacy observer missed. PostToolUse only emits the audit event
// now; nothing else.
//
// Key properties:
//   * Fire-and-forget: we `void` the event promise. A dropped event
//     must NEVER stall the SDK's turn loop — dropped audit events are
//     recoverable; hung turns are not.
//   * Narrow on hook_event_name: matchers usually filter these, but the
//     defensive narrow keeps a mis-wired hook from spraying bad payloads.
//   * Disabled tool names don't emit. We don't want the host's subscriber
//     chain acting on tool activity that shouldn't have been possible in
//     the first place — the belt-and-braces mirror of can-use-tool.ts.
// ---------------------------------------------------------------------------

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreatePostToolUseHookOptions {
  client: IpcClient;
  /**
   * Drains the hosts this session was egress-blocked on (agent-visible egress
   * note). When provided, after a `Bash` tool runs the hook drains any
   * allowlist blocks and injects an actionable remediation note into the
   * agent's context — otherwise the agent sees only a cryptic `statusCode=403`
   * from its own `npx`/curl and flails. Optional: absent in deployments/tests
   * with no egress proxy (the note is simply not produced). MUST resolve to `[]`
   * rather than throw — a best-effort note must never break the turn loop.
   */
  drainEgressBlocks?: () => Promise<string[]>;
}

// Conservative host shape: DNS labels (incl. all-numeric / punycode `xn--`),
// IPv4/IPv6 literals (digits, dots, colons, brackets), underscore for the odd
// real-world host. Anything else is dropped before the host reaches the model's
// context (defense in depth — the recorded host is usually the agent's own
// DNS-shaped target, but an EXTERNAL 302 redirect could influence it, so we
// never echo a non-host-shaped string into the prompt).
const SAFE_HOST_RE = /^[a-zA-Z0-9._:[\]-]{1,253}$/;

/**
 * Build the model-facing remediation note for an egress block. Static, authored
 * copy; the only interpolated values are the blocked hostnames — rendered as a
 * backticked list AND filtered to a conservative host shape so an echoed value
 * can't read as an instruction. If nothing survives the filter, fall back to a
 * host-less note (the agent still learns it hit a policy block, just not which
 * host — strictly better than today's silent `statusCode=403`).
 */
export function buildEgressBlockNote(hosts: string[]): string {
  const safe = hosts.filter((h) => SAFE_HOST_RE.test(h));
  const lines: string[] = [];
  if (safe.length > 0) {
    const list = safe.map((h) => `\`${h}\``).join(', ');
    lines.push(`⚠️ Network egress was BLOCKED by policy for: ${list}.`);
  } else {
    lines.push(`⚠️ Network egress was BLOCKED by policy for a host this turn.`);
  }
  lines.push(
    `This is NOT a transient error — retrying, a different install method, or another mirror will NOT help. The sandbox can only reach hosts on its allowlist.`,
    `What to do: stop retrying and tell the user which host(s) to allow — they can approve the "Allow access" card if one is shown, or add the host(s) to the relevant connector's or skill's \`allowedHosts\`.`,
  );
  // The dominant case: a prebuilt-binary CLI (an npm wrapper) downloading from a
  // GitHub release. The agent usually sees github.com blocked first, before the
  // redirect target — so proactively name BOTH hosts it will need.
  const githubish = safe.some(
    (h) => h === 'github.com' || h.endsWith('.githubusercontent.com'),
  );
  if (githubish) {
    lines.push(
      `Heads-up: prebuilt-binary CLIs (npm wrappers like @schpet/linear-cli, esbuild) download from GitHub releases — those need BOTH \`github.com\` AND \`release-assets.githubusercontent.com\` in allowedHosts.`,
    );
  }
  return lines.join(' ');
}

export function createPostToolUseHook(
  opts: CreatePostToolUseHookOptions,
): HookCallback {
  return async (input, toolUseID) => {
    // Defensive narrow — SDK matchers should route only PostToolUse here,
    // but we don't want a misconfigured hook map to leak a different
    // payload shape onto the wire.
    if (input.hook_event_name !== 'PostToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      return {};
    }

    // Fire-and-forget. Failures here must not stall the runner's turn loop;
    // dropping an audit event is recoverable, a hung turn is not.
    void opts.client
      .event('event.tool-post-call', {
        call: {
          id: toolUseID ?? '',
          name: klass.axName,
          input: input.tool_input,
        },
        output: input.tool_response,
      })
      .catch(() => {
        /* swallow — fire-and-forget */
      });

    // Agent-visible egress-block note. `Bash` is the one tool through which the
    // agent initiates sandbox egress (npx / curl / git / pip), so we drain its
    // session's allowlist blocks right after it runs and inject a remediation
    // note. The block fires synchronously during the command (the proxy denies
    // the CONNECT before the command returns), so by here it's already buffered.
    if (
      opts.drainEgressBlocks !== undefined &&
      klass.kind === 'builtin' &&
      klass.axName === 'Bash'
    ) {
      let hosts: string[] = [];
      try {
        hosts = await opts.drainEgressBlocks();
      } catch {
        // A best-effort note must never break the turn loop — degrade to silent.
        hosts = [];
      }
      if (hosts.length > 0) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: buildEgressBlockNote(hosts),
          },
        };
      }
    }

    return {};
  };
}
