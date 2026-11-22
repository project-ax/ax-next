/**
 * The apps bridge contract re-declares one grammar another package owns:
 * `TOOL_KEY_RE` is @ax/mcp-client's `CONNECTOR_TOOL_KEY_RE` (`mcp.<namespace>.<tool>`),
 * copied because the contract imports only zod and mcp-client doesn't export
 * it. The bridge maps a wire tool name to a grant's stored key, and checks a
 * key's namespace, with the copy; mcp-client answers the call with the
 * original. If the two drift, a key one side accepts the other refuses.
 *
 * Neither package can import the other, so the comparison lives here, where
 * both sources are reachable (relative imports into src, as
 * usage-limits-acceptance.test.ts does), and compares the two regexes
 * themselves rather than either one against a literal pinned in a test.
 *
 * `AGENT_ID_RE` needs no such test: there is one copy, exported from the
 * contract's settings.ts and imported by @ax/apps-bridge's settings routes
 * and @ax/channel-web's client.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTOR_TOOL_KEY_RE } from '../../../../packages/mcp-client/src/connector-inventory/types.js';
import { TOOL_KEY_RE } from '../../../../packages/apps-bridge-contract/src/settings.js';

describe('apps bridge contract: grammars shared with other packages', () => {
  it('TOOL_KEY_RE is @ax/mcp-client CONNECTOR_TOOL_KEY_RE (source and flags)', () => {
    expect(TOOL_KEY_RE.source).toBe(CONNECTOR_TOOL_KEY_RE.source);
    expect(TOOL_KEY_RE.flags).toBe(CONNECTOR_TOOL_KEY_RE.flags);
    // Non-vacuity: both are real, capturing, anchored patterns.
    const key = 'mcp.c0123456789.list_issues';
    expect(TOOL_KEY_RE.exec(key)?.slice(1)).toEqual(['c0123456789', 'list_issues']);
    expect(CONNECTOR_TOOL_KEY_RE.exec(key)?.slice(1)).toEqual(['c0123456789', 'list_issues']);
    expect(TOOL_KEY_RE.test(`x${key}`)).toBe(false);
  });
});
