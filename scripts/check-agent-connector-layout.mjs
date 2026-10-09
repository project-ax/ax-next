#!/usr/bin/env node
// Real-browser regression for connector rows whose expired sign-in needs a
// longer action. jsdom cannot measure layout. Against a local web preview:
// AX_BROWSER_EXECUTABLE_PATH=/path/to/chrome node scripts/check-agent-connector-layout.mjs http://127.0.0.1:5173
// Uses the Playwright dependency already installed in preset-k8s.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../presets/k8s/package.json', import.meta.url))('playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5173').origin;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AX_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.AX_BROWSER_EXECUTABLE_PATH } : {}),
});
const agent = { id: 'layout-agent', name: 'Quill', state: 'resting', now: null, counter: null, startedAt: null, stoppedReason: null };
const detail = { agent, conversationId: null, thread: [], decisions: { status: 'ok' }, past: [], memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: false } };
try {
  for (const width of [320, 768, 900, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    try {
      await context.addCookies([{ name: 'mock-session', value: 'u2', url: origin }]);
      const page = await context.newPage();
      await page.route('**/admin/bootstrap-status', (r) => r.fulfill({ json: { status: 'completed' } }));
      await page.route('**/api/workspace/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        const json = path.endsWith('/state') ? { agents: [agent] }
          : path.endsWith('/decisions') ? { decisions: [] }
          : path.endsWith('/grants') ? { grants: [] }
          : path.endsWith('/activity') ? { events: [], hasMore: false }
          : path.endsWith('/rail') ? { activity: { status: 'ok', items: [] }, permissions: { status: 'ok', rows: [], incomplete: false, unrestrictedTools: false }, grants: { status: 'ok', rows: [], incomplete: false }, counters: { status: 'ok', rows: [], windowDays: 7 } }
          : path.endsWith('/abilities') ? { abilities: { webSearch: true, readPages: true, runCode: true } }
          : path.endsWith('/connectors') ? { connectors: [{ id: 'github', name: 'GitHub', source: 'attached', editable: true, health: 'needs-reconnect', removable: true }], shared: false, manageable: true, connectorsSupported: true, sharedCredentials: false }
          : detail;
        return r.fulfill({ json });
      });
      await page.goto(`${origin}/workspace/agents/layout-agent/settings/connectors`);
      const row = page.getByRole('button', { name: 'Edit GitHub', exact: true });
      await row.waitFor();
      const measured = await row.evaluate((el) => {
        const name = el.querySelector('[data-testid="connector-name-github"]');
        const status = name.nextElementSibling;
        const nameRect = name.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(name);
        const textRect = text.getBoundingClientRect();
        return {
          nameWidth: nameRect.width,
          textWidth: textRect.width,
          statusWidth: statusRect.width,
          left: nameRect.left,
          right: nameRect.right,
          viewport: innerWidth,
        };
      });
      assert(measured.nameWidth >= measured.textWidth && measured.nameWidth > 0, `${width}px: connector name is clipped or hidden: ${JSON.stringify(measured)}`);
      assert(measured.statusWidth >= 100, `${width}px: connector status has no readable width: ${JSON.stringify(measured)}`);
      assert(measured.left >= 0 && measured.right <= measured.viewport, `${width}px: connector identity is off-screen`);
      const signin = page.getByRole('button', { name: 'Sign in again', exact: true });
      assert(await signin.isVisible(), `${width}px: sign-in action is unavailable`);
      await signin.click();
      await page.getByRole('dialog').getByRole('heading', { name: 'Sign in to GitHub again', exact: true }).waitFor();
      console.log(`${width}px: connector name/status readable; Sign in again works`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
