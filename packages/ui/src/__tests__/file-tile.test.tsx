// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { X } from 'lucide-react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileTile, IconButton, List } from '../index.js';

afterEach(cleanup);

// IconButton's Radix tooltip measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../ui.css'), 'utf8');
const classes = (el: Element | null): string[] => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const LONG = 'report-q3-final-really-final-for-the-leadership-offsite-with-every-appendix-v3.csv';

describe('FileTile', () => {
  it('card: a bordered tile with an icon, the name, and "size · detail"', () => {
    const { container } = render(<FileTile variant="card" name="Q3 report.pdf" kind="pdf" size={1229} detail="Document · PDF" onOpen={() => {}} />);
    const root = container.firstElementChild!;
    expect(root.tagName).toBe('DIV');
    expect(classes(root)).toEqual(expect.arrayContaining(['ax-border', 'ax-border-solid', 'ax-w-full']));
    expect(root.querySelector('[data-part="icon"] svg')).not.toBeNull();
    expect(screen.getByTitle('Q3 report.pdf').textContent).toBe('Q3 report.pdf');
    expect(screen.getByText('1.2 KB · Document · PDF')).toBeTruthy();
  });

  it('row: a borderless list item, for use inside a List', () => {
    render(
      <List label="Artifacts">
        <FileTile variant="row" name="Q3 report" kind="PDF" detail="Document · PDF" onOpen={() => {}} />
      </List>,
    );
    const item = within(screen.getByRole('list', { name: 'Artifacts' })).getByRole('listitem');
    expect(item.tagName).toBe('LI');
    const box = item.firstElementChild!;
    expect(classes(box)).not.toContain('ax-border');
    expect(within(item).getByRole('button', { name: 'Open Q3 report' })).toBeTruthy();
    expect(within(item).getByText('Document · PDF')).toBeTruthy();
  });

  it('chip: inline, two lines, a touch-height minimum and a token-capped width', () => {
    const { container } = render(<FileTile variant="chip" name="budget.csv" kind="text/csv" size={2048} detail="Download" />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(expect.arrayContaining(['ax-inline-flex', 'ax-min-h-touch', 'ax-max-w-file-chip', 'ax-box-border']));
    expect(screen.getByTitle('budget.csv')).toBeTruthy();
    expect(screen.getByText('2 KB · Download')).toBeTruthy();
    for (const c of ['ax-max-w-file-chip', 'ax-min-h-touch']) expect(css).toContain(`.${c}`);
  });

  // Review Focus 2: jsdom can't measure, so pin the mechanism. The stem truncates (min-w-0 + truncate) and the
  // extension is its own node that never shrinks; every ancestor up to the tile lets the stem shrink.
  for (const variant of ['card', 'row', 'chip'] as const) {
    it(`${variant}: a long name truncates the stem and keeps the extension`, () => {
      render(<FileTile variant={variant} name={LONG} onOpen={() => {}} actionLabel="Download" />);
      const name = screen.getByTitle(LONG);
      expect(name.children).toHaveLength(2);
      const [stem, ext] = Array.from(name.children);
      expect(stem!.textContent).toBe(LONG.slice(0, -4));
      expect(ext!.textContent).toBe('.csv');
      expect(classes(stem!)).toEqual(expect.arrayContaining(['ax-truncate', 'ax-min-w-none']));
      expect(classes(ext!)).toEqual(expect.arrayContaining(['ax-shrink-0', 'ax-whitespace-nowrap']));
      expect(classes(name)).toEqual(expect.arrayContaining(['ax-flex', 'ax-min-w-none']));
      // Above the click layer, so hovering the name shows its title.
      expect(classes(name)).toEqual(expect.arrayContaining(['ax-relative', 'ax-z-10']));
      expect(classes(name.closest('[data-part="text"]'))).toEqual(expect.arrayContaining(['ax-min-w-none', 'ax-flex-1']));
      for (const c of ['ax-truncate', 'ax-min-w-none', 'ax-shrink-0', 'ax-whitespace-nowrap']) expect(css).toContain(`.${c}`);
      // The accessible name is the whole name, not the visible truncation.
      expect(screen.getByRole('button', { name: `Download ${LONG}` })).toBeTruthy();
    });
  }

  it('a name with no extension is one truncating node', () => {
    render(<FileTile variant="card" name="Q3 report" />);
    const name = screen.getByTitle('Q3 report');
    expect(name.children).toHaveLength(1);
    expect(classes(name.firstElementChild)).toContain('ax-truncate');
  });

  it('the accessible name is "{actionLabel} {name}", described by the size and detail line', () => {
    render(<FileTile variant="chip" name="report.csv" size={812} detail="Download" actionLabel="Download" onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Download report.csv' });
    const described = (button.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual(['812 B · Download']);
  });

  it('the action label defaults to "Open"', () => {
    render(<FileTile variant="card" name="Q3 report" onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open Q3 report' })).toBeTruthy();
  });

  it('the whole tile is one control: one button, and a click on it opens', () => {
    const onOpen = vi.fn();
    render(<FileTile variant="card" name="Q3 report" detail="Document · PDF" onOpen={onOpen} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Q3 report' }));
    expect(onOpen).toHaveBeenCalledOnce();
    // The click layer stretches over the tile from the button's own ::after.
    expect(classes(screen.getByRole('button'))).toEqual(expect.arrayContaining(['after:ax-absolute', 'after:ax-inset-none']));
  });

  it('without onOpen the tile is not interactive', () => {
    const { container } = render(<FileTile variant="chip" name="notes.txt" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[tabindex]')).toBeNull();
    expect(screen.getByTitle('notes.txt')).toBeTruthy();
  });

  it('no div or p inside the button: only phrasing content', () => {
    render(<FileTile variant="card" name={LONG} size={10} detail="Document" kind="csv" previewUrl="/x.png" status="working" progress={40} onOpen={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.querySelector('div, p')).toBeNull();
    for (const el of Array.from(button.querySelectorAll('*'))) expect(['SPAN', 'svg', 'IMG', 'path']).toContain(el.tagName);
  });

  it('working: busy, spinner shown, label kept, focus kept and clicks swallowed', () => {
    const onOpen = vi.fn();
    const { container, rerender } = render(<FileTile variant="chip" name="budget.csv" actionLabel="Download" onOpen={onOpen} status="ready" />);
    const button = screen.getByRole('button', { name: 'Download budget.csv' });
    expect(button.hasAttribute('aria-busy')).toBe(false);
    button.focus();
    rerender(<FileTile variant="chip" name="budget.csv" actionLabel="Download" onOpen={onOpen} status="working" detail="Downloading…" />);
    const busy = screen.getByRole('button', { name: 'Download budget.csv' });
    expect(busy).toBe(button);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(busy);
    expect(container.querySelector('[data-part="icon"] .ax-animate-spin')).not.toBeNull();
  });

  it('failed: the detail is danger text, and it wraps instead of truncating', () => {
    const message = 'That file is too big to send. The limit is 25 MB.';
    render(<FileTile variant="chip" name="notes.txt" status="failed" detail={message} />);
    const detail = screen.getByText(message);
    expect(classes(detail)).toEqual(expect.arrayContaining(['ax-text-status-danger', 'ax-break-words']));
    expect(classes(detail)).not.toContain('ax-truncate');
    // Real text, never only a tooltip.
    expect(document.querySelector(`[title="${message}"]`)).toBeNull();
  });

  it('a ready detail is muted and truncates', () => {
    render(<FileTile variant="chip" name="notes.txt" status="ready" detail="Ready to send" />);
    expect(classes(screen.getByText('Ready to send'))).toEqual(expect.arrayContaining(['ax-text-fg-muted', 'ax-truncate']));
  });

  it('a tile with a status says its changing detail through one persistent polite status element', () => {
    const { rerender } = render(<FileTile variant="chip" name="a.csv" status="ready" detail="Download" onOpen={() => {}} />);
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('Download');
    rerender(<FileTile variant="chip" name="a.csv" status="working" detail="Downloading…" onOpen={() => {}} />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live.textContent).toBe('Downloading…');
    // Losing its action (the file is gone) keeps the same element, so the change is announced.
    rerender(<FileTile variant="chip" name="a.csv" status="ready" detail="No longer available" />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live.textContent).toBe('No longer available');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a tile without a status has no live region', () => {
    render(<FileTile variant="row" name="Q3 report" detail="Document · PDF" onOpen={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('progress: a native progress bar while working, named by the file', () => {
    const { rerender } = render(<FileTile variant="chip" name="notes.txt" status="working" progress={40} />);
    const bar = screen.getByRole('progressbar', { name: 'notes.txt' }) as HTMLProgressElement;
    expect(bar.tagName).toBe('PROGRESS');
    expect(bar.max).toBe(100);
    expect(bar.value).toBe(40);
    rerender(<FileTile variant="chip" name="notes.txt" status="working" progress={140.4} />);
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(100);
    rerender(<FileTile variant="chip" name="notes.txt" status="working" progress={-3} />);
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(0);
    // A fraction of a zero total is NaN: an empty bar, never a missing value the browser shows as indeterminate.
    rerender(<FileTile variant="chip" name="notes.txt" status="working" progress={Number.NaN} />);
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('0');
    rerender(<FileTile variant="chip" name="notes.txt" status="working" progress={Number.POSITIVE_INFINITY} />);
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('100');
    rerender(<FileTile variant="chip" name="notes.txt" status="ready" progress={100} detail="Ready to send" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a trailing control does not open the tile, and comes after the primary action in tab order', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(
      <FileTile
        variant="chip"
        name="notes.txt"
        onOpen={onOpen}
        trailing={<IconButton label="Remove notes.txt" icon={X} size="sm" onClick={onRemove} />}
      />,
    );
    const remove = screen.getByRole('button', { name: 'Remove notes.txt' });
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Open notes.txt', 'Remove notes.txt']);
    // Trailing sits above the stretched click layer.
    expect(classes(remove.closest('[data-part="trailing"]'))).toEqual(expect.arrayContaining(['ax-relative', 'ax-z-10']));
  });

  it('previewUrl on a card: the image itself, whole, as a bounded preview above the name', () => {
    const { container } = render(<FileTile variant="card" name="cat.png" size={2048} previewUrl="/api/files?id=1" actionLabel="Download" onOpen={() => {}} />);
    expect(container.querySelector('[data-part="icon"]')).toBeNull();
    const box = container.querySelector('[data-part="preview"]')!;
    expect(classes(box)).toEqual(expect.arrayContaining(['ax-h-file-preview', 'ax-w-full', 'ax-overflow-hidden']));
    const img = box.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/files?id=1');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(classes(img)).toEqual(expect.arrayContaining(['ax-object-contain', 'ax-max-h-full', 'ax-max-w-full']));
    // The tile caps its width, and is still one control named by the file, described by its size.
    expect(classes(container.firstElementChild)).toEqual(expect.arrayContaining(['ax-max-w-file-preview', 'ax-flex-col']));
    const button = screen.getByRole('button', { name: 'Download cat.png' });
    expect(button.querySelector('img, div, p')).toBeNull();
    expect(screen.getByText('2 KB')).toBeTruthy();
    for (const c of ['ax-h-file-preview', 'ax-max-w-file-preview', 'ax-object-contain', 'ax-max-h-full']) expect(css).toContain(`.${c}`);
  });

  it('previewUrl on a busy card: the spinner takes the preview box', () => {
    const { container } = render(<FileTile variant="card" name="cat.png" previewUrl="/a.png" status="working" onOpen={() => {}} />);
    const box = container.querySelector('[data-part="preview"]')!;
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('.ax-animate-spin')).not.toBeNull();
  });

  it('previewUrl: a lazy, decorative thumbnail in the icon slot', () => {
    const { container } = render(<FileTile variant="chip" name="cat.png" previewUrl="/api/files?id=1" actionLabel="Download" onOpen={() => {}} />);
    const img = container.querySelector('[data-part="icon"] img')!;
    expect(img.getAttribute('src')).toBe('/api/files?id=1');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.getByRole('button', { name: 'Download cat.png' })).toBeTruthy();
  });

  it('the name is untrusted text: markup in it stays text', () => {
    const { container } = render(<FileTile variant="chip" name="<img src=x onerror=alert(1)>.png" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTitle('<img src=x onerror=alert(1)>.png').textContent).toBe('<img src=x onerror=alert(1)>.png');
  });

  it('renders on the server with no inline style', () => {
    const out = [
      renderToString(<FileTile variant="card" name="a.pdf" size={1} detail="Document" onOpen={() => {}} />),
      renderToString(
        <ul>
          <FileTile variant="row" name="a.pdf" onOpen={() => {}} />
        </ul>,
      ),
      renderToString(<FileTile variant="chip" name="a.pdf" status="working" progress={30} trailing={<span>x</span>} />),
      renderToString(<FileTile variant="chip" name="a.png" previewUrl="/a.png" status="failed" detail="Nope" />),
    ];
    for (const html of out) {
      expect(html).toContain('a.p');
      expect(html).not.toContain('style=');
    }
  });
});
