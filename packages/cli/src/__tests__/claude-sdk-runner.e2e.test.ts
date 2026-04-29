import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Week 6.5d acceptance test — claude-sdk runner end-to-end.
//
// SKIPPED pending PR-B (Phase 6.6) rewrite.
//
// Phase 6 deleted the host-side stub-LLM topology this test relied on
// (the in-sandbox llm-proxy that translated /v1/messages → host llm:call,
// plus @ax/llm-mock / @ax/llm-anthropic and the `skipDefaultLlm` test
// seam). The runner now reaches Anthropic ONLY via @ax/credential-proxy.
//
// The replacement test belongs in PR-B and will exercise:
//
//   host (test process) → @ax/sandbox-subprocess → @ax/agent-claude-sdk-runner
//     → in-process MCP server (for executesIn:'host' tools)
//     → @anthropic-ai/claude-agent-sdk → `claude` (native grandchild)
//       → HTTPS_PROXY = @ax/credential-proxy
//         → stub Anthropic backend (PR-B owns the strategy)
//
// What PR-B's rewrite must verify:
//   1. rc === 0 (chat outcome is `complete`).
//   2. Both the built-in `Bash` tool AND a host-mediated MCP tool fire
//      `tool:pre-call` and `tool:post-call` on the host, in order.
//   3. The MCP-host coverage retired with the deleted mcp-client.e2e.test.ts
//      lands here too (subprocess stdio MCP server round-trip).
//
// Until then, unit-level coverage in
// @ax/agent-claude-sdk-runner/__tests__/main.test.ts continues to exercise
// the SDK runner's mechanics on every platform.
// ---------------------------------------------------------------------------

describe.skip('claude-sdk runner e2e (pending PR-B rewrite)', () => {
  it('PR-B will rewrite this against a stub Anthropic backend', () => {
    // No body — this whole suite is parked.
  });
});
