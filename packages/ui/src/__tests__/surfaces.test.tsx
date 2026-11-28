// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar, Card, InsetBlock, KeyValueList } from '../index.js';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const CARD_MSG = 'Card: cards do not nest — use InsetBlock for quoted or preview content (§6.3 rule 10).';

describe('Avatar', () => {
  it('takes the first letters of the first two words, uppercase', () => {
    const { container, unmount } = render(<Avatar name="Quill Bot" />);
    expect(container.textContent).toBe('QB');
    unmount();
    const r2 = render(<Avatar name="juniper" />);
    expect(r2.container.textContent).toBe('J');
    r2.unmount();
    expect(render(<Avatar name="a b c" />).container.textContent).toBe('AB');
  });

  it('is aria-hidden by default and an image named by name with label', () => {
    const { container, unmount } = render(<Avatar name="Quill Bot" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    unmount();
    render(<Avatar name="Quill Bot" label />);
    expect(screen.getByRole('img', { name: 'Quill Bot' })).toBeTruthy();
  });

  it('maps the four sizes to four distinct size classes', () => {
    const sizes = (['xs', 'sm', 'md', 'lg'] as const).map((size) => {
      const { container, unmount } = render(<Avatar name="Q" size={size} />);
      const cls = container.firstElementChild?.className.split(' ').find((c) => c.startsWith('ax-w-avatar-'));
      unmount();
      return cls;
    });
    expect(new Set(sizes).size).toBe(4);
    expect(sizes.every(Boolean)).toBe(true);
  });
});

describe('KeyValueList', () => {
  it('renders a dl with dt/dd pairs in order, wrapped values included', () => {
    const { container } = render(
      <KeyValueList
        items={[
          { label: 'Owner', value: 'Vinay' },
          { label: 'Created', value: <b>Today</b> },
        ]}
      />,
    );
    const dl = container.querySelector('dl');
    expect(dl).not.toBeNull();
    const kids = Array.from(dl!.querySelectorAll('dt, dd')).map((e) => `${e.tagName}:${e.textContent}`);
    expect(kids).toEqual(['DT:Owner', 'DD:Vinay', 'DT:Created', 'DD:Today']);
  });

  it('draws visible dividers between rows only (border-t + border-solid after the first)', () => {
    const { container } = render(
      <KeyValueList
        items={[
          { label: 'a', value: '1' },
          { label: 'b', value: '2' },
          { label: 'c', value: '3' },
        ]}
      />,
    );
    const rows = Array.from(container.querySelectorAll('dl > div'));
    expect(rows[0]?.className).not.toContain('ax-border-t');
    for (const row of rows.slice(1)) {
      expect(row.className).toContain('ax-border-t');
      expect(row.className).toContain('ax-border-solid');
      expect(row.className).toContain('ax-border-0');
    }
  });

  it('lets a long label wrap too', () => {
    const { container } = render(<KeyValueList items={[{ label: 'L'.repeat(80), value: 'v' }]} />);
    const dt = container.querySelector('dt')!;
    expect(dt.className).toContain('ax-break-words');
    expect(dt.className).not.toContain('ax-shrink-0');
  });

  it('lets long values wrap in both layouts', () => {
    for (const layout of ['rows', 'stacked'] as const) {
      const { container, unmount } = render(<KeyValueList layout={layout} items={[{ label: 'k', value: 'x'.repeat(200) }]} />);
      const dd = container.querySelector('dd')!;
      expect(dd.className).toContain('ax-break-words');
      expect(dd.className).toContain('ax-min-w-none');
      unmount();
    }
  });
});

describe('Card and InsetBlock', () => {
  it('Card inside Card reports once, even under StrictMode, and still renders', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <StrictMode>
        <Card>
          <Card>inner</Card>
        </Card>
      </StrictMode>,
    );
    expect(screen.getByText('inner')).toBeTruthy();
    const mine = err.mock.calls.filter((c) => c[0] === CARD_MSG);
    expect(mine).toHaveLength(1);
  });

  it('Card inside Card reports once without StrictMode, and not again on re-render', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ui = (
      <Card>
        <Card>inner</Card>
      </Card>
    );
    const { rerender } = render(ui);
    rerender(ui);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(CARD_MSG);
  });

  it('Card + InsetBlock is allowed, silently', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Card>
        <InsetBlock>quote</InsetBlock>
      </Card>,
    );
    expect(err).not.toHaveBeenCalled();
  });

  it('InsetBlock inside InsetBlock reports and still renders', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <InsetBlock>
        <InsetBlock>deep</InsetBlock>
      </InsetBlock>,
    );
    expect(screen.getByText('deep')).toBeTruthy();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('InsetBlock');
  });

  it('stays quiet in production', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    render(
      <Card>
        <Card>x</Card>
      </Card>,
    );
    expect(err).not.toHaveBeenCalled();
  });

  it('Card label names a region; without it there is no region', () => {
    const { unmount } = render(<Card label="Details">x</Card>);
    expect(within(screen.getByRole('region', { name: 'Details' })).getByText('x')).toBeTruthy();
    unmount();
    render(<Card>x</Card>);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('flush drops padding; padded Card has it', () => {
    const a = render(<Card flush>x</Card>);
    expect(a.container.firstElementChild?.className).not.toContain('ax-p-lg');
    a.unmount();
    const b = render(<Card>x</Card>);
    expect(b.container.firstElementChild?.className).toContain('ax-p-lg');
  });
});

describe('SSR', () => {
  it('renders all four on the server without inline style or errors', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderToString(
      <Card label="C" flush>
        <Avatar name="Quill Bot" label />
        <KeyValueList items={[{ label: 'a', value: 'b' }]} layout="stacked" />
        <InsetBlock label="I">
          <InsetBlock>nested on the server</InsetBlock>
        </InsetBlock>
        <Card>nested card</Card>
      </Card>,
    );
    expect(html).toContain('QB');
    expect(html).toContain('<dl');
    expect(html).not.toContain('style=');
    expect(err).not.toHaveBeenCalled();
  });
});
