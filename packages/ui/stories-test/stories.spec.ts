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
