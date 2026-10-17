import type { RunnerEnv } from '@ax/agent-runner-core';

/**
 * The roots the tool policy's re-rooter recognizes: the agent's cwd/HOME and
 * the session scratch tier. Under any recognized root, a top-level `.ax/`,
 * `.claude/` or `CLAUDE.md` is RE-ROOTED onto the governed `/agent` tier
 * (`findGovernedSegment` in `@ax/agent-runner-core`'s governed-paths.ts).
 *
 * W2: shared folders (`env.sharedFolders`) are deliberately NOT listed. A
 * `.ax/` or `.claude/` path inside a shared folder is an ordinary project file
 * other agents share; listing the folder here would silently redirect it onto
 * this agent's own governed tier — the opposite of what a shared folder is.
 * The aisdk file tools already accept any absolute path (`builtins.ts`
 * `resolvePath`), so a shared folder needs no grant at all. (Decision AXWM-3;
 * the spec §3.6 wording was corrected.)
 */
export function policyRecognizedRoots(
  homeDir: string,
  env: Pick<RunnerEnv, 'ephemeralRoot'>,
): string[] {
  return [homeDir, env.ephemeralRoot].filter((r): r is string => r !== undefined);
}
