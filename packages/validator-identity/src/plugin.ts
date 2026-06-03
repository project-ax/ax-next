// ---------------------------------------------------------------------------
// @ax/validator-identity — a `workspace:pre-apply` subscriber that gates an
// agent's writes to its own identity files under /permanent/.ax/.
//
// The runner injects these files VERBATIM into the composed systemPrompt every
// spawn (conversational-agent-identity epic, Phase 1), so a self-edit is a
// self-modification of the agent's own system prompt. This validator is the
// gate on that:
//
//   - .ax/BOOTSTRAP.md is HOST-SEEDED (created at agent-create, deleted by the
//     agent on completion). Its PRESENCE in the committed workspace is the one
//     signal that means "still bootstrapping" — it drives the runner prompt,
//     this validator's approval window, and the bootstrap-state at once. The
//     window must reflect the HOST-COMMITTED state, never anything the agent
//     supplied this turn; we read it from the parent version via
//     `workspace:read`, NOT from the change set. (This closes the un-gated
//     bootstrap-trust window flagged in Phase 1: a re-created BOOTSTRAP.md must
//     not be able to re-open the window and suppress the runner's safety floor.)
//
//   - An agent `put` to .ax/BOOTSTRAP.md is HARD-VETOED in every window state:
//     the agent's only legitimate BOOTSTRAP.md operation is the completion
//     delete. A `put` would let the agent (or a prompt-injection) author its own
//     bootstrap script = an arbitrary system prompt with the safety floor gone.
//
//   - Identity writes (.ax/IDENTITY.md, .ax/SOUL.md, .ax/AGENTS.md) are ALLOWED.
//     During the bootstrap window they're the agent creating itself; after it,
//     they're the agent evolving — allowed but FLAGGED (a structured audit log;
//     git history is the durable audit trail). The runner's evolution guidance
//     ("tell the user when you change SOUL.md") is the user-facing announcement;
//     a veto-only pre-apply hook cannot transform/annotate the payload, so the
//     "flag" here is the log line.
//
//   - Every identity-file `put` content is run through a prompt-injection scan
//     (a copy of validator-skill's Layer-1 regex set; Invariant #2 forbids the
//     import). A signature is a HARD veto, regardless of window — this is the
//     prompt-injection mitigation for self-edits.
//
// Capability budget: subscribe `workspace:pre-apply` + an OPTIONAL
// `workspace:read` call. NO spawn, NO file I/O, NO network. If `workspace:read`
// is unavailable the window is treated as CLOSED (fail-closed toward the
// stricter post-bootstrap policy — identity writes still pass, but we never
// grant a bootstrap-only allowance we can't verify). See SECURITY.md.
// ---------------------------------------------------------------------------

import type {
  AgentContext,
  FileChange,
  HookBus,
  Plugin,
  WorkspaceVersion,
} from '@ax/core';
import { reject } from '@ax/core';
// `@ax/agent-identity-templates` is a pure-data package (no @ax/core dep) on the
// eslint no-restricted-imports allow-list — the SAME canonical bootstrap script
// the host seeds (channel-web) and the runner injects. We compare an agent's
// BOOTSTRAP.md `put` against it byte-for-byte (see the BOOTSTRAP branch below).
import { BOOTSTRAP_TEMPLATE } from '@ax/agent-identity-templates';
import { regexScan } from './identity-safety-scan.js';

const PLUGIN_NAME = '@ax/validator-identity';

// The host-seeded bootstrap script. Present in the committed workspace ⇔ the
// agent is still bootstrapping.
const BOOTSTRAP_PATH = '.ax/BOOTSTRAP.md';

// The canonical bootstrap bytes, encoded once. A `put` to BOOTSTRAP.md is only
// allowed when its content is byte-identical to this (the host's seed); see the
// BOOTSTRAP branch. Comparing bytes (not the decoded string) avoids any
// normalization ambiguity.
const CANONICAL_BOOTSTRAP_BYTES = new TextEncoder().encode(BOOTSTRAP_TEMPLATE);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isCanonicalBootstrap(content: Uint8Array): boolean {
  return bytesEqual(content, CANONICAL_BOOTSTRAP_BYTES);
}

