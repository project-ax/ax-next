/**
 * The bridge's three answers, given a caller the listener already
 * authenticated (Task 8 wraps these in HTTP):
 *
 *   answerClaim  POST /links/claim       a link code becomes an app link
 *   answerCall   POST /call              one tool call on a granted connector
 *   answerGrants GET  /apps/:appId/grants what the app may call, described
 *
 * Each runs its checks in a fixed order (the function comments list them);
 * the first failure answers and nothing after it runs. Every answer is a
 * contract-v1 body plus the status, an optional Retry-After and the fields
 * for the request's one log line.
 *
 * Untrusted at every hop (I5): the request body (input, viewerAssertion,
 * appName, the link code), the connector's content, and the inventory's
 * descriptions and schemas. None of them reaches a log line: `log` carries
 * ids only after they passed their grammar, and closed codes.
 */
import {
  APP_ID_RE,
  CallRequestSchema,
  CallResponseSchema,
  LINK_CODE_RE,
  LinkClaimRequestSchema,
  REFUSAL_STATUS,
  TOOL_KEY_RE,
  approvePagePath,
  normalizeAppName,
  type AppMode,
  type CallResponse,
  type GrantsResponse,
  type LinkClaimResponse,
  type Refusal,
  type RefusalCode,
} from '@ax/apps-bridge-contract';
import { PluginError, ownerlessIdFor, type AgentContext, type Logger } from '@ax/core';
import { z } from 'zod';
import { bridgeCtx, canManageAgent, connectorNames, effectiveConnectors, resolveAgent, type BridgeBus } from './access.js';
import { hashLinkCode } from './link-codes.js';
import type { BridgeLimiter } from './limits.js';
import { loggableCode } from './log-code.js';
import type { AppLink, AppsBridgeStore } from './store.js';
import type { ViewerVerdict } from './verify-token.js';

export interface BridgeLog {
  appId?: string;
  connectorId?: string;
  tool?: string;
  mode?: AppMode;
  /** A refusal code, `succeeded`, `failed`, `unknown` or `linked`. */
  outcome: string;
  /** A closed code: an outcome reason, a verify failure, `no-account`, `replay`, or an error's code. */
  reason?: string;
  /**
   * Log-only, never on the wire: set when the answer came from a path we
   * didn't plan for (a throw, or an answer the contract can't carry) rather
   * than from the connector or a check. The wire answer is unchanged; this
   * keeps a real interruption apart from a bug.
   */
  unexpected?: true;
  /**
   * Log-only: what caused an unexpected answer, as a closed code. A thrown
   * `PluginError`'s code when it is loggable (see log-code.ts), or a fixed
   * code such as `contract-mismatch`. Never an error message.
   */
  code?: string;
}

export interface BridgeAnswer {
  status: number;
  body: LinkClaimResponse | CallResponse | Refusal | GrantsResponse;
  retryAfterSeconds?: number;
  log: BridgeLog;
}

export interface BridgeDeps {
  bus: BridgeBus;
  store: AppsBridgeStore;
  platformId: string;
  /** An origin with no trailing slash: the plugin passes `new URL(config.publicOrigin).origin`. */
  publicOrigin: string;
  verifyViewer: (assertion: string) => Promise<ViewerVerdict>;
  limiter: Pick<BridgeLimiter, 'takeApp'>;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
}

type LogFields = Omit<BridgeLog, 'outcome'>;
type PlainRefusalCode = Exclude<RefusalCode, 'viewer_approval_required'>;

const RETRY_AFTER_SECONDS: Partial<Record<RefusalCode, number>> = { rate_limited: 60, unavailable: 5 };

function refuse(code: PlainRefusalCode, fields: LogFields, reason?: string): BridgeAnswer {
  const retry = RETRY_AFTER_SECONDS[code];
  return {
    status: REFUSAL_STATUS[code],
    body: { code },
    ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    log: { ...fields, outcome: code, ...(reason !== undefined ? { reason } : {}) },
  };
}

