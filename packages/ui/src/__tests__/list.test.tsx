// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IconButton, List, ListRow } from '../index.js';

afterEach(cleanup);

// IconButton's Radix tooltip measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// jsdom replaces the global URL, so resolve from the file path rather than `new URL(..., import.meta.url)`.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../ui.css'), 'utf8');
const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const LONG = 'Quarterly finance export for the leadership offsite — final, really final, version 3';

// Focusable elements in document order (no positive tabindex anywhere), which is the Tab order.
function tabOrder(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'));
  return all.filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('tabindex') !== '-1');
}

describe('List', () => {
  it('renders ul with aria-label and li per row', () => {
    render(
      <List label="Connectors">
        <ListRow title="GitHub" />
        <ListRow title="Linear" />
        <ListRow title="Slack" />
      </List>,
    );
    const list = screen.getByRole('list', { name: 'Connectors' });
    expect(list.tagName).toBe('UL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.tagName)).toEqual(['LI', 'LI', 'LI']);
    expect(items.map((li) => li.textContent)).toEqual(['GitHub', 'Linear', 'Slack']);
  });

  // Pinned mechanism: List draws dividers with a sibling selector on the ul (Tailwind divide-y = `> * ~ *`, so rows
  // 2..n get a top border and nothing follows the last row); rows only reset the UA border widths (preflight is off).
  it('no divider after the last row', () => {
    render(
      <List label="Rows">
        <ListRow title="One" />
        <ListRow title="Two" />
        <ListRow title="Three" />
      </List>,
    );
    const list = screen.getByRole('list', { name: 'Rows' });
    expect(classes(list)).toEqual(expect.arrayContaining(['ax-divide-y', 'ax-divide-solid', 'ax-divide-line-soft']));
    for (const li of within(list).getAllByRole('listitem')) {
      const own = classes(li);
      expect(own).toContain('ax-border-0');
      expect(own.filter((c) => /^ax-border-[tblrxy]$|^ax-divide-/.test(c))).toEqual([]);
    }
    const rule = /\.ax-divide-y > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/border-top-width: calc\(1px \* calc\(1 - var\(--tw-divide-y-reverse\)\)\)/);
    expect(rule).toMatch(/border-bottom-width: calc\(1px \* var\(--tw-divide-y-reverse\)\)/);
    expect(rule).toMatch(/--tw-divide-y-reverse: 0/);
  });

  it('density changes the row classes; comfortable keeps the touch-height floor', () => {
    const rowClass = (density?: 'comfortable' | 'compact') => {
      const { container, unmount } = render(
        <List label="L" {...(density ? { density } : {})}>
          <ListRow title="Row" />
        </List>,
      );
      const row = container.querySelector('li > div');
      const out = classes(row);
      unmount();
      return out;
    };
    const comfortable = rowClass();
    expect(rowClass('comfortable')).toEqual(comfortable);
    const compact = rowClass('compact');
    expect(compact).not.toEqual(comfortable);
    expect(comfortable).toContain('ax-min-h-touch');
    expect(compact).toContain('ax-min-h-touch');
    expect(compact).toContain('md:ax-min-h-none');
  });
});

