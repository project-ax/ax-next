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
