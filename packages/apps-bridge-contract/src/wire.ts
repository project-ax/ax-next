/**
 * AX apps bridge: the external wire contract, version 1.
 *
 * The apps platform vendors this file byte for byte from a pinned ax-next
 * commit, so it imports nothing but `zod`. Both sides assert
 * CONTRACT_VERSION in a test. A test in this package pins the file's sha256:
 * editing it means updating that pin, deciding whether CONTRACT_VERSION
 * bumps, and telling the platform side.
 *
 * Base path APPS_BRIDGE_V1_BASE_PATH, on the bridge's own listener:
 *   POST /links/claim       LinkClaimRequest  -> 200 LinkClaimResponse
 *   POST /call              CallRequest       -> 200 CallResponse
 *   GET  /apps/:appId/grants                  -> 200 GrantsResponse
 * Any refusal is a Refusal body with status REFUSAL_STATUS[code]. Key on
 * `code`, not on the status.
 *
 * The v1 surface is every export of this file, including the id schemas
 * (AppIdSchema, ConnectorIdSchema, ToolNameSchema, AppModeSchema).
 *
 * A call's `input` must be a plain JSON object, and it is passed through as
 * parsed: own `__proto__` and `constructor` keys reach the connector exactly
 * as the app sent them, and touch no prototype.
 *
 * Untrusted at every hop: `input`, `viewerAssertion`, `appName`, the link
 * code, `content`, `description` and `inputSchema`.
 */
import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;
export const APPS_BRIDGE_V1_BASE_PATH = '/api/apps-bridge/v1';

// ---------------------------------------------------------------------------
// Ids and limits
// ---------------------------------------------------------------------------

/** The operator's id for the platform (DNS-label shape). */
export const PLATFORM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The platform's own opaque app id. */
export const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** AX's connector id. */
export const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** A connector tool's name: 1-128 printable ASCII characters, no spaces. */
export const TOOL_NAME_RE = /^[\x21-\x7e]{1,128}$/;
/** `axl_` + 32 lowercase RFC 4648 base32 characters (20 random bytes). */
export const LINK_CODE_RE = /^axl_[a-z2-7]{32}$/;

/** The bearer token and `viewerAssertion` are each at most this many characters. */
export const MAX_TOKEN_CHARS = 8192;
/** A claim's raw `appName`, before normalizeAppName. */
export const MAX_APP_NAME_INPUT_CHARS = 200;
/** A normalized app name, in code points. */
export const MAX_APP_NAME_CHARS = 80;

/**
 * The display name AX keeps for an app. Display-only: never an id.
 *
 * In this order: Unicode NFC; every whitespace run becomes one space; Unicode
 * Cc, Cf and Cs characters (controls, invisible format characters including
 * bidi controls, lone surrogates) are removed; space runs collapse again;
 * NFC again (a removed character may have kept a letter from its combining
 * mark); trim; keep the first 80 code points; trim the end again.
 *
 * Whitespace goes to a space before controls are removed, so "a\nb" keeps its
 * word break and becomes "a b". An empty result is refused by the caller.
 */
export function normalizeAppName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .normalize('NFC')
    .trim();
  return Array.from(cleaned).slice(0, MAX_APP_NAME_CHARS).join('').trimEnd();
}

export const APP_MODES = ['builder', 'viewer'] as const;
export type AppMode = (typeof APP_MODES)[number];

export const AppIdSchema = z.string().regex(APP_ID_RE);
export const ConnectorIdSchema = z.string().regex(CONNECTOR_ID_RE);
export const ToolNameSchema = z.string().regex(TOOL_NAME_RE);
export const AppModeSchema = z.enum(APP_MODES);

// ---------------------------------------------------------------------------
// POST /links/claim
// ---------------------------------------------------------------------------

export const LinkClaimRequestSchema = z
  .object({
    appId: AppIdSchema,
    appName: z.string().min(1).max(MAX_APP_NAME_INPUT_CHARS),
    // Any string: AX checks the code's grammar itself, so a malformed code
    // answers link_code_invalid like an unknown, expired or used one. The
    // claim body's byte cap bounds its length.
    code: z.string(),
  })
  .strict();
export type LinkClaimRequest = z.infer<typeof LinkClaimRequestSchema>;

export const LinkClaimResponseSchema = z.object({ appId: AppIdSchema }).strict();
export type LinkClaimResponse = z.infer<typeof LinkClaimResponseSchema>;

// ---------------------------------------------------------------------------
// POST /call
// ---------------------------------------------------------------------------

/**
 * A plain object (what JSON.parse makes for `{...}`), returned as is. Not
 * z.record: that rebuilds the object and drops an own `__proto__` key, so the
 * connector would get a different call than the app sent.
 */
const PlainObjectSchema = z.custom<Record<string, unknown>>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype,
  { message: 'Expected a plain object' },
);

