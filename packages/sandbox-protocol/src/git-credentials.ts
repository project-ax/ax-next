// ---------------------------------------------------------------------------
// git-credentials — wire skill-declared credentials into the sandbox's `git`
// so `git clone https://<host>/...` over the credential proxy authenticates.
//
// THE BUG THIS FIXES (TASK-14 / CLI-1 part 2). A skill that declares
//   capabilities:
//     allowedHosts: [github.com]
//     credentials:  [{ slot: GIT_TOKEN, kind: api-key }]
// gets its slot stamped into the sandbox env as `GIT_TOKEN=ax-cred:<hex>` (the
// opaque placeholder the credential-proxy substitutes mid-flight). The agent's
// Bash tool can use it explicitly — `curl -H "Authorization: Bearer
// $GIT_TOKEN"`. But `git` does NOT read slot env vars for its auth. With
// `GIT_TERMINAL_PROMPT=0` (git-paranoia) and no credential helper / URL
// userinfo wired in, `git clone https://github.com/...` dies BEFORE sending any
// request:
//   fatal: could not read Username for 'https://github.com': terminal prompts disabled
// — so the proxy never sees a `GET /info/refs` Basic header to substitute into,
// and the egress audit shows `credentialInjected:false` (vacuously — git never
// sent a thing). A live decrypted-bytes trace on the kind cluster confirmed
// this is upstream of the (correct, unit-tested) RequestFramer Basic
// substitution.
//
// THE FIX. Stamp a host-scoped git `url.<base>.insteadOf` rewrite for each
// credentialed allowedHost so git rewrites `https://<host>/` →
// `https://x-access-token:<placeholder>@<host>/` and sends the placeholder as a
// preemptive HTTP Basic password. The proxy's RequestFramer decodes that Basic
// header, substitutes the placeholder for the real value, and re-encodes —
// exactly the path it was built for.
//
// This lives in @ax/sandbox-protocol (the shared contract lib, NOT a plugin) so
// BOTH sandbox backends (@ax/sandbox-k8s pod env, @ax/sandbox-subprocess child
// env) stamp identical `GIT_CONFIG_*` entries. The entries ride into the SDK
// subprocess via the runner's existing `GIT_` env-forwarding prefix — the same
// path TASK-12's `GIT_SSL_CAINFO` and the `safe.directory` config already use.
//
// CAPABILITY MINIMIZATION (invariant I5). The rewrite is scoped to the EXACT
// hosts the skill declared in `allowedHosts` — git only sends the credential to
// those hosts, never broadcast. Defense-in-depth on top of the proxy's own
// per-host allowlist gate. Only the opaque `ax-cred:<hex>` placeholder is ever
// embedded — the real secret stays host-side (I1); we refuse to embed anything
// that isn't exactly that placeholder shape.
// ---------------------------------------------------------------------------

/** `ax-cred:<32-hex>` — the credential-proxy registry's placeholder shape. */
const PLACEHOLDER_RE = /^ax-cred:[0-9a-f]{32}$/;

/**
 * A host must be a bare authority (host[:port]) — no scheme, userinfo, path,
 * whitespace, or control bytes. The orchestrator/skills layer validates
 * allowedHosts upstream and InstalledSkillSchema re-validates at the wire, but
 * this helper re-checks once more: a host carrying '@', '/', ':', CR/LF, or
 * control chars could break out of the `url.<...>.insteadOf` git config key.
 */
const SAFE_HOST_RE = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

/** Username position of the Basic credential. GitHub uses `x-access-token`;
 *  GitLab and most token-auth git hosts accept any non-empty username when a
 *  PAT is the password. The proxy substitutes only the password (the
 *  placeholder), so the exact username is immaterial to substitution. */
const GIT_BASIC_USERNAME = 'x-access-token';

export interface GitCredentialSkill {
  /** Hosts this skill is allowed to reach (`capabilities.allowedHosts`). */
  allowedHosts: string[];
  /** Credential slots this skill declares (`capabilities.credentials`). */
  credentials: Array<{ slot: string }>;
}

export interface GitCredentialEnvInput {
  installedSkills: GitCredentialSkill[];
  /** slot env-name → `ax-cred:<hex>` placeholder. In production this is the
   *  proxy session's `envMap` (the same map stamped onto the sandbox env). */
  envMap: Record<string, string>;
  /** The `GIT_CONFIG_COUNT` already stamped by the backend's git-paranoia env
   *  (e.g. 1 for the `safe.directory` entry). Our entries append after it. */
  baseCount: number;
}

/**
 * Build the extra `GIT_CONFIG_*` entries that wire skill credentials into git's
 * HTTP Basic auth, APPENDED after the backend's existing git config (so the
 * `safe.directory` entry at index 0 is preserved). Returns `{}` when there's
 * nothing to wire — no skills, no credentialed hosts, or no resolvable
 * placeholder. The caller merges these into the sandbox env; the included
 * `GIT_CONFIG_COUNT` is the NEW total and must overwrite the backend's base.
 */
export function buildGitCredentialEnv(
  input: GitCredentialEnvInput,
): Record<string, string> {
  // First credential placeholder per host (first skill / first slot wins on
  // collision — a host can carry only one git credential).
  const hostToPlaceholder = new Map<string, string>();

  for (const skill of input.installedSkills) {
    // The skill's first credential slot whose envMap value is a valid
    // placeholder. Defense-in-depth: refuse anything that isn't exactly
    // `ax-cred:<hex>` so a regressed wiring can't embed a real secret in a URL.
    let placeholder: string | undefined;
    for (const { slot } of skill.credentials) {
      const v = input.envMap[slot];
      if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
        placeholder = v;
        break;
      }
    }
    if (placeholder === undefined) continue; // no usable credential → skip skill

    for (const host of skill.allowedHosts) {
      if (!SAFE_HOST_RE.test(host)) continue; // host re-check (key-injection guard)
      if (hostToPlaceholder.has(host)) continue; // first declaration wins
      hostToPlaceholder.set(host, placeholder);
    }
  }

  if (hostToPlaceholder.size === 0) return {};

  const base = Number.isInteger(input.baseCount) && input.baseCount >= 0 ? input.baseCount : 0;
  const out: Record<string, string> = {};
  let idx = base;
  for (const [host, placeholder] of hostToPlaceholder) {
    // `url."https://x-access-token:<ph>@<host>/".insteadOf = "https://<host>/"`.
    // git rewrites any URL prefixed with the insteadOf value, embedding the
    // userinfo, and sends `Authorization: Basic base64("x-access-token:<ph>")`.
    out[`GIT_CONFIG_KEY_${idx}`] =
      `url.https://${GIT_BASIC_USERNAME}:${placeholder}@${host}/.insteadOf`;
    out[`GIT_CONFIG_VALUE_${idx}`] = `https://${host}/`;
    idx++;
  }
  out['GIT_CONFIG_COUNT'] = String(idx);
  return out;
}
