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
 * stamped flat into the sandbox process env.
 *
 * NON-DESTRUCTIVE passthrough: the proxy's envMap can carry entries that are
 * NOT credential slots (e.g. a test-proxy that feeds a stub-runner script var,
 * or any future proxy-injected env). Every entry whose KEY is already a valid
 * BARE env-var name passes through VERBATIM — this preserves trusted base
 * credentials (their key is bare) AND any non-credential var. Only the
 * NAMESPACED skill keys (`skill:<id>:<slot>`, which contain `:` and so fail the
 * bare-name shape) are excluded from passthrough and instead re-projected to
 * their bare slot name below.
 *
 * Skill-slot projection precedence (deterministic):
 *   1. A TRUSTED bare name (already passed through) is never overwritten — the
 *      trusted credential wins; a skill can't hijack it.
 *   2. Among skill slots sharing a bare name, the FIRST in `skillSlots` wins;
 *      the rest are dropped (their credential is still live in the proxy for
 *      their own egress — git wiring uses the per-skill placeholder directly).
 *
 * Defensive: SKILL-slot values must be `ax-cred:<hex>` placeholders (UNTRUSTED
 * source — a malformed one is skipped, fail-closed). A malformed BARE slot name
 * is never stamped (smuggled-env-name guard).
 */
export function projectEnvMapToBareNames(
  input: ProjectEnvMapInput,
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Passthrough — every entry already keyed by a valid bare env-var name.
  //    This carries trusted base credentials (bare key) AND any non-credential
  //    var the proxy injected. Namespaced `skill:<id>:<slot>` keys contain `:`
  //    and fail BARE_ENV_NAME_RE, so they're naturally excluded here and
  //    re-projected to their bare slot below.
  for (const [name, v] of Object.entries(input.namespacedEnvMap)) {
    if (typeof v === 'string' && BARE_ENV_NAME_RE.test(name)) {
      out[name] = v;
    }
  }

  // 2. Skill slots in precedence order — first writer wins the bare name; never
  //    overwrite a name already stamped above (a trusted bare credential, an
  //    earlier skill, or a passthrough var). Skill values are UNTRUSTED, so the
  //    placeholder shape is enforced.
  for (const { envName, bareSlot } of input.skillSlots) {
    if (!BARE_ENV_NAME_RE.test(bareSlot)) continue; // smuggled name guard
    // SECURITY: a skill can NEVER claim a trusted bare name, even if step-1
    // passthrough didn't stamp it (e.g. the proxy omitted the trusted value).
    // Explicit guard over the implicit "already stamped" check below.
    if (input.trustedBareNames.has(bareSlot)) continue; // trusted wins, always
    if (Object.prototype.hasOwnProperty.call(out, bareSlot)) continue; // first wins
    const v = input.namespacedEnvMap[envName];
    if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
      out[bareSlot] = v;
    }
  }

  return out;
}