const callFields = {
  appId: AppIdSchema,
  connectorId: ConnectorIdSchema,
  tool: ToolNameSchema,
  input: PlainObjectSchema,
};

export const CallRequestSchema = z.discriminatedUnion('mode', [
  z.object({ ...callFields, mode: z.literal('builder') }).strict(),
  z
    .object({ ...callFields, mode: z.literal('viewer'), viewerAssertion: z.string().min(1).max(MAX_TOKEN_CHARS) })
    .strict(),
]);
export type CallRequest = z.infer<typeof CallRequestSchema>;

/** Why a call that reached the connector failed. Only 'tool-error' carries content. */
export const FAILED_REASONS = [
  'invalid-call',
  'not-connected',
  'needs-auth',
  'unavailable',
  'unreachable',
  'rejected',
  'tool-error',
] as const;
/** The call may have happened: never retry a write on these. */
export const UNKNOWN_REASONS = ['timeout', 'interrupted'] as const;

/**
 * One MCP content block: read for its `type` only, every other key passes
 * through unread. Untrusted upstream data.
 *
 * Mirrored by `ConnectorResultContentBlockSchema` in @ax/mcp-client
 * (src/connector-inventory/types.ts), a parallel copy: change both.
 */
export const ContentBlockSchema = z.object({ type: z.string().min(1).max(64) }).passthrough();
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const CallResponseSchema = z.union([
  z.object({ outcome: z.literal('succeeded'), content: z.array(ContentBlockSchema) }).strict(),
  z
    .object({ outcome: z.literal('failed'), reason: z.literal('tool-error'), content: z.array(ContentBlockSchema) })
    .strict(),
  z.object({ outcome: z.literal('failed'), reason: z.enum(FAILED_REASONS).exclude(['tool-error']) }).strict(),
  z.object({ outcome: z.literal('unknown'), reason: z.enum(UNKNOWN_REASONS) }).strict(),
]);
export type CallResponse = z.infer<typeof CallResponseSchema>;

// ---------------------------------------------------------------------------
// Refusals (any route)
// ---------------------------------------------------------------------------

/** The closed refusal codes and their HTTP statuses. */
export const REFUSAL_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  link_code_invalid: 403,
  already_linked: 409,
  app_not_linked: 404,
  not_granted: 403,
  tool_not_allowed: 403,
  approval_required: 403,
  viewer_invalid: 403,
  viewer_approval_required: 403,
  agent_unavailable: 403,
  rate_limited: 429,
  unavailable: 503,
} as const;
export type RefusalCode = keyof typeof REFUSAL_STATUS;

/** Every refusal code but viewer_approval_required, which carries an approveUrl. */
type PlainRefusalCode = Exclude<RefusalCode, 'viewer_approval_required'>;

/**
 * Identity at run time. At compile time `codes` must name every plain refusal
 * code (and only those), so a code added to REFUSAL_STATUS can't be missed
 * here. A literal tuple, not Object.keys: zod infers the enum's type from it,
 * and a widened tuple would make the plain arm's `code` type `never`.
 */
function everyPlainCode<const T extends readonly [PlainRefusalCode, ...PlainRefusalCode[]]>(
  codes: T & ([PlainRefusalCode] extends [T[number]] ? unknown : never),
): T {
  return codes;
}

const PLAIN_REFUSAL_CODES = everyPlainCode([
  'invalid_request',
  'unauthenticated',
  'link_code_invalid',
  'already_linked',
  'app_not_linked',
  'not_granted',
  'tool_not_allowed',
  'approval_required',
  'viewer_invalid',
  'agent_unavailable',
  'rate_limited',
  'unavailable',
]);

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * `approveUrl` rides on viewer_approval_required alone: an absolute http(s)
 * URL of an AX page, with no query string or fragment.
 */
export const RefusalSchema = z.union([
  z
    .object({
      code: z.literal('viewer_approval_required'),
      approveUrl: z.string().url().max(2048).refine(isHttpUrl, { message: 'Expected an http(s) URL' }),
    })
    .strict(),
  z.object({ code: z.enum(PLAIN_REFUSAL_CODES) }).strict(),
]);
export type Refusal = z.infer<typeof RefusalSchema>;

// ---------------------------------------------------------------------------
// GET /apps/:appId/grants
// ---------------------------------------------------------------------------

/**
 * `description` is '' when unknown; `inputSchema` is a JSON object or null.
 * Both are the connector server's own words, as the linked agent's sign-in
 * last saw them: untrusted, and never compiled by AX.
 */
export const GrantsResponseSchema = z
  .object({
    grants: z.array(
      z
        .object({
          connectorId: ConnectorIdSchema,
          displayName: z.string(),
          mode: AppModeSchema,
          tools: z.array(
            z
              .object({
                name: ToolNameSchema,
                description: z.string(),
                inputSchema: z.record(z.unknown()).nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type GrantsResponse = z.infer<typeof GrantsResponseSchema>;
