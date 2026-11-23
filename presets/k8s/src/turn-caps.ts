// Boot-time sanity checks on the chart's turn and size caps (spec §3.5, §6.2).
// Pure functions so they can be tested without booting a preset.

/** A turn must end this long before the sandbox pod's own deadline (seconds). */
export const TURN_CAP_MARGIN_SECONDS = 1200;

/**
 * About what the coding agent's e2e service set needs (spec §4.5, §3.5): three
 * GiB of long-running services beside the runner. A planning figure, not a limit.
 */
export const LARGEST_SERVICE_SET_MIB = 3072;

/**
 * Refuse to boot when the turn cap leaves less than 20 minutes before the pod
 * ceiling: a turn that long would be killed with its pod, not ended cleanly.
 */
export function checkTurnCaps(c: { maxTurnMinutes: number; activeDeadlineSeconds: number }): void {
  const needed = c.maxTurnMinutes * 60 + TURN_CAP_MARGIN_SECONDS;
  if (needed > c.activeDeadlineSeconds) {
    throw new Error(
      `chat.maxTurnMinutes=${c.maxTurnMinutes} leaves less than 20 minutes before the sandbox pod ` +
        `deadline (${c.activeDeadlineSeconds}s): a turn that long would be cut off when its pod is reaped. ` +
        `Lower chat.maxTurnMinutes, or raise the pod deadline.`,
    );
  }
}

/** A plain-language warning when the biggest runner plus a service set can't fit one node. */
export function checkNodeFit(c: {
  runnerMaxMiB: number;
  largestServiceSetMiB: number;
  nodeAllocatableMiB?: number | undefined;
}): string | null {
  if (c.nodeAllocatableMiB === undefined) return null;
  const needed = c.runnerMaxMiB + c.largestServiceSetMiB;
  if (needed <= c.nodeAllocatableMiB) return null;
  return (
    `the largest runner (${c.runnerMaxMiB} MiB) plus a service set (${c.largestServiceSetMiB} MiB) ` +
    `needs ${needed} MiB, but a sandbox node has ${c.nodeAllocatableMiB} MiB allocatable. ` +
    `A sandbox sized that large will never schedule. Lower sandbox.runnerMax or use bigger nodes.`
  );
}
