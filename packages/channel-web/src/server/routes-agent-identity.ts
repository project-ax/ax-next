import {
  PluginError,
  isRejection,
  makeAgentContext,
  makeReqId,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

// ---------------------------------------------------------------------------
// GET/PUT /admin/agents/:id/identity — the file-based admin identity editor
// (TASK-142, conversational-agent-identity Phase 4).
//
// The admin AgentForm replaces the single "system prompt" textarea with three
// fields — Identity / Soul / Operating instructions (advanced) — backed by the
// agent's `.ax/` files. These routes are the BFF for that editor:
//
//   GET  → reads `.ax/IDENTITY.md` + `.ax/SOUL.md` + `.ax/AGENTS.md` via
//          `workspace:read` (each missing file maps to '').
//   PUT  → writes the three files via `workspace:apply` — which fires
//          `workspace:pre-apply` → `@ax/validator-identity` (the injection scan
//          + bootstrap-window policy). The advanced "Operating instructions"
//          field maps to `.ax/AGENTS.md` and is OPT-IN: a non-empty value is
//          written, an empty value DELETES the file (never creates an empty one).
//
// Boundary review: no new service-hook signature — these are HTTP routes
// calling the EXISTING `workspace:read` / `workspace:apply` hooks (the same
// pattern as routes-agent-bootstrap). The plugin manifest's `calls` gains
// `workspace:read` (apply is already declared).
//
// Security review (see PR body):
//   - Sandbox: the route writes ONLY `.ax/IDENTITY.md` / `.ax/SOUL.md` /
//     `.ax/AGENTS.md` — a HARDCODED three-path allow-list, NEVER a caller-
//     supplied path (the client sends file *contents*). The `@ax/core` apply
//     facade additionally filters `workspace:pre-apply` to `.ax/**`. The route
//     CANNOT write `.ax/BOOTSTRAP.md` (the floor-suppression primitive) — it's
//     not in the allow-list, and validator-identity hard-vetoes a non-canonical
//     BOOTSTRAP.md put as defense-in-depth. The workspace ctx carries the
//     agent's REAL owner id (never a synthetic actor).
//   - Injection: the three bodies are UNTRUSTED browser strings. They flow only
//     into `workspace:apply` (→ validator-identity's injection scan, the gate
//     this exists for) and ultimately into the agent's OWN system prompt next
//     spawn — never interpolated into a shell, SQL, path, or HTML by this route.
//     Each field is size-bounded (32 KiB, matching the old admin systemPrompt
//     cap). The route does NOT bypass the validator: it goes through the
//     standard apply facade.
//   - ACL: the authenticated userId is server-forced from the auth cookie;
//     `agents:resolve(agentId, userId)` gates access (owner / team-member only →
//     403 otherwise). CSRF is enforced by @ax/http-server on PUT.
// ---------------------------------------------------------------------------

// The three editable identity files, mapped to the editor's fields. BOOTSTRAP.md
// is deliberately NOT here — it is host-seeded only and a `put` is vetoed.
const IDENTITY_PATH = '.ax/IDENTITY.md';
const SOUL_PATH = '.ax/SOUL.md';
const AGENTS_PATH = '.ax/AGENTS.md';

// Per-field byte cap — matches the legacy admin systemPrompt cap (32 KiB). A
// real identity file is a few KiB; this bounds a runaway/hostile paste.
const MAX_FIELD_BYTES = 32 * 1024;

// Locally-declared hook payload shapes (Invariant #2 — the hook bus is the
// contract; each side names only the shape it needs).
interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}
interface AgentsResolveInput {
  agentId: string;
  userId: string;
}
interface AgentsResolveOutput {
  agent: { id: string; ownerId: string; ownerType: 'user' | 'team' };
}
type WorkspaceReadResult =
  | { found: true; bytes: Uint8Array }
  | { found: false };
interface WorkspaceReadInput {
  path: string;
}
interface WorkspaceApplyChange {
  path: string;
  kind: 'put' | 'delete';
  content?: Uint8Array;
}
// `parent` is the storage-agnostic version token the apply CAS-checks against
// (opaque — never resolved as a path). null = "the workspace has no commits
// yet" (a brand-new agent); a token = an existing head. We start at null and
// retry once with the tier's actual head on a CAS miss (see save()).
interface WorkspaceApplyInput {
  changes: WorkspaceApplyChange[];
  parent: string | null;
  reason?: string;
}

