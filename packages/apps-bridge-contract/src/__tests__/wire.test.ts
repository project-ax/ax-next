import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_ID_RE, APP_MODES, APPS_BRIDGE_V1_BASE_PATH, CallRequestSchema, CallResponseSchema, CONNECTOR_ID_RE,
  CONTRACT_VERSION, FAILED_REASONS, GrantsResponseSchema, LINK_CODE_RE, LinkClaimRequestSchema,
  LinkClaimResponseSchema, MAX_APP_NAME_CHARS, MAX_APP_NAME_INPUT_CHARS, MAX_TOKEN_CHARS, normalizeAppName,
  PLATFORM_ID_RE, REFUSAL_STATUS, RefusalSchema, TOOL_NAME_RE, UNKNOWN_REASONS,
} from '../wire.js';

const WIRE_URL = new URL('../wire.ts', import.meta.url);

// The vendoring alarm. The apps platform vendors wire.ts byte for byte from a
// pinned ax-next commit. Editing wire.ts means: update this pin, decide whether
// CONTRACT_VERSION bumps, and tell the platform side.
const WIRE_SHA256 = '42054b732c73ff69b0d86e5ec97502ca02d0f4e84fb9bda32523dfda06aa52b8';

const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const CODE = `axl_${'abcdefghijklmnopqrstuvwxyz234567'}`;

