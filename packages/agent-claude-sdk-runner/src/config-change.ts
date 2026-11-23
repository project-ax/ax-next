// ---------------------------------------------------------------------------
// The CLI's configuration is fixed when the session starts (TASK-1217).
//
// The pinned `claude` CLI (2.1.119, SDK 0.2.119) watches its configuration on
// disk and reloads it mid-session. The agent's shell runs as the same user as
// the CLI, so it can change what is watched. Measured in the runner's
// configuration:
//   - Skills: the CLI watches `$CLAUDE_CONFIG_DIR/skills` (and `…/commands`,
//     `<cwd>/.claude/skills`, and each added directory's `.claude/skills`).
//     The projection is locked 0555, but the shell can `chmod -R u+w` it.
//     After that, an edited SKILL.md body is what `Skill(name)` launches, and
//     a planted folder's description reaches the model's skill listing.
//   - Settings: the CLI watches a settings file only if it existed when the
//     CLI started. If one did (even `{}`), a mid-session edit goes live: the
//     planted hooks run on the next turn and Bash sees the planted env. The
//     boot guard (`assertConfigDirFresh`, runner-core) keeps every settings
//     file out at start; this hook is the second layer.
//   - Before a reload, the CLI runs its `ConfigChange` hooks, and one that
//     returns `{ decision: 'block' }` stops it: the tampered body never
//     launches, the planted listing never shows, the planted hooks and env
//     never load. A session nobody tampers with never calls the hook (the
//     watchers ignore what they find at start).
//
// So this hook blocks every change. Nothing legitimate changes the CLI's
// configuration mid-session: both sandboxes write the skills projection
// before the CLI starts, and AX never writes a settings file. The CLI can't
// be told to stop watching (there is no switch; only bare mode turns the
// skills watcher off, and bare mode drops AX's skills too), so blocking the
// reload is the control.
//
// `policy_settings` changes can't be blocked, by the CLI's design. Those files
// are root-owned and outside the sandbox, so the agent can't write them.
//
// The runner's name allowlist (projected-skills.ts) stays: it stops a planted
// folder from launching even if this hook ever regressed.
//
// The log line names only which kind of configuration changed: the CLI's
// `source`, if it is one of the five the CLI documents, else `unknown`. Never
// `file_path`: the agent chose that path.
// ---------------------------------------------------------------------------

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/** The `source` values the pinned SDK declares for a `ConfigChange`. */
const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  'user_settings',
  'project_settings',
  'local_settings',
  'policy_settings',
  'skills',
]);

const BLOCK_REASON = "This session's configuration is fixed when it starts.";

/**
 * An SDK `ConfigChange` hook that blocks every mid-session change to the
 * CLI's configuration (settings and skills) and logs one line naming the
 * source. Any other hook event gets `{}`.
 */
export function createConfigChangeHook(
  log: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'ConfigChange') return {};
    // `source` is the CLI's enum, but checked at runtime anyway: a future CLI
    // could send a new value, and nothing unvetted goes into a log line.
    const source: unknown = input.source;
    const shown = typeof source === 'string' && KNOWN_SOURCES.has(source) ? source : 'unknown';
    try {
      log(
        `runner: blocked a mid-session change to the CLI's ${shown} ` +
          '(its configuration is fixed when the session starts)',
      );
    } catch {
      // The block must not depend on the log line: the CLI counts a hook that
      // throws as "not blocked" and goes ahead with the reload.
    }
    return { decision: 'block', reason: BLOCK_REASON };
  };
}
