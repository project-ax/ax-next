import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { Agent } from 'undici';

/**
 * Regression guard for TASK-193 (supply-chain drift, main CI red 2026-06-18..29).
 *
 * The credential-proxy listener forwards upstream via the GLOBAL `fetch` (Node's
 * *bundled* undici), while the test harness, the sandbox bridge, and real
 * sandboxed clients route requests by handing a *standalone* undici dispatcher
 * (`new Agent(...)` / `new ProxyAgent(...)`) to that same `fetch` as the
 * `dispatcher` option. undici's request-handler contract is only compatible
 * ACROSS those two undici copies when their MAJOR versions match.
 *
 * When a floating `undici: ^7.x` range + an unbounded pnpm override
 * (`undici@>=7.0.0 <7.28.0: ">=7.28.0"`) silently resolved the standalone copy
 * to 8.5.0 while Node still bundled 7.x, undici 8.x's `assertRequestHandler`
 * rejected the bundled-7.x handler with
 * `InvalidArgumentError: invalid onRequestStart method` (UND_ERR_INVALID_ARG),
 * breaking 28 cross-package tests that only the push-to-main full suite ran.
 *
 * Two guards, so a future float fails loudly in PR CI (this package's own suite)
 * instead of silently on main:
 *  1. Structural: the standalone undici major must equal Node's bundled undici
 *     major. This is the precise interop invariant and pins the root cause.
 *  2. Behavioural: a standalone-undici dispatcher must actually drive the global
 *     `fetch` without `UND_ERR_INVALID_ARG` — the exact production code path.
 *
 * The fix (do not relax): standalone undici is pinned to an exact 7.x version in
 * packages/credential-proxy and packages/credential-proxy-bridge, and the root
 * override is capped at `<8.0.0` so no `^7.x` consumer can float into 8.x again.
 */
describe('undici cross-copy handler compatibility (TASK-193 guard)', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  async function listen(): Promise<number> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    servers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  it("standalone undici major matches Node's bundled undici major", () => {
    const require = createRequire(import.meta.url);
    const standalone = (require('undici/package.json') as { version: string }).version;
    const bundled = process.versions.undici;

    expect(bundled, 'Node should expose its bundled undici version').toBeTruthy();

    const standaloneMajor = Number(standalone.split('.')[0]);
    const bundledMajor = Number((bundled ?? '0').split('.')[0]);

    expect(
      standaloneMajor,
      `standalone undici ${standalone} must share a major with Node bundled undici ${bundled} ` +
        `(global fetch + standalone dispatcher interop); see TASK-193`,
    ).toBe(bundledMajor);
  });

  it('a standalone-undici dispatcher drives the global fetch without UND_ERR_INVALID_ARG', async () => {
    const port = await listen();
    const dispatcher = new Agent();
    try {
      // This is the listener's / bridge's / sandbox client's shape: the GLOBAL
      // (bundled-undici) fetch handed a STANDALONE-undici dispatcher. On undici
      // 8.x-vs-bundled-7.x this throws `invalid onRequestStart method`.
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await dispatcher.close();
    }
  });
});
