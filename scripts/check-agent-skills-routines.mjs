#!/usr/bin/env node
// Render the actual SPA against deterministic API fixtures. No design files are changed.
// node scripts/check-agent-skills-routines.mjs http://127.0.0.1:5184 /tmp/ax-settings-visual
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(new URL('../presets/k8s/package.json', import.meta.url))('playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5184').origin;
const output = process.argv[3] ?? '/tmp/ax-settings-visual';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.AX_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.AX_BROWSER_EXECUTABLE_PATH } : {}) });
const agent = { id: 'layout-agent', name: 'Quill', state: 'resting', now: null, counter: null, startedAt: null, stoppedReason: null };
const detail = { agent, conversationId: 'c1', thread: [], decisions: { status: 'ok' }, past: [], memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: false } };
const routine = { agentId: agent.id, path: '.ax/routines/event-review.md', name: 'event-review', description: 'Review incoming events', trigger: { kind: 'webhook', path: '/events', events: ['push'] }, enabled: true, conversation: 'shared', promptBody: 'Review {{payload}} and summarize changes.', activeHours: null, silenceToken: 'NO_CHANGES', silenceMaxChars: 300, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null };
try {
 for (const [width, height, theme] of [[1440,960,'light'], [1440,960,'dark'], [390,844,'light'], [390,844,'dark']]) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addCookies([{ name: 'mock-session', value: 'u2', url: origin }]);
  await context.addInitScript(t => localStorage.setItem('ax-theme', t), theme);
  const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  let enabled = true;
  await page.route('**/admin/bootstrap-status', r => r.fulfill({ json: { status: 'completed' } }));
  await page.route('**/api/workspace/**', r => {
    const path = new URL(r.request().url()).pathname;
    const json = path.endsWith('/state') ? { agents: [agent] }
      : path.endsWith('/decisions') ? { decisions: [] }
      : path.endsWith('/grants') ? { grants: [] }
      : path.endsWith('/activity') ? { events: [], hasMore: false }
      : path.endsWith('/rail') ? { activity: { status: 'ok', items: [] }, permissions: { status: 'ok', rows: [], incomplete: false, unrestrictedTools: false }, grants: { status: 'ok', rows: [], incomplete: false }, counters: { status: 'ok', rows: [], windowDays: 7 } }
      : detail;
    return r.fulfill({ json });
  });
  await page.route('**/api/chat/connections/**', r => r.fulfill({ json: { agentId: agent.id, skills: [{ skillId: 'meeting-notes', description: 'Keep useful notes.', source: 'user', removable: true }, { skillId: 'web-research', description: 'Research topics.', source: 'default', removable: false }] } }));
  await page.route('**/api/chat/catalog-skills', r => r.fulfill({ json: { skills: [{ skillId: 'release-checklist', description: 'Prepare a clear release checklist.', defaultAttached: false, connectors: ['github'] }] } }));
  await page.route(`${origin}/settings/skills`, r => r.fulfill({ json: { skills: [{ id: 'meeting-notes', description: 'Keep useful notes.', version: 1, scope: 'user', connectors: [], defaultAttached: false, updatedAt: '2026-10-09T10:00:00Z' }] } }));
  await page.route(`${origin}/settings/skills/authored`, r => r.fulfill({ json: { skills: [] } }));
  await page.route(`${origin}/settings/skills/meeting-notes`, r => r.fulfill({ json: { id: 'meeting-notes', description: 'Keep useful notes.', version: 1, scope: 'user', connectors: [], defaultAttached: false, manifestYaml: 'name: meeting-notes\ndescription: Keep useful notes.', bodyMd: 'Capture decisions and next steps.', files: [] } }));
  await page.route(`${origin}/settings/routines**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/defaults/skill-reflection')) { enabled = r.request().postDataJSON().enabled; return r.fulfill({ json: { enabled } }); }
    const json = path.endsWith('/webhook-token') ? { token: 'fixture_receiver' }
      : path.endsWith('/defaults') ? { defaults: [{ defaultRoutineId: 'skill-reflection', name: 'Skill reflection', enabled }] }
      : path.endsWith('/fires') ? { fires: [] } : { routines: [routine] };
    return r.fulfill({ json });
  });
  const label = `${width}-${theme}`;
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!overflow, `${label} ${name}: horizontal page overflow`);
    const dialog = page.getByRole('dialog');
    if (await dialog.count()) await dialog.evaluate(el => { el.scrollTop = 0; });
    if (await dialog.count()) {
      const box = await dialog.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width + 1, `${label} ${name}: dialog exceeds viewport`);
      assert(box.y >= 0 && box.y + box.height <= height + 1, `${label} ${name}: dialog exceeds viewport height`);
    }
    await page.screenshot({ path: `${output}/${label}-${name}.png`, fullPage: true });
    if (await dialog.count()) {
      // Scroll the natural form flow to verify every footer remains reachable.
      const last = dialog.getByRole('button', { name: /^(Create skill|Save changes|Create routine|Install for Quill)$/ }).last();
      if (await last.count()) {
        await last.scrollIntoViewIfNeeded();
        const box = await last.boundingBox();
        assert(box.y >= 0 && box.y + box.height <= height, `${label} ${name}: submit is unreachable`);
        if (width < 640) await page.screenshot({ path: `${output}/${label}-${name}-footer.png` });
      }
    }
  }
  await page.goto(`${origin}/workspace/agents/${agent.id}/settings/skills`);
  await page.getByRole('tab', { name: 'Installed', exact: true }).waitFor();
  await page.getByText('Meeting notes', { exact: true }).waitFor();
  await shot('installed');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Instructions', { exact: true }).waitFor();
  await shot('create-skill');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Create');
  await page.getByRole('button', { name: 'Actions for meeting-notes' }).click();
  await page.getByRole('menuitem', { name: 'Edit skill', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Instructions').waitFor();
  assert.equal(await page.getByLabel('Instructions').inputValue(), 'Capture decisions and next steps.');
  await shot('edit-skill');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  await page.getByText('Release checklist', { exact: true }).waitFor();
  await shot('browse');
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await shot('install-review');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await shot('review');
  await page.goto(`${origin}/workspace/agents/${agent.id}/settings/routines`);
  await page.getByRole('tab', { name: 'My routines', exact: true }).waitFor();
  await shot('routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).waitFor();
  await page.getByRole('dialog').getByText('Schedule', { exact: true }).click();
  await shot('new-schedule');
  await page.getByRole('dialog').getByText('Interval', { exact: true }).click();
  await shot('new-interval');
  await page.getByRole('dialog').getByText('Webhook', { exact: true }).click();
  await page.getByLabel('Webhook path', { exact: true }).fill('/new-events');
  await page.getByLabel('Webhook URL', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#routine-webhook-url').value.endsWith('/new-events'));
  assert.equal(await page.getByLabel('Webhook URL').inputValue(), `${origin}/webhooks/fixture_receiver/new-events`);
  await shot('new-webhook');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit event-review', exact: true }).click();
  await page.getByLabel('Webhook path').fill('/edited-events');
  assert.equal(await page.getByLabel('Webhook URL').inputValue(), `${origin}/webhooks/fixture_receiver/edited-events`);
  assert.equal(await page.getByLabel('Events (comma-separated)').inputValue(), 'push');
  await shot('edit-webhook');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Self-improvement', exact: true }).click();
  await page.getByRole('switch').waitFor();
  await shot('self-improvement-enabled');
  await page.getByRole('switch').click();
  await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false');
  await shot('self-improvement-disabled');
  await page.getByRole('button', { name: 'View skills', exact: true }).click();
  await page.getByRole('tab', { name: 'Installed', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(`${label}: settings, forms, focus, URL previews and self-improvement verified`);
  await context.close();
 }
} finally { await browser.close(); }
