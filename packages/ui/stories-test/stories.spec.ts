import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

interface IndexEntry {
  id: string;
  type: 'story' | 'docs';
}

// Built by `storybook build` (stories:test runs it first). Every story is checked in both themes.
const index = JSON.parse(readFileSync(new URL('../storybook-static/index.json', import.meta.url), 'utf8')) as {
  entries: Record<string, IndexEntry>;
};
const stories = Object.values(index.entries).filter((e) => e.type === 'story');
const themes = ['light', 'dark'] as const;

test('the index has stories', () => {
  expect(stories.length).toBeGreaterThan(0);
});

for (const { id } of stories) {
  for (const theme of themes) {
    test(`${id} (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 600 });
      await page.goto(`/iframe.html?id=${id}&globals=theme:${theme}&viewMode=story`);
      await page.locator('#storybook-root > *').first().waitFor();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => document.fonts.ready);

      const { violations } = await new AxeBuilder({ page }).analyze();
      const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        blocking.map((v) => v.id),
        `serious/critical axe violations:\n${blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n')}`,
      ).toEqual([]);

      await expect(page).toHaveScreenshot(`${id}-${theme}.png`, { fullPage: true });
    });
  }
}

// Real layout: a badge in a 390px box must end inside it (jsdom can't measure). Padding counts, so it needs border-box.
test('components-statusbadge--long-text stays inside its 390px box', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/iframe.html?id=components-statusbadge--long-text&viewMode=story');
  const badge = page.locator('#storybook-root span[title]').first().locator('xpath=..');
  await badge.waitFor();
  const box = await badge.boundingBox();
  const container = await page.locator('#storybook-root > div').first().boundingBox();
  expect(box && container).toBeTruthy();
  expect(container!.width).toBe(390);
  expect(box!.x + box!.width).toBeLessThanOrEqual(container!.x + container!.width + 0.5);
});