describe('wire contract v1', () => {
  it('CONTRACT_VERSION is 1, and wire.ts imports nothing but zod', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(APPS_BRIDGE_V1_BASE_PATH).toBe('/api/apps-bridge/v1');
    const source = readFileSync(WIRE_URL, 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(?:import|export)\b.*\bfrom\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/from 'zod';$/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it('wire.ts matches its pinned digest', () => {
    const digest = createHash('sha256').update(readFileSync(WIRE_URL)).digest('hex');
    expect(digest).toBe(WIRE_SHA256);
  });

  it('ids follow their grammar', () => {
    for (const ok of [APP, 'a', 'A-b_1', 'x'.repeat(64)]) expect(APP_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['', 'x'.repeat(65), 'a.b', 'a b', '\u00e9', 'a/b', 'a%2Fb']) expect(APP_ID_RE.test(bad), bad).toBe(false);

    for (const ok of ['linear', 'gh_2', '0', 'a-b', 'a'.repeat(128)]) expect(CONNECTOR_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['_x', '-x', 'a'.repeat(129), 'Linear', '', 'a.b']) expect(CONNECTOR_ID_RE.test(bad), bad).toBe(false);

    for (const ok of ['list_issues', 'a', '!~', 'x'.repeat(128)]) expect(TOOL_NAME_RE.test(ok), ok).toBe(true);
    for (const bad of ['list issues', '', 'x'.repeat(129), 'a\u007f', '\u00e9']) expect(TOOL_NAME_RE.test(bad), bad).toBe(false);

    expect(LINK_CODE_RE.test(CODE)).toBe(true);
    expect(LINK_CODE_RE.test(`axl_${'2'.repeat(32)}`)).toBe(true);
    for (const bad of [
      CODE.toUpperCase(), `axl_${'A'.repeat(32)}`, `axl_${'a'.repeat(31)}`, `axl_${'a'.repeat(33)}`,
      `axl_${'a'.repeat(31)}8`, `axk_${'a'.repeat(32)}`, `${CODE}\n`, '',
    ]) expect(LINK_CODE_RE.test(bad), bad).toBe(false);

    for (const ok of ['canopy', 'a', '0', 'canopy-apps', 'a'.repeat(63)]) expect(PLATFORM_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a'.repeat(64)]) expect(PLATFORM_ID_RE.test(bad), bad).toBe(false);
  });

  it('pins the limits', () => {
    expect(MAX_TOKEN_CHARS).toBe(8192);
    expect(MAX_APP_NAME_INPUT_CHARS).toBe(200);
    expect(MAX_APP_NAME_CHARS).toBe(80);
    expect(APP_MODES).toEqual(['builder', 'viewer']);
    expect(FAILED_REASONS).toEqual(['invalid-call', 'not-connected', 'needs-auth', 'unavailable', 'unreachable', 'rejected', 'tool-error']);
    expect(UNKNOWN_REASONS).toEqual(['timeout', 'interrupted']);
  });

  it('normalizeAppName', () => {
    // bidi override (U+202E) and zero-width space (U+200B) removed; whitespace runs collapse.
    expect(normalizeAppName('  Expense\u202eapprovals\u200b \n\t v2 ')).toBe('Expenseapprovals v2');
    // a control (U+0007) and a right-to-left mark (U+200F) leave nothing.
    expect(normalizeAppName('\u0007\u200f')).toBe('');
    expect(normalizeAppName('a'.repeat(81))).toBe('a'.repeat(80));
    // NFC: the input is decomposed e + U+0301; the output is U+00E9.
    expect(normalizeAppName('Cafe\u0301')).toBe('Caf\u00e9');
    expect('Cafe\u0301').toHaveLength(5);
    // an emoji (a surrogate pair) at the 80th code point survives whole.
    expect(normalizeAppName(`${'a'.repeat(79)}\u{1f600}xyz`)).toBe(`${'a'.repeat(79)}\u{1f600}`);
    // a lone surrogate (Cs) is removed.
    expect(normalizeAppName('a\ud800b')).toBe('ab');
    // F13: whitespace collapses to a space BEFORE Cc is removed, so a newline keeps the word break.
    expect(normalizeAppName('a\nb')).toBe('a b');
    // a format character between a base and its combining mark: removing it lets them compose,
    // so the closing NFC pass gives the precomposed letter.
    expect(normalizeAppName('e\u200b\u0301')).toBe('\u00e9');
    // removing a format character between two spaces leaves one space.
    expect(normalizeAppName('a \u200b b')).toBe('a b');
    // the cut can land on a space; the result is trimmed again.
    expect(normalizeAppName(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
    expect(normalizeAppName('Expense approvals')).toBe('Expense approvals');
  });

  it('a claim body is the contract shape, and any code string reaches the logic', () => {
    expect(LinkClaimRequestSchema.parse({ appId: APP, appName: 'Expense approvals', code: CODE })).toEqual({ appId: APP, appName: 'Expense approvals', code: CODE });
    // F2: a malformed code is link_code_invalid at the logic, never invalid_request here.
    for (const code of ['', 'x'.repeat(65), 'not-a-code']) {
      expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: 'n', code }).success, code).toBe(true);
    }
    expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: 'n', code: 5 }).success).toBe(false);
    expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: '', code: CODE }).success).toBe(false);
    expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: 'n'.repeat(201), code: CODE }).success).toBe(false);
    expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: 'n'.repeat(200), code: CODE }).success).toBe(true);
    expect(LinkClaimRequestSchema.safeParse({ appId: 'a.b', appName: 'n', code: CODE }).success).toBe(false);
    expect(LinkClaimRequestSchema.safeParse({ appId: APP, appName: 'n', code: CODE, extra: 1 }).success).toBe(false);
    expect(LinkClaimResponseSchema.safeParse({ appId: APP }).success).toBe(true);
    expect(LinkClaimResponseSchema.safeParse({ appId: APP, linked: true }).success).toBe(false);
  });

  const builder = { appId: APP, connectorId: 'linear', tool: 'list_issues', input: { team: 'eng' }, mode: 'builder' };
  const viewer = { ...builder, mode: 'viewer', viewerAssertion: 'eyJ.x.y' };

  it('a builder call may not carry a viewer assertion, and a viewer call must', () => {
    expect(CallRequestSchema.parse(builder)).toEqual(builder);
    expect(CallRequestSchema.parse(viewer)).toEqual(viewer);
    expect(CallRequestSchema.safeParse({ ...builder, viewerAssertion: 'eyJ.x.y' }).success).toBe(false);
    const { viewerAssertion: _drop, ...noAssertion } = viewer;
    expect(CallRequestSchema.safeParse(noAssertion).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...viewer, viewerAssertion: '' }).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...viewer, viewerAssertion: 'x'.repeat(MAX_TOKEN_CHARS) }).success).toBe(true);
    expect(CallRequestSchema.safeParse({ ...viewer, viewerAssertion: 'x'.repeat(MAX_TOKEN_CHARS + 1) }).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...builder, mode: 'admin' }).success).toBe(false);
  });

  it('a call body with an unknown key or a non-object input is refused', () => {
    expect(CallRequestSchema.safeParse({ ...builder, extra: 1 }).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...viewer, extra: 1 }).success).toBe(false);
    for (const input of [[], null, 'x', 1, undefined]) {
      expect(CallRequestSchema.safeParse({ ...builder, input }).success, String(input)).toBe(false);
    }
    expect(CallRequestSchema.safeParse({ ...builder, input: {} }).success).toBe(true);
    expect(CallRequestSchema.safeParse({ ...builder, tool: 'list issues' }).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...builder, connectorId: '_x' }).success).toBe(false);
    expect(CallRequestSchema.safeParse({ ...builder, appId: '' }).success).toBe(false);
  });

  it('input reaches the connector byte-faithfully: own __proto__ and constructor keys survive and touch no prototype', () => {
    const rawInput = '{"__proto__":{"x":1},"constructor":{"y":2},"a":{"__proto__":{"z":3}}}';
    const raw = `{"appId":"${APP}","connectorId":"linear","tool":"list_issues","input":${rawInput},"mode":"builder"}`;
    const result = CallRequestSchema.parse(JSON.parse(raw));
    expect(JSON.stringify(result.input)).toBe(rawInput);
    expect(Object.getPrototypeOf(result.input)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result.input, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).z).toBeUndefined();
    // not a plain object: a class instance, a Date, a Map
    for (const input of [new Date(0), new Map(), new (class Box {})()]) {
      expect(CallRequestSchema.safeParse({ ...builder, input }).success).toBe(false);
    }
  });

  it('responses are closed shapes', () => {
    const block = { type: 'text', text: 'hi', annotations: { audience: ['user'] } };
    expect(CallResponseSchema.parse({ outcome: 'succeeded', content: [block] })).toEqual({ outcome: 'succeeded', content: [block] });
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded', content: [] }).success).toBe(true);
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded' }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded', content: [{ text: 'no type' }] }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded', content: [{ type: '' }] }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded', content: [{ type: 'x'.repeat(65) }] }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'succeeded', content: [], reason: 'x' }).success).toBe(false);

    expect(CallResponseSchema.safeParse({ outcome: 'failed', reason: 'tool-error', content: [] }).success).toBe(true);
    expect(CallResponseSchema.safeParse({ outcome: 'failed', reason: 'tool-error' }).success).toBe(false);
    for (const reason of FAILED_REASONS.filter((r) => r !== 'tool-error')) {
      expect(CallResponseSchema.safeParse({ outcome: 'failed', reason }).success, reason).toBe(true);
      expect(CallResponseSchema.safeParse({ outcome: 'failed', reason, content: [] }).success, reason).toBe(false);
    }
    expect(CallResponseSchema.safeParse({ outcome: 'failed', reason: 'timeout' }).success).toBe(false);

    for (const reason of UNKNOWN_REASONS) expect(CallResponseSchema.safeParse({ outcome: 'unknown', reason }).success).toBe(true);
    expect(CallResponseSchema.safeParse({ outcome: 'unknown', reason: 'tool-error' }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'unknown', reason: 'timeout', content: [] }).success).toBe(false);
    expect(CallResponseSchema.safeParse({ outcome: 'maybe', reason: 'timeout' }).success).toBe(false);
  });

  it('approveUrl rides only on viewer_approval_required', () => {
    const url = 'https://ax.example/apps/approve/canopy/app_1/linear';
    expect(RefusalSchema.safeParse({ code: 'viewer_approval_required', approveUrl: url }).success).toBe(true);
    expect(RefusalSchema.safeParse({ code: 'viewer_approval_required' }).success).toBe(false);
    expect(RefusalSchema.safeParse({ code: 'viewer_approval_required', approveUrl: 'not a url' }).success).toBe(false);
    expect(RefusalSchema.safeParse({ code: 'viewer_approval_required', approveUrl: 'http://127.0.0.1:8080/apps/approve/canopy/app_1/linear' }).success).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://ax.example/x']) {
      expect(RefusalSchema.safeParse({ code: 'viewer_approval_required', approveUrl: bad }).success, bad).toBe(false);
    }
    expect(RefusalSchema.safeParse({ code: 'viewer_approval_required', approveUrl: `https://a.example/${'x'.repeat(2048)}` }).success).toBe(false);
    for (const code of Object.keys(REFUSAL_STATUS).filter((c) => c !== 'viewer_approval_required')) {
      expect(RefusalSchema.safeParse({ code }).success, code).toBe(true);
      expect(RefusalSchema.safeParse({ code, approveUrl: url }).success, code).toBe(false);
    }
    expect(RefusalSchema.safeParse({ code: 'teapot' }).success).toBe(false);
    expect(RefusalSchema.safeParse({ code: 'unavailable', message: 'x' }).success).toBe(false);
  });

  it('REFUSAL_STATUS is the contract table', () => {
    expect(REFUSAL_STATUS).toEqual({
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
    });
  });

  it('a grants answer is exactly the contract shape', () => {
    const tool = { name: 'list_issues', description: 'Lists issues', inputSchema: { type: 'object', properties: {} } };
    const grant = { connectorId: 'linear', displayName: 'Linear', mode: 'viewer', tools: [tool] };
    expect(GrantsResponseSchema.parse({ grants: [grant] })).toEqual({ grants: [grant] });
    expect(GrantsResponseSchema.safeParse({ grants: [] }).success).toBe(true);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [{ ...tool, inputSchema: null }] }] }).success).toBe(true);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [{ ...tool, description: '' }] }] }).success).toBe(true);
    const { description: _d, ...noDescription } = tool;
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [noDescription] }] }).success).toBe(false);
    const { inputSchema: _s, ...noSchema } = tool;
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [noSchema] }] }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [{ ...tool, inputSchema: [] }] }] }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [{ ...tool, url: 'x' }] }] }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, agentId: 'a' }] }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [], next: null }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, mode: 'admin' }] }).success).toBe(false);
    expect(GrantsResponseSchema.safeParse({ grants: [{ ...grant, tools: [{ ...tool, name: 'a b' }] }] }).success).toBe(false);
  });
});