// PUT body: the three editor fields. `operating` is optional/opt-in (→
// `.ax/AGENTS.md`). Each is length-bounded; unknown body fields are stripped.
const IdentityBody = z
  .object({
    identity: z.string().max(MAX_FIELD_BYTES, 'identity too large'),
    soul: z.string().max(MAX_FIELD_BYTES, 'soul too large'),
    operating: z.string().max(MAX_FIELD_BYTES, 'operating too large').optional(),
  })
  .strip();

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

// Extract the storage tier's actual head from a `parent-mismatch` PluginError's
// `cause.actualParent` (the established workspace CAS contract — see the backfill
// + git-engine `parentMismatch`). Returns the value (a version token or null)
// when the error is a parent-mismatch carrying it, or the sentinel
// NO_ACTUAL_PARENT so the caller knows NOT to retry.
const NO_ACTUAL_PARENT = Symbol('no-actual-parent');
function actualParentFromMismatch(
  err: unknown,
): string | null | typeof NO_ACTUAL_PARENT {
  if (!(err instanceof PluginError) || err.code !== 'parent-mismatch') {
    return NO_ACTUAL_PARENT;
  }
  const cause = err.cause as { actualParent?: string | null } | undefined;
  if (cause === undefined || !('actualParent' in cause)) return NO_ACTUAL_PARENT;
  return cause.actualParent ?? null;
}

export interface AgentIdentityRoutesDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function makeAgentIdentityHandlers(deps: AgentIdentityRoutesDeps) {
  const { bus, initCtx } = deps;