/** A store or hook failure: retry soon. Only the error's loggable code is kept, never its message. */
function unavailable(fields: LogFields, err?: unknown): BridgeAnswer {
  return refuse('unavailable', fields, err === undefined ? undefined : loggableCode(err));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function unreadable(hook: string): Error {
  return new PluginError({ code: 'invalid-return', plugin: '@ax/apps-bridge', hookName: hook, message: `${hook}: unreadable answer` });
}

// ---------------------------------------------------------------------------
// POST /links/claim
// ---------------------------------------------------------------------------

function linked(appId: string, reason?: 'replay'): BridgeAnswer {
  return { status: 200, body: { appId }, log: { appId, outcome: 'linked', ...(reason !== undefined ? { reason } : {}) } };
}

/** The code is gone: a retry of the claim that used it on this app id is answered 200 again. */
async function replayOrInvalid(deps: BridgeDeps, appId: string, hash: string): Promise<BridgeAnswer> {
  const made = await deps.store.getLinkByCode(deps.platformId, appId, hash);
  return made !== null ? linked(appId, 'replay') : refuse('link_code_invalid', { appId });
}

/**
 * In order; the first failure answers:
 *  1. the body fails LinkClaimRequestSchema, or the name normalizes to '' → invalid_request;
 *  2. the code fails LINK_CODE_RE → link_code_invalid;
 *  3. no unexpired code under its hash → 200 if this code made this app's
 *     link (a retry), else link_code_invalid;
 *  4. the minter can no longer manage the agent's connectors → link_code_invalid;
 *  5. the store's claim: linked → 200; already-linked → already_linked (the
 *     code is kept); invalid (a racing claim took the code) → step 3's replay check;
 *  6. a store or hook throw → unavailable.
 * The log carries the app id (after step 1) and the outcome, never the code or the name.
 */
export async function answerClaim(deps: BridgeDeps, body: unknown): Promise<BridgeAnswer> {
  const parsed = LinkClaimRequestSchema.safeParse(body);
  if (!parsed.success) return refuse('invalid_request', {});
  const { appId, appName, code } = parsed.data;
  const name = normalizeAppName(appName);
  if (name === '') return refuse('invalid_request', {});
  const fields: LogFields = { appId };

  if (!LINK_CODE_RE.test(code)) return refuse('link_code_invalid', fields);

  try {
    const hash = hashLinkCode(code);
    const now = new Date(deps.now());
    const minted = await deps.store.peekLinkCode(hash, now);
    if (minted === null) return await replayOrInvalid(deps, appId, hash);

    const ctx = bridgeCtx(minted.userId, minted.agentId, deps.logger);
    if (!(await canManageAgent(deps.bus, ctx, minted.agentId, minted.userId))) {
      return refuse('link_code_invalid', fields);
    }

    const claimed = await deps.store.claimLinkCode({ codeHash: hash, platformId: deps.platformId, appId, appName: name, now });
    switch (claimed.result) {
      case 'linked':
        return linked(appId);
      case 'already-linked':
        return refuse('already_linked', fields);
      case 'invalid':
        return await replayOrInvalid(deps, appId, hash);
    }
  } catch (err) {
    return unavailable(fields, err);
  }
}

// ---------------------------------------------------------------------------
// POST /call
// ---------------------------------------------------------------------------

/** Read for its verdict only; anything else about the answer is the policy plugin's business. */
const PolicyAnswerSchema = z.object({ verdict: z.enum(['allow', 'hold', 'deny']) }).passthrough();

/** bridgeCtx's session id: the owner-less stand-in for the email lookup is minted from it. */
const LOOKUP_SESSION = 'apps-bridge';

/** `auth:find-user-by-email`: the account, or null. An answer that is neither throws. */
async function findViewer(deps: BridgeDeps, email: string): Promise<string | null> {
  // Asked as no one: the lookup itself is the step that names the person.
  const nobody = ownerlessIdFor(LOOKUP_SESSION);
  const found = await deps.bus.call<{ email: string }, unknown>('auth:find-user-by-email', bridgeCtx(nobody, nobody, deps.logger), {
    email,
  });
  if (found === null) return null;
  if (isRecord(found) && typeof found['userId'] === 'string' && found['userId'].length > 0) return found['userId'];
  throw unreadable('auth:find-user-by-email');
}

/**
 * The call may have gone out, so the app is told `unknown/interrupted`. The
 * log line says it was unexpected, and why when there's a code for it: a bus
 * timeout, a missing service and a contract miss all look alike on the wire.
 */
function interrupted(fields: LogFields, code: string | undefined): BridgeAnswer {
  return {
    status: 200,
    body: { outcome: 'unknown', reason: 'interrupted' },
    log: { ...fields, outcome: 'unknown', reason: 'interrupted', unexpected: true, ...(code !== undefined ? { code } : {}) },
  };
}

/**
 * In order; the first failure answers:
 *  1. the body fails CallRequestSchema → invalid_request. From here on `input`
 *     is the parsed JSON's own object, never zod's copy;
 *  2. the app is over its rate → rate_limited (Retry-After 60);
 *  3. no link → app_not_linked;
 *  4. no grant for the connector, or a grant of the other mode → not_granted;
 *  5. no granted tool key names the tool → tool_not_allowed;
 *  6. identity. Builder: the linker and the linked agent. Viewer: the
 *     assertion verifies (a JWKS outage → unavailable, any other failure →
 *     viewer_invalid); its email names an account (none → viewer_invalid);
 *     that account approved this connector for this app including this tool
 *     (else viewer_approval_required with the approve link); then the viewer
 *     and the agent they approved;
 *  7. the agent resolves for that person (else agent_unavailable). Builder:
 *     the linker must still manage the agent's connectors, as at claim time
 *     (else agent_unavailable). Viewer: it must be the viewer's own personal
 *     agent (else agent_unavailable). Then, defence in depth: the tool key's
 *     namespace must not belong to a connector other than the granted one in
 *     the agent's effective set (else tool_not_allowed). A namespace on no
 *     connector goes on: the call hook answers it `not-connected`;
 *  8. tool-policy:evaluate: allow proceeds, hold → approval_required,
 *     deny → tool_not_allowed;
 *  9. connectors:call-tool-result as that person and agent; its answer, as
 *     the bus returns it, is the 200 body. A throw (or an answer the contract
 *     can't carry) → 200 unknown/interrupted, because the call may have gone
 *     out; the log line adds `unexpected: true` and the cause's code;
 * 10. a throw from the store or a read before step 9 → unavailable (Retry-After 5).
 */
export async function answerCall(deps: BridgeDeps, body: unknown): Promise<BridgeAnswer> {
  const parsed = CallRequestSchema.safeParse(body);
  if (!parsed.success) return refuse('invalid_request', {});
  const req = parsed.data;
  // The app's own object: own `__proto__`/`constructor` keys reach the
  // connector as sent, and nothing here reads or copies it.
  const input = (body as { input: Record<string, unknown> }).input;
  const { appId, connectorId, tool, mode } = req;
  const fields: LogFields = { appId, connectorId, tool, mode };

  let ready: { ctx: AgentContext; userId: string; agentId: string; toolKey: string };
  try {
    if (!deps.limiter.takeApp(deps.platformId, appId)) return refuse('rate_limited', fields);

    const link: AppLink | null = await deps.store.getLink(deps.platformId, appId);
    if (link === null) return refuse('app_not_linked', fields);

    const grant = await deps.store.getGrant(deps.platformId, appId, connectorId);
    if (grant === null || grant.mode !== mode) return refuse('not_granted', fields);

    const toolKey = grant.toolKeys.find((key) => TOOL_KEY_RE.exec(key)?.[2] === tool);
    if (toolKey === undefined) return refuse('tool_not_allowed', fields);

    let userId: string;
    let agentId: string;
    if (req.mode === 'builder') {
      userId = link.linkedByUserId;
      agentId = link.agentId;
    } else {
      const verdict = await deps.verifyViewer(req.viewerAssertion);
      if (!verdict.ok) {
        return verdict.reason === 'keys-unavailable'
          ? refuse('unavailable', fields, 'keys-unavailable')
          : refuse('viewer_invalid', fields, verdict.reason);
      }
      const viewer = await findViewer(deps, verdict.email);
      if (viewer === null) return refuse('viewer_invalid', fields, 'no-account');
      const approval = await deps.store.getApproval(viewer, deps.platformId, appId, connectorId);
      if (approval === null || !approval.toolKeys.includes(toolKey)) {
        return {
          status: REFUSAL_STATUS.viewer_approval_required,
          body: {
            code: 'viewer_approval_required',
            approveUrl: `${deps.publicOrigin}${approvePagePath(deps.platformId, appId, connectorId)}`,
          },
          log: { ...fields, outcome: 'viewer_approval_required' },
        };
      }
      userId = viewer;
      agentId = approval.agentId;
    }

    const ctx = bridgeCtx(userId, agentId, deps.logger);
    const agent = await resolveAgent(deps.bus, ctx, agentId, userId);
    if (agent === null) return refuse('agent_unavailable', fields);
    // A viewer lends only their own personal agent, whatever the approval says.
    if (req.mode === 'builder') {
      // The link is only as good as the linker's rights: the claim needed
      // them, and so does every call made on the link.
      if (!(await canManageAgent(deps.bus, ctx, agentId, userId))) return refuse('agent_unavailable', fields);
    } else if (!(agent.ownerType === 'user' && agent.ownerId === userId)) {
      return refuse('agent_unavailable', fields);
    }

    // A mis-written grant must not reach another connector's tool through
    // this connector's grant.
    const namespace = TOOL_KEY_RE.exec(toolKey)?.[1];
    const owners = (await effectiveConnectors(deps.bus, ctx, userId, agent)).filter(
      (c) => namespace !== undefined && c.toolNamespaces.includes(namespace),
    );
    if (owners.some((c) => c.id !== connectorId)) return refuse('tool_not_allowed', fields);

    const policy = PolicyAnswerSchema.safeParse(
      await deps.bus.call<{ call: { name: string; input: Record<string, unknown> }; agentId: string }, unknown>(
        'tool-policy:evaluate',
        ctx,
        { call: { name: toolKey, input }, agentId },
      ),
    );
    if (!policy.success) throw unreadable('tool-policy:evaluate');
    if (policy.data.verdict === 'hold') return refuse('approval_required', fields);
    if (policy.data.verdict !== 'allow') return refuse('tool_not_allowed', fields);

    ready = { ctx, userId, agentId, toolKey };
  } catch (err) {
    return unavailable(fields, err);
  }

  let result: unknown;
  try {
    result = await deps.bus.call<{ userId: string; agentId: string; toolKey: string; input: Record<string, unknown> }, unknown>(
      'connectors:call-tool-result',
      ready.ctx,
      { userId: ready.userId, agentId: ready.agentId, toolKey: ready.toolKey, input },
    );
  } catch (err) {
    return interrupted(fields, loggableCode(err));
  }
  // The hook's own `returns` schema already holds it to this shape; checked
  // again because it becomes the contract body. The body is the object the
  // bus handed back, not a copy made here. That object is the bus's parsed
  // copy of the handler's answer (`returns.safeParse(result).data`), so key
  // order may differ from what the connector sent and an own `__proto__` key
  // in a content block is gone; the values are otherwise the connector's.
  if (!CallResponseSchema.safeParse(result).success) return interrupted(fields, 'contract-mismatch');
  const outcome = result as CallResponse;
  return {
    status: 200,
    body: outcome,
    log: { ...fields, outcome: outcome.outcome, ...('reason' in outcome ? { reason: outcome.reason } : {}) },
  };
}

// ---------------------------------------------------------------------------
// GET /apps/:appId/grants
// ---------------------------------------------------------------------------

/**
 * The most bytes of serialized tool entries one grants answer carries
 * schemas for. Without it the worst case is ~32 KiB of schema x 200 tools x
 * every granted connector. Past it, each further tool keeps its name and
 * description but its `inputSchema` is null, so the answer stays bounded and
 * valid; the log line says `schemas-trimmed`.
 */
export const GRANTS_BODY_BUDGET_BYTES = 4 * 1024 * 1024;

const utf8Bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

interface Described {
  description: string;
  inputSchema: Record<string, unknown> | null;
}

/**
 * The linked agent's inventory for one connector, by tool key, and whether
 * the read failed. A throw degrades to an empty inventory, as does an answer
 * that can't be read; the caller notes it on the request's one log line.
 */
async function describeConnector(
  deps: BridgeDeps,
  ctx: AgentContext,
  link: AppLink,
  connectorId: string,
): Promise<{ tools: Map<string, Described>; failed: false } | { tools: Map<string, Described>; failed: true; code: string | undefined }> {
  const out = new Map<string, Described>();
  let answer: unknown;
  try {
    answer = await deps.bus.call<{ userId: string; agentId: string; connectorId: string }, unknown>('connectors:describe-tools', ctx, {
      userId: link.linkedByUserId,
      agentId: link.agentId,
      connectorId,
    });
  } catch (err) {
    return { tools: out, failed: true, code: loggableCode(err) };
  }
  const tools = isRecord(answer) ? answer['tools'] : undefined;
  if (!Array.isArray(tools)) return { tools: out, failed: true, code: 'contract-mismatch' };
  for (const t of tools) {
    if (!isRecord(t) || typeof t['toolKey'] !== 'string' || out.has(t['toolKey'])) continue;
    out.set(t['toolKey'], {
      description: typeof t['description'] === 'string' ? t['description'] : '',
      inputSchema: isPlainObject(t['inputSchema']) ? t['inputSchema'] : null,
    });
  }
  return { tools: out, failed: false };
}

/**
 * The app id fails APP_ID_RE → invalid_request; no link → app_not_linked;
 * the linker can no longer manage the linked agent's connectors →
 * agent_unavailable; otherwise 200 with one entry per grant in connector id order. Display names
 * come from the linker's `connectors:list` (the id when it lacks one); each
 * tool's description and schema from the linked agent's inventory, matched on
 * the tool key ('' and null when the inventory lacks it or its read failed;
 * a failed read puts `reason: 'describe-tools-failed'` on the log line, plus
 * the first failure's `code` when it has one).
 * Any other throw → unavailable (Retry-After 5).
 */
export async function answerGrants(deps: BridgeDeps, appId: string): Promise<BridgeAnswer> {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return refuse('invalid_request', {});
  const fields: LogFields = { appId };
  try {
    const link = await deps.store.getLink(deps.platformId, appId);
    if (link === null) return refuse('app_not_linked', fields);
    const ctx = bridgeCtx(link.linkedByUserId, link.agentId, deps.logger);
    if (!(await canManageAgent(deps.bus, ctx, link.agentId, link.linkedByUserId))) {
      return refuse('agent_unavailable', fields);
    }
    const grants = await deps.store.listGrants(deps.platformId, appId);
    const names = grants.length === 0 ? new Map<string, string>() : await connectorNames(deps.bus, ctx, link.linkedByUserId);
    const inventories = await Promise.all(grants.map((g) => describeConnector(deps, ctx, link, g.connectorId)));

    // Every entry is counted, with or without its schema, so the total
    // stays under the budget plus the schema-less entries' own size.
    let spent = 0;
    let trimmed = false;
    const body: GrantsResponse = {
      grants: grants.map((g, i) => {
        const head = { connectorId: g.connectorId, displayName: names.get(g.connectorId) ?? g.connectorId, mode: g.mode };
        spent += utf8Bytes(head);
        return {
          ...head,
          tools: g.toolKeys.flatMap((key): GrantsResponse['grants'][number]['tools'] => {
            const name = TOOL_KEY_RE.exec(key)?.[2];
            if (name === undefined) return [];
            const known = inventories[i]?.tools.get(key);
            const bare = { name, description: known?.description ?? '', inputSchema: null as Record<string, unknown> | null };
            const bareBytes = utf8Bytes(bare);
            const schema = known?.inputSchema ?? null;
            if (schema !== null) {
              const full = { ...bare, inputSchema: schema };
              const fullBytes = utf8Bytes(full);
              // Once one schema didn't fit, no later one goes in either.
              if (!trimmed && spent + fullBytes <= GRANTS_BODY_BUDGET_BYTES) {
                spent += fullBytes;
                return [full];
              }
              trimmed = true;
            }
            spent += bareBytes;
            return [bare];
          }),
        };
      }),
    };
    // The first failed read's code, when it has one, rides on the log line.
    const failure = inventories.find((inv) => inv.failed);
    const reason = failure !== undefined ? 'describe-tools-failed' : trimmed ? 'schemas-trimmed' : undefined;
    const code = failure?.failed === true ? failure.code : undefined;
    return {
      status: 200,
      body,
      log: { ...fields, outcome: 'succeeded', ...(reason !== undefined ? { reason } : {}), ...(code !== undefined ? { code } : {}) },
    };
  } catch (err) {
    return unavailable(fields, err);
  }
}
