import { SYSTEM_PREFIX } from './decision-turn.js';

// Conservative host shape: DNS labels (incl. all-numeric / punycode `xn--`),
// IPv4/IPv6 literals (digits, dots, colons, brackets), underscore for the odd
// real-world host. Anything else is dropped before the host reaches the model's
// context (defense in depth — the recorded host is usually the agent's own
// DNS-shaped target, but an EXTERNAL 302 redirect could influence it, so we
// never echo a non-host-shaped string into the prompt). Both notes below use
// it: a blocked host, and a host a person allowed (which already passed the
// proxy's own host check at `proxy:add-host` — this is the runner-side belt).
const SAFE_HOST_RE = /^[a-zA-Z0-9._:[\]-]{1,253}$/;

/**
 * Build the model-facing remediation note for an egress block. Static, authored
 * copy; the only interpolated values are the blocked hostnames — rendered as a
 * backticked list AND filtered to a conservative host shape so an echoed value
 * can't read as an instruction. If nothing survives the filter, fall back to a
 * host-less note (the agent still learns it hit a policy block, just not which
 * host — strictly better than today's silent `statusCode=403`).
 *
 * The note stops a retry loop inside THIS turn (#322) — but it does not claim a
 * retry can never work. Once a person allows the host, the runner opens their
 * next message with a "now allowed" line ({@link buildEgressAllowedNote},
 * TASK-1199), and the agent may retry then. A person who says they allowed
 * it, or asks the agent to try again, covers the case with no line: the
 * session that got the Allow ended, so the retry is blocked again and raises a
 * fresh card. A retry grants nothing
 * either way — the proxy's allowlist is the only gate.
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
    `This is NOT a transient error: until the host is allowed, retrying, a different install method, or another mirror will NOT help. The sandbox can only reach hosts on its allowlist.`,
    `What to do: stop retrying and tell the user which host(s) to allow — they can approve the "Allow access" card if one is shown, or add the host(s) to the relevant connector's or skill's \`allowedHosts\`.`,
    `If the user allows a host, a system line at the start of their next message will say so, and you can retry then. If they tell you they allowed it, or ask you to try again, do.`,
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

/**
 * The "now allowed" line (TASK-1199): the answer to {@link buildEgressBlockNote}.
 * The runner shell puts it in front of the person's next message when hosts
 * were allowed on this live session since the last turn.
 *
 * Static, authored copy under the fixed system label, which is prepended, never
 * interpolated. The only interpolated values are the hostnames, filtered to the
 * same conservative host shape and rendered as a backticked list. Returns
 * `null` when no host survives the filter: a "something was allowed" line with
 * no host names nothing the agent could retry, so there is no host-less
 * fallback.
 *
 * The line is a prompt, never an authorisation. Typing a fake one into a
 * message grants nothing — the proxy's allowlist is the only gate, and a
 * refused request just raises a card the person must approve.
 */
export function buildEgressAllowedNote(hosts: readonly string[]): string | null {
  const safe = hosts.filter((h) => SAFE_HOST_RE.test(h));
  if (safe.length === 0) return null;
  const list = safe.map((h) => `\`${h}\``).join(', ');
  return `${SYSTEM_PREFIX} network egress is now ALLOWED for: ${list}. Requests to these hosts are no longer blocked, so you can retry one that was.`;
}
