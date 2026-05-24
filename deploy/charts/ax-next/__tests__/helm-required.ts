// Shared helm-presence gate for the chart-render guard suites.
//
// Both render.test.ts and env-shape.test.ts shell out to `helm template` to
// exercise the chart's render-time `{{ fail }}` guards (single-replica chat
// guard, gitServer.storage-required, workspace.backend wiring,
// terminationGracePeriodSeconds floor). When helm is NOT on PATH every assertion
// is `describe.skip`-ped with a friendly warning — convenient for local dev on a
// box without helm, but a trap for CI: a green run no longer proves the guards
// ran.
//
// `AX_REQUIRE_HELM=1` flips that. In CI's dedicated `helm-render` lane we set it
// so a MISSING helm becomes a hard failure instead of a silent skip — that's the
// regression guard for TASK-1's whole reason to exist ("the guards were silently
// skipped in CI"). Local runs leave it unset and keep the friendly skip.

/** Truthy-ish env values that opt into strict mode. `0`/`false`/`""`/unset = off. */
function isStrictValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

export type HelmGate =
  | { mode: 'run'; helm: string }
  | { mode: 'skip' }
  | { mode: 'require-missing' };

/**
 * Pure decision: given whether helm was found and the raw `AX_REQUIRE_HELM`
 * value, decide whether the suite should run, silently skip, or hard-fail
 * because helm is required-but-absent. No I/O — unit-testable without helm.
 */
export function resolveHelmGate(
  helm: string | null,
  requireHelmRaw: string | undefined,
): HelmGate {
  if (helm) return { mode: 'run', helm };
  if (isStrictValue(requireHelmRaw)) return { mode: 'require-missing' };
  return { mode: 'skip' };
}

/** The message a `require-missing` gate fails with. Names the env + the fix. */
export const HELM_REQUIRED_MESSAGE =
  'AX_REQUIRE_HELM is set but `helm` is not on PATH — the chart-render guard ' +
  'suite cannot run. This lane exists so the guards are NOT silently skipped ' +
  'in CI; install helm (CI: the helm-render job) or unset AX_REQUIRE_HELM for ' +
  'local skip behavior.';
