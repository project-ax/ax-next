import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

import { main } from '../main.js';
import { runCredentialsCommand } from '../commands/credentials.js';
import type { Plugin } from '@ax/core';

// ---------------------------------------------------------------------------
// Phase 2 acceptance — credential-proxy round-trips a real Anthropic API
// call. Gated on AX_TEST_ANTHROPIC_KEY (and the claude-agent-sdk's
// platform-specific binary, same gate as claude-sdk-runner.e2e.test.ts).
//
// What we verify:
//   1. agent:invoke through the full topology (orchestrator → proxy →
//      sandbox → SDK runner → api.anthropic.com → back) succeeds.
//   2. event.http-egress fires with classification='llm',
//      credentialInjected=true, host='api.anthropic.com'.
//   3. The IPC bearer (env.authToken) is NEVER sent upstream — the
//      ANTHROPIC_API_KEY header that reaches Anthropic is the real key,
//      substituted by the credential-proxy from the ax-cred:<hex>
//      placeholder. (Verified indirectly: the API call must succeed,
//      and only the real key would.)
//
// CI does NOT have AX_TEST_ANTHROPIC_KEY set; the suite skips
// automatically. Local: set AX_TEST_ANTHROPIC_KEY=<a real key with
// minimal balance> before running.
// ---------------------------------------------------------------------------

function detectClaudeBinary(): boolean {
  if (process.platform !== 'darwin') return false;
  const requireFromHere = createRequire(import.meta.url);
  const variant = `darwin-${process.arch}`;
  try {
    const pkg = requireFromHere.resolve(
      `@anthropic-ai/claude-agent-sdk-${variant}/package.json`,
    );
    return existsSync(path.join(path.dirname(pkg), 'claude'));
  } catch {
    return false;
  }
}

const apiKey = process.env.AX_TEST_ANTHROPIC_KEY;
const skip =
  apiKey === undefined || apiKey.length === 0 || !detectClaudeBinary();

async function mkTmp(): Promise<string> {
  return await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-cred-proxy-')),
  );
}

interface HttpEgressCapture {
  sessionId: string;
  userId: string;
  method: string;
  host: string;
  path: string;
  status: number;
  classification: 'llm' | 'mcp' | 'other';
  credentialInjected: boolean;
  blockedReason?: string;
  timestamp: number;
}

describe.skipIf(skip)('credential-proxy e2e (real Anthropic API)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;
  let originalAnthropicKey: string | undefined;

  beforeEach(async () => {
    tmp = await mkTmp();
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    // The llm-anthropic plugin's init requires this; the credential-proxy
    // path doesn't actually use it (the runner reads the placeholder from
    // process.env.ANTHROPIC_API_KEY which sandbox-subprocess inject from
    // the proxy:open-session envMap). We set a fake here just to satisfy
    // init().
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-for-init';
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (originalAnthropicKey === undefined)
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'round-trips a chat through the credential-proxy with a real API key',
    // Real network round-trip + claude grandchild + SDK; allow generous
    // headroom. CI never runs this — local-only via AX_TEST_ANTHROPIC_KEY.
    { timeout: 60_000 },
    async () => {
      const sqlitePath = path.join(tmp, 'e2e.sqlite');

      // 1. Seed the anthropic-api credential so the proxy can resolve it
      //    at proxy:open-session time. runCredentialsCommand bootstraps
      //    its own minimal plugin set and writes through credentials:set.
      const stdin = Readable.from([apiKey ?? '']);
      const seedCode = await runCredentialsCommand({
        argv: ['set', 'anthropic-api'],
        stdin,
        stdout: () => undefined,
        stderr: () => undefined,
        sqlitePath,
      });
      expect(seedCode).toBe(0);

      // 2. Subscribe to event.http-egress on the chat-path bus by
      //    injecting a recorder plugin via extraPlugins.
      const egressEvents: HttpEgressCapture[] = [];
      const recorderPlugin: Plugin = {
        manifest: {
          name: '@ax/test-egress-recorder',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['event.http-egress'],
        },
        init({ bus }) {
          bus.subscribe<HttpEgressCapture>(
            'event.http-egress',
            '@ax/test-egress-recorder',
            async (_ctx, payload) => {
              egressEvents.push(payload);
              return undefined;
            },
          );
        },
      };

      // 3. Run agent:invoke. cfg.llm = 'anthropic' → CLI loads
      //    @ax/credential-proxy → orchestrator opens proxy:open-session
      //    → sandbox-subprocess injects HTTPS_PROXY + the placeholder
      //    → runner calls api.anthropic.com → proxy substitutes the real
      //    key → response flows back.
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const rc = await main({
        message: 'reply with the single word PONG and nothing else',
        configOverride: {
          llm: 'anthropic',
          runner: 'claude-sdk',
          tools: [],
          sandbox: 'subprocess',
          storage: 'sqlite',
        },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        extraPlugins: [recorderPlugin],
      });

      expect(stderrLines.filter((l) => l.includes('chat terminated'))).toEqual([]);
      expect(rc).toBe(0);
      // Final assistant message should contain PONG (case-insensitive — the
      // model occasionally varies capitalization).
      const out = stdoutLines.join('\n');
      expect(out.toUpperCase()).toContain('PONG');

      // 4. At least one event.http-egress fire matched the LLM call. We
      //    don't assert on the EXACT count (the SDK may issue helper calls
      //    like a session-title summary) — only that one of them is the
      //    real api.anthropic.com call with credential injection.
      const llmEgress = egressEvents.find(
        (e) =>
          e.host === 'api.anthropic.com' &&
          e.classification === 'llm' &&
          e.credentialInjected === true,
      );
      expect(llmEgress, 'expected at least one llm egress with credentialInjected=true').toBeDefined();
      // The blocked reason should be absent on a successful upstream.
      expect(llmEgress?.blockedReason).toBeUndefined();
    },
  );
});