describe('ListRow', () => {
  it('without onOpen or href the title is plain text', () => {
    const { container } = render(
      <List label="L">
        <ListRow title="GitHub" meta="3 tools" />
      </List>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('[title="GitHub"]')?.textContent).toBe('GitHub');
  });

  it('onOpen: title is the only button named by the title; clicking the row body calls onOpen once', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <List label="L">
        <ListRow title="GitHub" meta="3 tools" description="Issues and pull requests" leading={<span>G</span>} onOpen={onOpen} />
      </List>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const title = screen.getByRole('button', { name: 'GitHub' });
    expect(title.tagName).toBe('BUTTON');
    expect(title.getAttribute('type')).toBe('button');
    expect(title.textContent).toBe('GitHub');
    // The stretched layer: the title's ::after covers the positioned row box, so a click anywhere on the row lands on the
    // title. The title itself must not be positioned or the layer would shrink to the title (geometry: stories.spec.ts).
    expect(classes(title)).toEqual(expect.arrayContaining(['after:ax-absolute', 'after:ax-inset-none', 'after:ax-content-empty']));
    expect(classes(title)).not.toContain('ax-relative');
    const row = container.querySelector('li > div');
    expect(classes(row)).toContain('ax-relative');
    expect(row?.contains(title)).toBe(true);
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Meta, description and leading are not controls of their own.
    expect(within(row as HTMLElement).queryAllByRole('link')).toHaveLength(0);
  });

  it('clicking a trailing button calls its handler and NOT onOpen', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const onToggle = vi.fn();
    render(
      <List label="L">
        <ListRow
          title="GitHub"
          onOpen={onOpen}
          trailing={
            <>
              <input type="checkbox" role="switch" aria-label="Use GitHub" onChange={onToggle} />
              <IconButton label="Remove GitHub" icon={Trash2} onClick={onRemove} />
            </>
          }
        />
      </List>,
    );
    const remove = screen.getByRole('button', { name: 'Remove GitHub' });
    fireEvent.click(remove);
    fireEvent.keyDown(remove, { key: 'Enter' });
    fireEvent.keyUp(remove, { key: ' ' });
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('switch', { name: 'Use GitHub' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    // Trailing sits above the stretched layer, so pointer hits reach it in a real browser.
    const trailing = remove.closest('li > div > *');
    expect(classes(trailing)).toEqual(expect.arrayContaining(['ax-relative', 'ax-z-10']));
    // Exactly one primary action: the trailing controls are siblings of the title, never inside it.
    expect(screen.getByRole('button', { name: 'GitHub' }).contains(remove)).toBe(false);
  });

  it('keyboard: Tab order is title button then trailing controls; Enter on the title opens', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <List label="L">
        <ListRow
          title="GitHub"
          onOpen={onOpen}
          trailing={<IconButton label="Remove GitHub" icon={Trash2} />}
          expandable={{ label: 'Show details for GitHub', content: 'Details' }}
        />
      </List>,
    );
    expect(container.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
    expect(tabOrder(container).map((el) => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
      'GitHub',
      'Remove GitHub',
      'Show details for GitHub',
    ]);
    // Enter/Space come from the native <button>; jsdom doesn't synthesize the click, so the press is a click here
    // and the real key press is in stories-test/stories.spec.ts.
    const title = screen.getByRole('button', { name: 'GitHub' });
    title.focus();
    expect(document.activeElement).toBe(title);
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('href renders a link named by the title', () => {
    render(
      <List label="L">
        <ListRow title="Weekly report" href="/tasks/42" trailing={<IconButton label="Remove Weekly report" icon={Trash2} />} />
      </List>,
    );
    const link = screen.getByRole('link', { name: 'Weekly report' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/tasks/42');
    expect(classes(link)).toEqual(expect.arrayContaining(['after:ax-absolute', 'after:ax-inset-none', 'after:ax-content-empty']));
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Remove Weekly report']);
  });

  it('expandable toggles aria-expanded and shows content', () => {
    render(
      <List label="L">
        <ListRow title="About" meta="Created today" expandable={{ label: 'Show details for About', content: <p>Full details</p> }} />
        <ListRow title="Next" />
      </List>,
    );
    const toggle = screen.getByRole('button', { name: 'Show details for About' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Full details')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const content = screen.getByText('Full details');
    const li = toggle.closest('li');
    expect(li?.contains(content)).toBe(true);
    // Below the row, not inside it (so the stretched layer of an openable row can't cover it).
    expect(content.closest('li > div')).not.toBe(toggle.closest('li > div'));
    const controls = toggle.getAttribute('aria-controls');
    expect(controls && document.getElementById(controls)?.contains(content)).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Full details')).toBeNull();
  });

  it('expandable defaultOpen starts open', () => {
    render(
      <List label="L">
        <ListRow title="About" expandable={{ label: 'Show details for About', content: 'Open now', defaultOpen: true }} />
      </List>,
    );
    expect(screen.getByRole('button', { name: 'Show details for About' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Open now')).toBeTruthy();
  });

  it('long title has truncation class and title attribute', () => {
    const { container } = render(
      <List label="L">
        <ListRow title={LONG} meta={`Edited by ${LONG}`} description={`${LONG}. ${LONG}. ${LONG}.`} onOpen={() => {}} />
        <ListRow title={LONG} />
      </List>,
    );
    const button = screen.getByRole('button', { name: LONG });
    expect(button.getAttribute('title')).toBe(LONG);
    expect(classes(button)).toContain('ax-truncate');
    const [, plainLi] = screen.getAllByRole('listitem');
    const plain = plainLi?.querySelector(`[title="${LONG}"]`);
    expect(classes(plain ?? null)).toContain('ax-truncate');
    // The text column can shrink below its content width (flex items default to min-width:auto).
    const column = button.parentElement;
    expect(classes(column)).toEqual(expect.arrayContaining(['ax-min-w-none', 'ax-flex-1']));
    expect(classes(container.querySelector('[data-part="meta"]'))).toContain('ax-truncate');
    expect(classes(container.querySelector('[data-part="description"]'))).toEqual(
      expect.arrayContaining(['ax-line-clamp-2', 'ax-break-words']),
    );
  });

  it('SSR', () => {
    const html = renderToString(
      <List label="Everything" density="compact">
        <ListRow title="Plain" meta="meta" description="desc" leading={<span>L</span>} />
        <ListRow title="Opens" onOpen={() => {}} trailing={<IconButton label="Remove Opens" icon={Trash2} />} />
        <ListRow title="Link" href="/x" />
        <ListRow title="Expands" expandable={{ label: 'Show details for Expands', content: 'More', defaultOpen: true }} />
      </List>,
    );
    expect(html).toContain('<ul');
    expect(html).toContain('aria-label="Everything"');
    expect(html.match(/<li[\s>]/g)).toHaveLength(4);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('More');
    expect(html).not.toContain('style=');
  });
});
