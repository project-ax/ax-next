#!/usr/bin/env node
// Local visual/component walk with clearly identified HTTP test data.
// This never connects to kind or substitutes for the live acceptance walk.
// node scripts/check-routines-layout.mjs http://127.0.0.1:5188 /absolute/evidence/dir
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(
  new URL('../presets/k8s/package.json', import.meta.url),
)('playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5188').origin;
const evidence = process.argv[3] ?? '/tmp/task10-routine-preview';
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AX_BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.AX_BROWSER_EXECUTABLE_PATH }
    : {}),
});
const agent = {
  id: 'routine-preview-agent',
  name: 'Caveman',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};
const row = {
  agentId: agent.id,
  routineId: 'preview-routine',
  revision: 'v1',
  origin: 'authored',
  defaultRoutineId: null,
  name: 'Morning brief',
  description: 'A quick check on project progress.',
  promptBody:
    'Review the latest project updates.\nSummarize progress, blockers, and the next actions that need my attention.',
  enabled: true,
  trigger: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' },
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
  conversation: 'per-fire',
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastWarning: null,
  permissions: { edit: true, stop: true, fire: true, manageSecret: true },
};
const detail = {
  agent,
  conversationId: 'preview-conversation',
  thread: [],
  decisions: { status: 'ok' },
  past: [],
  memory: {
    rules: { status: 'unavailable', doc: null },
    factsAvailable: false,
  },
};
try {
  for (const [width, height, label, theme] of [
    [1440, 1080, 'desktop', 'light'],
    [1440, 1080, 'desktop', 'dark'],
    [390, 844, 'mobile', 'light'],
    [390, 844, 'mobile', 'dark'],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.addInitScript(
      (theme) => localStorage.setItem('ax-theme', theme),
      theme,
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/admin/me', (r) =>
      r.fulfill({
        json: {
          user: {
            id: 'preview-human',
            email: 'preview@example.invalid',
            displayName: 'Preview',
            isAdmin: false,
          },
        },
      }),
    );
    await page.route('**/admin/bootstrap-status', (r) =>
      r.fulfill({ json: { status: 'completed' } }),
    );
    await page.route('**/api/workspace/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      const json = path.endsWith('/state')
        ? { agents: [agent] }
        : path.endsWith('/decisions')
          ? { decisions: [] }
          : path.endsWith('/grants')
            ? { grants: [] }
            : path.endsWith('/activity')
              ? { events: [], hasMore: false }
              : path.endsWith('/rail')
                ? {
                    activity: { status: 'ok', items: [] },
                    permissions: {
                      status: 'ok',
                      rows: [],
                      incomplete: false,
                      unrestrictedTools: false,
                    },
                    grants: { status: 'ok', rows: [], incomplete: false },
                    counters: { status: 'ok', rows: [], windowDays: 7 },
                  }
                : path.endsWith('/abilities')
                  ? {
                      abilities: {
                        webSearch: true,
                        readPages: true,
                        runCode: true,
                      },
                    }
                  : detail;
      return r.fulfill({ json });
    });
    const calls = [];
    await page.route('**/settings/routines/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      const method = r.request().method();
      if (method !== 'GET')
        calls.push({ path, method, body: r.request().postDataJSON() });
      const json = path.endsWith('/consent')
        ? { enabled: false, revision: 'consent-v1' }
        : path.endsWith('/receiver')
          ? { url: '/webhooks/TEST-DATA-RECEIVER' }
          : path.endsWith('/defaults')
            ? {
                defaults: [
                  {
                    defaultRoutineId: 'skill-reflection',
                    name: 'Skill reflection',
                    enabled: true,
                  },
                  {
                    defaultRoutineId: 'heartbeat',
                    name: 'Heartbeat',
                    enabled: true,
                  },
                ],
              }
            : path.endsWith('/fires')
              ? { fires: [] }
              : path.endsWith('/preview-routine')
                ? { routine: row }
                : { routines: [row] };
      return r.fulfill({ json });
    });
    await page.goto(`${origin}/workspace/agents/${agent.id}/settings/routines`);
    await page.getByText('Morning brief', { exact: true }).waitFor();
    // Visible provenance prevents these screenshots being mistaken for live acceptance.
    await page.evaluate(() => {
      const label = document.createElement('div');
      label.textContent = 'Local visual preview · HTTP test data';
      label.setAttribute('role', 'note');
      label.style.cssText =
        'position:fixed;bottom:0;left:0;padding:4px 12px;background:var(--background);color:var(--foreground);font-size:12px;z-index:100';
      document.body.append(label);
    });
    await page.evaluate(() => document.fonts.ready);
    assert(
      await page
        .getByText('Ask before creating or editing routines', { exact: true })
        .isVisible(),
    );
    await page.screenshot({
      path: `${evidence}/${label}-${theme}-list-test-data.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'New routine', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).waitFor();
    assert(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      `${label}/${theme}: focus escaped dialog`,
    );
    await dialog.getByLabel('Name', { exact: true }).fill('project-check-in');
    await dialog
      .getByLabel('Description', { exact: true })
      .fill('A quick check on project progress.');
    await dialog.getByLabel('What should Caveman do?').fill(row.promptBody);
    await page.screenshot({
      path: `${evidence}/${label}-${theme}-schedule-test-data.png`,
      fullPage: true,
    });
    await dialog.getByRole('radio', { name: 'Webhook', exact: true }).click();
    assert.equal(
      await dialog
        .getByRole('radio', { name: 'Webhook', exact: true })
        .getAttribute('data-state'),
      'on',
    );
    for (const name of ['Schedule', 'Interval'])
      assert.equal(
        await dialog
          .getByRole('radio', { name, exact: true })
          .getAttribute('data-state'),
        'off',
      );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await dialog
      .getByLabel('Webhook path', { exact: true })
      .fill('/project-updated');
    await dialog.getByLabel('Events (comma-separated)').fill('project_updated');
    await dialog.getByLabel('Webhook URL', { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel('Webhook URL', { exact: true }).inputValue(),
      `${origin}/webhooks/TEST-DATA-RECEIVER/project-updated`,
    );
    assert(
      await dialog
        .getByText('Preview only — inactive until Create routine.')
        .isVisible(),
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${evidence}/${label}-${theme}-webhook-test-data.png`,
      fullPage: true,
    });
    if (label === 'mobile') {
      await dialog.evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        path: `${evidence}/${label}-${theme}-webhook-top-test-data.png`,
        fullPage: true,
      });
    }
    await dialog.getByRole('button', { name: 'Copy webhook URL' }).click();
    await dialog.getByText('Copied webhook URL.').waitFor();
    await dialog.getByRole('button', { name: 'Optional settings' }).click();
    assert(
      await dialog
        .getByRole('switch', { name: 'Active hours', exact: true })
        .isDisabled(),
    );
    await dialog.getByRole('switch', { name: 'Verify HMAC signature' }).click();
    const submit = dialog.getByRole('button', {
      name: 'Create routine',
      exact: true,
    });
    await submit.scrollIntoViewIfNeeded();
    const panel = await dialog.boundingBox();
    const footer = await submit.boundingBox();
    assert(
      panel.width <= width &&
        panel.x >= 0 &&
        panel.x + panel.width <= width + 1,
      `${label}/${theme}: dialog overflow`,
    );
    assert(
      footer.y >= 0 && footer.y + footer.height <= height,
      `${label}/${theme}: submit unreachable`,
    );
    await submit.focus();
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('Tab');
      assert(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        `${label}/${theme}: Tab escaped focus trap`,
      );
    }
    await submit.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${evidence}/${label}-${theme}-optional-test-data.png`,
      fullPage: true,
    });
    if (label === 'mobile')
      await page.screenshot({
        path: `${evidence}/${label}-${theme}-footer-test-data.png`,
        fullPage: true,
      });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Self-improvement', exact: true })
      .click();
    await page
      .getByRole('switch', { name: 'Skill self-improvement for Caveman' })
      .waitFor();
    await page
      .getByRole('switch', { name: 'Heartbeat', exact: true })
      .waitFor();
    await page.screenshot({
      path: `${evidence}/${label}-${theme}-self-improvement-test-data.png`,
      fullPage: true,
    });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      `${label} ${theme}: dialog focus trap, absolute inactive preview, copied feedback, active-hours restriction, footer scrolling, defaults reachable; ${calls.length} writes`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