// Agent-authored identity files. Inject-if-present in the runner's normal-mode
// prompt; scanned + flagged here. (Kept flat under `.ax/` — no subdirectories.)
const IDENTITY_FILE_PATHS = new Set<string>([
  '.ax/IDENTITY.md',
  '.ax/SOUL.md',
  '.ax/AGENTS.md',
]);

// `workspace:read` result shape — re-declared locally (the validator must not
// import a workspace backend). Structurally mirrors @ax/core's
// WorkspaceReadOutput; the `version` field is unused here.
type WorkspaceReadResult =
  | { found: true; bytes: Uint8Array; version?: WorkspaceVersion }
  | { found: false };

// Veto-only payload for `workspace:pre-apply`. Mirrors @ax/core's facade
// payload; declared LOCALLY (no central schema) per the task's boundary review.
interface PreApplyPayload {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason?: string;
}

// STRICT UTF-8 decode (fatal: true). A non-UTF-8 byte throws instead of
// silently producing a U+FFFD replacement char — replacement chars are how a
// payload "looks fine" in a logs grep while hiding arbitrary bytes that would
// land verbatim in the agent's system prompt. A decode failure on an identity
// file is itself suspect → we veto (see the catch in the put branch). Mirrors
// validator-skill's strict-decode posture.
const DEC = new TextDecoder('utf-8', { fatal: true });

