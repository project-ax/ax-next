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
