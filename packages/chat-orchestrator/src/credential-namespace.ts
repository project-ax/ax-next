// ---------------------------------------------------------------------------
// credential-namespace — per-skill credential-slot namespacing (TASK-86).
//
// THE BUG THIS FIXES. Two ACTIVE authored skills that declare the SAME
// credential slot name (e.g. both declare `LINEAR_API_KEY`) used to LOCK THE
// USER OUT OF ALL CHAT: the orchestrator keyed the host-side credential map by
// the BARE slot name, so the second skill collided fatally with the first on
// every turn (`skill-slot-collision`, runner exit 1). The same fatal terminate
// fired when a skill's slot collided with `agent.requiredCredentials`.
//
// THE FIX. Namespace SKILL credential slots per-skill: `skill:<id>:<slot>` in
// the host-side credential map handed to `proxy:open-session`. Two skills' same-
// named slots therefore become two distinct keys → two distinct `ax-cred:<hex>`
// placeholders → no collision. AGENT/trusted base creds
// (`agent.requiredCredentials` / the Anthropic default) keep their BARE key —
// they are trusted, rotation keys off the bare name, and they always win the
// sandbox env stamp.
//
// WHY THE BARE ENV-VAR NAME STILL WORKS FOR THE SKILL. The credential-proxy
// substitution is VALUE-based: it replaces the opaque `ax-cred:<hex>`
// placeholder wherever it appears in egress, regardless of which env-var name
// carried it (see @ax/credential-proxy registry.ts replaceAll). So the env-var
// NAME in the sandbox is only a vehicle for the placeholder. After the proxy
// resolves the namespaced credential map and returns a namespaced envMap, we
// PROJECT it back to BARE env-var names for the flat sandbox env — so the skill
// reads `$LINEAR_API_KEY`, not `$skill:linear:LINEAR_API_KEY` (which isn't even
// a valid env-var name).
//
// SECURITY (invariant I5 — capabilities explicit and minimized). A skill slot
// whose bare name matches a TRUSTED base name (e.g. a skill declaring
// `ANTHROPIC_API_KEY`) must NEVER overwrite the trusted credential in the
// sandbox env. The projection makes the TRUSTED bare name win; the skill's own
// namespaced credential still exists in the proxy map for the skill's own egress
// (e.g. git wiring), but it can't hijack the trusted env var. This preserves the
// old guarantee as a benign no-op suppression instead of a fatal lockout.
// ---------------------------------------------------------------------------

/** Per-skill credential env-name scheme — the SINGLE source of the namespacing
 *  format used by the proxy credential map, the credential-binding ref, and the
 *  env projection. `skill:<skillId>:<slot>`. */
export function skillCredentialEnvName(skillId: string, slot: string): string {
  return `skill:${skillId}:${slot}`;
}

/** A valid POSIX-ish env var name: a skill's BARE slot the projection may stamp
 *  into the flat sandbox env. The manifest parser already constrains skill slots
 *  to SCREAMING_SNAKE (`^[A-Z][A-Z0-9_]{0,63}$`); we re-check here so a drifted
 *  upstream can't smuggle an arbitrary env-var name into the sandbox. Trusted
 *  base names (e.g. ANTHROPIC_API_KEY) match the same shape. */
const BARE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The credential-proxy registry's placeholder shape (`ax-cred:<32-hex>`). */
const PLACEHOLDER_RE = /^ax-cred:[0-9a-f]{32}$/;

export interface ProjectEnvMapInput {
  /** The namespaced envMap the proxy returned: key → `ax-cred:<hex>` placeholder.
   *  Keys are either a BARE trusted name (agent default) or a namespaced skill
   *  key (`skill:<id>:<slot>`). */
  namespacedEnvMap: Record<string, string>;
  /** Bare env-var names owned by a TRUSTED source (agent.requiredCredentials /
   *  Anthropic default). These ALWAYS win the flat-env stamp — a skill can never
   *  overwrite them. */
  trustedBareNames: ReadonlySet<string>;
  /** Ordered (highest precedence first) skill-slot descriptors so the projection
   *  is deterministic when two skills share a bare slot name: the first wins the
   *  flat-env stamp, the rest are dropped (their credential still reaches the
   *  proxy via its own placeholder + per-skill git wiring). Each maps the
   *  namespaced key back to the bare env-var name the skill expects. */
  skillSlots: ReadonlyArray<{ envName: string; bareSlot: string }>;
}

/**
 * Project the proxy's namespaced envMap back to the BARE-keyed env map that gets
 * stamped flat into the sandbox process env. Precedence:
 *
 *   1. TRUSTED bare names always win (copied verbatim from namespacedEnvMap).
 *   2. Among skill slots sharing a bare name, the FIRST in `skillSlots` wins;
 *      later ones are dropped (their credential is still live in the proxy for
 *      their own egress — git wiring uses the per-skill placeholder directly).
 *   3. A skill slot whose bare name collides with a trusted name is dropped (the
 *      trusted credential wins; the skill can't hijack it).
 *
 * Defensive: SKILL-slot values must be `ax-cred:<hex>` placeholders (UNTRUSTED
 * source — a malformed one is skipped, fail-closed: fewer env vars, never a
 * smuggled name/secret). TRUSTED base values pass through verbatim (the
 * orchestrator built them and the proxy resolved them); only their bare-name
 * shape is re-checked. Either way a malformed BARE NAME is never stamped.
 */
export function projectEnvMapToBareNames(
  input: ProjectEnvMapInput,
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Trusted bare names first — they own their slot and can't be displaced.
  //    Value passes verbatim (trusted); only the name shape is re-validated.
  for (const name of input.trustedBareNames) {
    const v = input.namespacedEnvMap[name];
    if (typeof v === 'string' && BARE_ENV_NAME_RE.test(name)) {
      out[name] = v;
    }
  }

  // 2. Skill slots in precedence order — first writer wins the bare name; never
  //    overwrite a trusted name already stamped above. Skill values are
  //    UNTRUSTED, so the placeholder shape is enforced.
  for (const { envName, bareSlot } of input.skillSlots) {
    if (!BARE_ENV_NAME_RE.test(bareSlot)) continue; // smuggled name guard
    if (input.trustedBareNames.has(bareSlot)) continue; // trusted wins (rule 3)
    if (Object.prototype.hasOwnProperty.call(out, bareSlot)) continue; // first wins
    const v = input.namespacedEnvMap[envName];
    if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
      out[bareSlot] = v;
    }
  }

  return out;
}