// ListRow at 390px: rows, the title control and the trailing button all end inside the box, and nothing scrolls sideways.
test('components-list--long-title stays inside its 390px box', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/iframe.html?id=components-list--long-title&viewMode=story');
  const container = page.locator('#storybook-root > div').first();
  await page.getByRole('list', { name: 'Long names' }).waitFor();
  const box = (await container.boundingBox())!;
  expect(box.width).toBe(390);
  const right = box.x + box.width + 0.5;
  for (const el of await page.locator('#storybook-root li, #storybook-root li button, #storybook-root li [title]').all()) {
    const b = (await el.boundingBox())!;
    expect(b.x + b.width, await el.evaluate((n) => n.outerHTML.slice(0, 80))).toBeLessThanOrEqual(right);
  }
  expect(await container.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
  // The long title really is truncated (and the trailing control kept its size).
  const title = page.getByRole('button', { name: /^Quarterly finance export/ });
  expect(await title.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  const remove = (await page.getByRole('button', { name: /^Remove Quarterly/ }).boundingBox())!;
  expect(remove.width).toBeGreaterThanOrEqual(36);
});

// List owns the dividers: a top border on rows 2..n only, nothing on the first row's top or the last row's bottom.
test('components-list--basic draws dividers between rows only', async ({ page }) => {
  await page.goto('/iframe.html?id=components-list--basic&viewMode=story');
  await page.getByRole('list', { name: 'Connectors' }).waitFor();
  const widths = await page.locator('#storybook-root li').evaluateAll((lis) =>
    lis.map((li) => {
      const s = getComputedStyle(li);
      return [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderRightWidth].join(' ');
    }),
  );
  expect(widths).toEqual(['0px 0px 0px 0px', '1px 0px 0px 0px', '1px 0px 0px 0px']);
});

// Review Focus 3: the row opens from anywhere on it, but never from its own trailing controls.
test('components-list--openable-with-trailing-switch: row body opens, trailing controls do not', async ({ page }) => {
  await page.goto('/iframe.html?id=components-list--openable-with-trailing-switch&viewMode=story');
  const status = page.getByText(/^Opened: /);
  await expect(status).toHaveText('Opened: nothing yet');
  const row = page.getByRole('listitem').filter({ hasText: 'GitHub' });
  const rb = (await row.boundingBox())!;
  const tb = (await page.getByRole('button', { name: 'GitHub', exact: true }).boundingBox())!;
  // Off the title text: on the description line, near the row's left edge, and in the gap before the trailing controls.
  await page.mouse.click(rb.x + 4, rb.y + rb.height - 6);
  await expect(status).toHaveText('Opened: GitHub');
  const sw = page.getByRole('switch', { name: 'Use GitHub' });
  const sb = (await sw.boundingBox())!;
  const p = { x: sb.x - 24, y: sb.y + sb.height / 2 };
  const onTitle = p.x >= tb.x && p.x <= tb.x + tb.width && p.y >= tb.y && p.y <= tb.y + tb.height;
  expect(onTitle).toBe(false);
  await page.mouse.click(p.x, p.y);
  await expect(status).toHaveText('Opened: GitHub, GitHub');
  // Trailing: the switch toggles and the row stays shut; same for keyboard.
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toBeChecked();
  await expect(status).toHaveText('Opened: GitHub, GitHub');
  // Tab order: title, then the trailing controls, then the next row's title. Enter on the title opens.
  await page.getByRole('button', { name: 'GitHub', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Opened: GitHub, GitHub, GitHub');
  const focused = async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent);
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Use GitHub');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Remove GitHub');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Linear');
  // Keyboard-activating a trailing button doesn't open its row either.
  await page.getByRole('button', { name: 'Remove GitHub' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('switch', { name: 'Use GitHub' })).toHaveCount(0);
  await expect(status).toHaveText('Opened: GitHub, GitHub, GitHub');
});

// Expand-only rows toggle from anywhere on the row, with one Tab stop; the chevron is decorative.
test('components-list--expandable: an expand-only row toggles from the row body', async ({ page }) => {
  await page.goto('/iframe.html?id=components-list--expandable&viewMode=story');
  const toggle = page.getByRole('button', { name: 'Schedule', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Runs weekly.')).toHaveCount(0);
  const row = page.getByRole('listitem').filter({ hasText: 'Schedule' });
  const rb = (await row.boundingBox())!;
  // Far right, on the decorative chevron: not the title text.
  await page.mouse.click(rb.x + rb.width - 12, rb.y + rb.height / 2);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Runs weekly.')).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Last run');
});

// The trailing controls' z-index stays inside the row (the row box is isolated): a fixed header earlier in the page at
// the same z-index still paints over a switch scrolled under it.
test('components-list--openable-with-trailing-switch: an overlay above the row wins over trailing controls', async ({ page }) => {
  await page.goto('/iframe.html?id=components-list--openable-with-trailing-switch&viewMode=story');
  const sw = page.getByRole('switch', { name: 'Use GitHub' });
  const sb = (await sw.boundingBox())!;
  await page.evaluate(() => {
    const header = document.createElement('div');
    header.id = 'sticky-fixture';
    Object.assign(header.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '200px', zIndex: '10', background: 'gray' });
    document.body.prepend(header);
  });
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x!, y!);
      return el?.id || `${el?.tagName} ${el?.getAttribute('aria-label') ?? ''}`;
    },
    [sb.x + sb.width / 2, sb.y + sb.height / 2],
  );
  expect(hit).toBe('sticky-fixture');
});

// TimelineEntry at 390px: every entry, its time and its link end inside the box, and the long text is clamped (not wrapped
// to full height) so a row stays a few lines tall.
test('components-timeline--long-text stays inside its 390px box', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/iframe.html?id=components-timeline--long-text&viewMode=story');
  const container = page.locator('#storybook-root > div').first();
  await page.getByRole('list', { name: 'Long entries' }).waitFor();
  const box = (await container.boundingBox())!;
  expect(box.width).toBe(390);
  const right = box.x + box.width + 0.5;
  for (const el of await page.locator('#storybook-root li, #storybook-root li time, #storybook-root li a, #storybook-root li p').all()) {
    const b = (await el.boundingBox())!;
    expect(b.x + b.width, await el.evaluate((n) => n.outerHTML.slice(0, 80))).toBeLessThanOrEqual(right);
  }
  expect(await container.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
  const link = (await page.getByRole('link', { name: 'See what it did, 5 min ago' }).boundingBox())!;
  expect(link.width).toBeGreaterThanOrEqual(24);
  // Clamped to two lines: the first entry's text box is no taller than two computed lines.
  const textEl = page.locator('#storybook-root li').first().locator('[data-part="text"]');
  const text = (await textEl.boundingBox())!;
  const lineHeight = await textEl.evaluate((n) => parseFloat(getComputedStyle(n).lineHeight));
  expect(lineHeight).toBeGreaterThan(0);
  expect(text.height).toBeLessThanOrEqual(2 * lineHeight + 2);
});