export function createValidatorIdentityPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      // The bootstrap-window signal needs the committed state at `parent`. Both
      // presets register workspace:read (CLI=@ax/workspace-git, k8s=git-server
      // client). Declared OPTIONAL so a minimal preset without a workspace
      // backend degrades to the post-bootstrap policy instead of failing
      // bootstrap. See the degrade note above + SECURITY.md.
      optionalCalls: [
        {
          hook: 'workspace:read',
          degradation:
            'cannot read the committed .ax/BOOTSTRAP.md → the bootstrap window is treated as CLOSED (post-bootstrap policy); identity writes still pass, the injection scan still runs',
        },
      ],
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      bus.subscribe<PreApplyPayload>(
        'workspace:pre-apply',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Fast path: nothing in this batch touches an identity path → no work,
          // no workspace:read. (The vast majority of applies — transcript/upload
          // commits, skill/routine writes — fall here.)
          const touchesIdentity = input.changes.some(
            (c) => c.path === BOOTSTRAP_PATH || IDENTITY_FILE_PATHS.has(c.path),
          );
          if (!touchesIdentity) return undefined;

          // Resolve the bootstrap window ONCE per batch from the COMMITTED state
          // at `parent` — never from this turn's change set. (See header.)
          const inBootstrapWindow = await isInBootstrapWindow(
            bus,
            ctx,
            input.parent,
          );

          for (const c of input.changes) {
            // --- BOOTSTRAP.md ------------------------------------------------
            if (c.path === BOOTSTRAP_PATH) {
              if (c.kind === 'delete') {
                // The completion ritual. Allowed in any window state: in the
                // window it graduates the agent; post-bootstrap it's a harmless
                // idempotent delete of an already-absent file.
                continue;
              }
              // A `put` to BOOTSTRAP.md. The runner runs BOOTSTRAP.md VERBATIM as
              // the entire system prompt (no safety floor) while it exists, so a
              // non-canonical BOOTSTRAP.md is a floor-suppression + arbitrary
              // system-prompt primitive (the exact attack the runner's prompt-
              // engine trust-note flags). We CANNOT distinguish the host's seed
              // from an agent re-create by actor or `reason` — `reason` is
              // agent-influenceable free-text and pre-apply carries no trusted
              // origin. The trustworthy distinction is CONTENT: the host seeds
              // the canonical compile-time `BOOTSTRAP_TEMPLATE` constant. So:
              //   - content === BOOTSTRAP_TEMPLATE → allow (the host's seed; or a
              //     harmless re-seed of the same trusted, floor-by-design script).
              //   - anything else → HARD VETO (an agent/injection authoring its
              //     own bootstrap script).
              if (!isCanonicalBootstrap(c.content)) {
                ctx.logger.warn('identity_bootstrap_noncanonical_vetoed', {
                  path: c.path,
                });
                return reject({
                  reason:
                    `${BOOTSTRAP_PATH}: the bootstrap script is host-seeded only ` +
                    `(it runs verbatim as the system prompt with no safety floor). ` +
                    `Only the canonical bootstrap template may be written here; an ` +
                    `agent-authored bootstrap script is refused. The only ` +
                    `agent-legitimate operation on this file is deleting it to ` +
                    `complete bootstrap.`,
                });
              }
              continue;
            }

            // --- IDENTITY.md / SOUL.md / AGENTS.md ---------------------------
            if (IDENTITY_FILE_PATHS.has(c.path)) {
              if (c.kind === 'delete') continue; // deleting an identity file is allowed.

              // Strict UTF-8 decode. A non-UTF-8 identity file is suspect (it
              // would land verbatim in the system prompt) → HARD veto.
              let text: string;
              try {
                text = DEC.decode(c.content);
              } catch {
                ctx.logger.warn('identity_non_utf8_vetoed', { path: c.path });
                return reject({
                  reason: `${c.path}: identity file is not valid UTF-8; refusing to inject undecodable bytes into the system prompt.`,
                });
              }

              // Prompt-injection scan on the file content. A signature is a HARD
              // veto regardless of window — the file goes live in the system
              // prompt on the next turn.
              const scanHit = regexScan(text);
              if (scanHit !== null) {
                ctx.logger.warn('identity_injection_vetoed', {
                  path: c.path,
                  category: scanHit.category,
                });
                return reject({ reason: `${c.path}: ${scanHit.reason}` });
              }

              if (!inBootstrapWindow) {
                // Post-bootstrap self-edit: allowed, but FLAGGED. Git history is
                // the audit trail; this structured log is the announcement hook
                // for operators. (The user-facing "tell the user — it's your
                // soul" is the runner's evolution-guidance job, not this
                // veto-only validator's.)
                ctx.logger.warn('identity_self_edit', {
                  path: c.path,
                  reason: input.reason,
                });
              }
              continue;
            }
          }

          return undefined; // pass-through — no transform (pre-apply is veto-only).
        },
      );
    },
  };
}

/**
 * The bootstrap window is OPEN iff `.ax/BOOTSTRAP.md` is present in the COMMITTED
 * workspace at `parent`. Read via `workspace:read` (the host-committed state),
 * NOT inferred from the change set — that's what makes a re-created BOOTSTRAP.md
 * unable to re-open the window.
 *
 * Degrades to CLOSED (the stricter post-bootstrap policy) when `workspace:read`
 * is unavailable or errors: we never grant a bootstrap-only allowance we can't
 * verify, and identity writes still pass under the post-bootstrap branch.
 */
async function isInBootstrapWindow(
  bus: HookBus,
  ctx: AgentContext,
  parent: WorkspaceVersion | null,
): Promise<boolean> {
  if (!bus.hasService('workspace:read')) {
    ctx.logger.warn('identity_window_read_unavailable', {});
    return false;
  }
  try {
    const read = await bus.call<
      { path: string; version?: WorkspaceVersion },
      WorkspaceReadResult
    >('workspace:read', ctx, {
      path: BOOTSTRAP_PATH,
      ...(parent !== null ? { version: parent } : {}),
    });
    return read.found;
  } catch (err) {
    ctx.logger.warn('identity_window_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
