#!/usr/bin/env node
// Real-browser regression for responsive Memory settings and labelled rail tabs.
// jsdom cannot measure label bounds. Against a local web preview:
// AX_BROWSER_EXECUTABLE_PATH=/path/to/chrome node scripts/check-agent-memory-layout.mjs http://127.0.0.1:5173
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
const statement = { id: 'm1', about: 'user', relation: 'lives_in', value: 'Denver', when: '2026-10-08T00:30:00.000Z', kind: 'world', sourceTurnId: 't1' };
const detail = { agent, conversationId: 'c1', thread: [{ kind: 'user', id: 't1', text: 'I live in Denver' }], decisions: { status: 'ok' }, past: [], memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: true } };
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    try {
      await context.addCookies([{ name: 'mock-session', value: 'u2', url: origin }]);
      const page = await context.newPage();
      await page.route('**/admin/bootstrap-status', (r) => r.fulfill({ json: { status: 'completed' } }));
      await page.route('**/api/chat/conversations/*/memory-events', (r) => r.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"status","extraction":"ok","conversation":"idle"}\n\n' }));
      await page.route('**/api/workspace/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        const json = path.endsWith('/state') ? { agents: [agent] }
          : path.endsWith('/decisions') ? { decisions: [] }
          : path.endsWith('/grants') ? { grants: [] }
          : path.endsWith('/activity') ? { events: [], hasMore: false }
          : path.endsWith('/rail') ? { activity: { status: 'ok', items: [] }, permissions: { status: 'ok', rows: [], incomplete: false, unrestrictedTools: false }, grants: { status: 'ok', rows: [], incomplete: false }, counters: { status: 'ok', rows: [], windowDays: 7 } }
          : path.endsWith('/memory/recall') ? { statements: [statement], degraded: [] }
          : detail;
        return r.fulfill({ json });
      });
      await page.goto(`${origin}/workspace/agents/layout-agent/memory`);
      await page.getByLabel('Search memories', { exact: true }).waitFor();
      await page.getByRole('region', { name: 'Memories', exact: true }).getByText('Denver', { exact: true }).waitFor();
      assert(page.url().endsWith('/settings/memory'), 'Legacy Memory URL did not canonicalize');
      const tables = await page.getByRole('table').count();
      assert.equal(tables, width < 768 ? 0 : 1, `${width}px: wrong memory table/card shape`);
      if (tables) {
        assert.deepEqual(await page.getByRole('columnheader').allTextContents(), ['Kind', 'What Quill remembers', 'Noted', 'Actions']);
        const statementWidth = await page.getByRole('row').nth(1).getByRole('cell').nth(1).evaluate((el) => el.getBoundingClientRect().width);
        assert(statementWidth >= 140, `${width}px: memory statement column is unreadable (${statementWidth}px)`);
        const textWidth = await page.getByRole('row').nth(1).getByRole('cell').nth(1).locator('div').evaluate((el) => el.getBoundingClientRect().width);
        assert(textWidth >= 110, `${width}px: statement text is squeezed by cell padding (${textWidth}px)`);
      }
      const searchWidth = await page.getByLabel('Search memories', { exact: true }).evaluate((el) => el.getBoundingClientRect().width);
      assert(searchWidth >= 120, `${width}px: search field collapsed (${searchWidth}px)`);
      const geometry = await page.getByRole('region', { name: 'Memories', exact: true }).evaluate((el) => ({
        left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert(!geometry.overflow && geometry.left >= 0 && geometry.right <= geometry.viewport, `${width}px: manager overflows ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `/tmp/ax-autoship-restyle/TASK-890/memory-${width}.png` });
      if (width < 768) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Chat', exact: true }).click();
        await page.getByRole('button', { name: /Agent details/ }).click();
      } else {
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      }
      const tabs = page.getByRole('tab');
      assert.deepEqual(await tabs.allTextContents(), ['Chats', 'Files', 'Activity']);
      await page.getByText('Learned in this chat', { exact: true }).waitFor();
      for (const tab of await tabs.all()) {
        const size = await tab.evaluate((el) => {
          const span = el.querySelector('span');
          const a = el.getBoundingClientRect(), b = span.getBoundingClientRect();
          return { width: b.width, fits: b.left >= a.left && b.right <= a.right };
        });
        assert(size.width > 0 && size.fits, `${width}px: clipped rail tab label`);
      }
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      assert(await page.getByText('Learned in this chat', { exact: true }).isVisible(), 'Learned card disappeared on Activity');
      await page.getByRole('button', { name: /^from your message/i }).click();
      await page.locator('[data-memory-source="flash"]').waitFor({ state: 'attached' });
      await page.screenshot({ path: `/tmp/ax-autoship-restyle/TASK-890/rail-${width}.png` });
      console.log(`${width}px: Memory manager, rail labels, pinned facts and source jump pass`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