  /** Authenticate, then ACL-gate the agent via `agents:resolve` under the
   * authenticated user. Returns the resolved agent (carrying its REAL owner id
   * for routing the workspace ctx) or null (a response was already written). */
  async function authorizeAgent(
    req: RouteRequest,
    res: RouteResponse,
    agentId: string | undefined,
  ): Promise<{ agentId: string; ownerUserId: string } | null> {
    if (agentId === undefined || agentId.length === 0) {
      res.status(400).json({ error: 'invalid-payload' });
      return null;
    }
    // 1) Auth — server-forced userId from the cookie.
    let userId: string;
    try {
      const out = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
        'auth:require-user',
        initCtx,
        { req },
      );
      userId = out.user.id;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return null;
      }
      throw err;
    }
    // 2) ACL — agents:resolve(agentId, userId) succeeds only for the owner /
    //    team-member. A 'forbidden' (or any resolve failure) → 403/404 with no
    //    oracle distinguishing "no agent" from "not yours".
    try {
      const out = await bus.call<AgentsResolveInput, AgentsResolveOutput>(
        'agents:resolve',
        initCtx,
        { agentId, userId },
      );
      // Team agents have no single personal-owner ctx to route the workspace
      // apply/read under — the editor is for personal agents (mirrors the
      // backfill / bootstrap policy). Refuse rather than guess a shard.
      if (out.agent.ownerType !== 'user') {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      return { agentId, ownerUserId: out.agent.ownerId };
    } catch (err) {
      if (err instanceof PluginError && err.code === 'forbidden') {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      if (err instanceof PluginError && err.code === 'not-found') {
        res.status(404).json({ error: 'not-found' });
        return null;
      }
      if (isRejection(err)) {
        res.status(403).json({ error: 'forbidden' });
        return null;
      }
      throw err;
    }
  }

  /** Build the owner-routed ctx so `workspace:read`/`workspace:apply` land in
   * THIS agent's `/agent` (ctx carries (userId, agentId); userId is the
   * agent's REAL owner — never a synthetic actor). */
  function workspaceCtx(agentId: string, ownerUserId: string): AgentContext {
    return makeAgentContext({
      reqId: makeReqId(),
      sessionId: 'agent-identity-editor',
      agentId,
      userId: ownerUserId,
    });
  }

  async function readFile(ctx: AgentContext, path: string): Promise<string> {
    try {
      const out = await bus.call<WorkspaceReadInput, WorkspaceReadResult>(
        'workspace:read',
        ctx,
        { path },
      );
      return out.found ? dec(out.bytes) : '';
    } catch (err) {
      // A read failure (no workspace backend, transient error) degrades to an
      // empty field rather than a 500 — the editor still opens.
      initCtx.logger.warn('agent_identity_read_failed', {
        plugin: PLUGIN_NAME,
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  return {
    /** GET /admin/agents/:id/identity */
    async show(req: RouteRequest, res: RouteResponse): Promise<void> {
      const auth = await authorizeAgent(req, res, req.params.id);
      if (auth === null) return;
      const ctx = workspaceCtx(auth.agentId, auth.ownerUserId);
      const [identity, soul, operating] = await Promise.all([
        readFile(ctx, IDENTITY_PATH),
        readFile(ctx, SOUL_PATH),
        readFile(ctx, AGENTS_PATH),
      ]);
      res.status(200).json({ identity, soul, operating });
    },

    /** PUT /admin/agents/:id/identity */
    async save(req: RouteRequest, res: RouteResponse): Promise<void> {
      const auth = await authorizeAgent(req, res, req.params.id);
      if (auth === null) return;

      // Parse + validate (length-bounded). Unknown fields stripped.
      let body: { identity: string; soul: string; operating?: string | undefined };
      try {
        const raw =
          req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as unknown);
        const parsed = IdentityBody.safeParse(raw);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid-payload' });
          return;
        }
        body = parsed.data;
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      const ctx = workspaceCtx(auth.agentId, auth.ownerUserId);

      // IDENTITY.md + SOUL.md are always written (put). AGENTS.md is opt-in: a
      // non-empty value is written; an empty value DELETES the file (never
      // creates an empty one — `.ax/AGENTS.md` exists only when there's a real
      // per-agent override, per the design).
      const changes: WorkspaceApplyChange[] = [
        { path: IDENTITY_PATH, kind: 'put', content: enc(body.identity) },
        { path: SOUL_PATH, kind: 'put', content: enc(body.soul) },
      ];
      const operating = body.operating ?? '';
      if (operating.trim().length > 0) {
        changes.push({ path: AGENTS_PATH, kind: 'put', content: enc(operating) });
      } else {
        // Idempotent delete — a no-op when AGENTS.md doesn't exist (the
        // validator allows deleting an identity file in any window state).
        changes.push({ path: AGENTS_PATH, kind: 'delete' });
      }

      try {
        // First attempt with parent:null — correct for a never-committed
        // workspace (the git backend lazy-creates `main`). For an agent whose
        // `/agent` already has history (the seeded BOOTSTRAP.md, transcripts,
        // a prior identity edit) — i.e. essentially every real agent — this is a
        // CAS miss; retry ONCE with the tier's actual head from
        // `cause.actualParent` (the established workspace-CAS rebase contract).
        try {
          await bus.call<WorkspaceApplyInput, unknown>('workspace:apply', ctx, {
            changes,
            parent: null,
            reason: 'agent-identity-edit',
          });
        } catch (applyErr) {
          const actual = actualParentFromMismatch(applyErr);
          if (actual === NO_ACTUAL_PARENT) throw applyErr; // not a CAS miss → real failure
          await bus.call<WorkspaceApplyInput, unknown>('workspace:apply', ctx, {
            changes,
            parent: actual,
            reason: 'agent-identity-edit',
          });
        }
        res.status(200).json({ ok: true });
      } catch (err) {
        // A validator-identity veto (injection scan / non-canonical BOOTSTRAP)
        // surfaces from the @ax/core apply facade as PluginError{code:'rejected'}
        // whose `message` is the validator's reason → 400 with that reason (no
        // internal detail beyond the validator's own message). A raw rejection
        // (a direct subscriber path) is handled too, defensively.
        if (err instanceof PluginError && err.code === 'rejected') {
          res.status(400).json({ error: err.message });
          return;
        }
        if (isRejection(err)) {
          const reason =
            typeof (err as { reason?: unknown }).reason === 'string'
              ? (err as { reason: string }).reason
              : 'rejected';
          res.status(400).json({ error: reason });
          return;
        }
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: err.message });
          return;
        }
        initCtx.logger.warn('agent_identity_save_failed', {
          plugin: PLUGIN_NAME,
          agentId: auth.agentId,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        res.status(500).json({ error: 'save-failed' });
      }
    },
  };
}
