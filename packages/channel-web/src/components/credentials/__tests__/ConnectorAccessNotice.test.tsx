import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorAccessNotice } from '../ConnectorAccessNotice';
import { CONNECTOR_ACCESS_KINDS, connectorAccessCopy } from '@/lib/connector-access-copy';

describe('ConnectorAccessNotice', () => {
  it.each(CONNECTOR_ACCESS_KINDS)('%s: renders its own copy, whole', (kind) => {
    render(<ConnectorAccessNotice kind={kind} />);
    const { headline, details } = connectorAccessCopy(kind);
    const notice = screen.getByTestId('connector-access-notice');
    expect(notice).toHaveTextContent(headline);
    expect(notice).toHaveTextContent(details);
  });

  it('is a standing note, not an interrupting alert', () => {
    // The shadcn Alert defaults to role="alert" (an assertive live region). This
    // is a disclosure that is simply THERE, and announcing it as an emergency
    // every time a dialog opens would be its own kind of untruth. It also keeps
    // `getByRole('alert')` meaning "something went wrong" on the surfaces it
    // sits in.
    render(<ConnectorAccessNotice kind="key" />);
    expect(screen.getByRole('note')).toBe(screen.getByTestId('connector-access-notice'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is built on the shadcn Alert, and hides its icon from assistive tech', () => {
    render(<ConnectorAccessNotice kind="key" />);
    const notice = screen.getByTestId('connector-access-notice');
    // Alert's own base classes are the fingerprint of the primitive.
    expect(notice.className).toMatch(/\brounded-lg\b/);
    expect(notice.className).toMatch(/\bborder\b/);
    const icon = notice.querySelector('svg');
    expect(icon).not.toBeNull();
    // Decorative: the sentence carries the meaning, so a screen reader skips the glyph.
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('forwards layout classes to the Alert', () => {
    render(<ConnectorAccessNotice kind="key" className="mt-3 max-w-[660px]" />);
    const notice = screen.getByTestId('connector-access-notice');
    expect(notice.className).toMatch(/\bmt-3\b/);
    expect(notice.className).toMatch(/max-w-\[660px\]/);
  });

  it('uses semantic tokens only (invariant #6): no raw colour anywhere in its source', () => {
    const src = readFileSync(join(__dirname, '..', 'ConnectorAccessNotice.tsx'), 'utf8')
      // Comments may name the colours they avoid.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|green|blue|sky|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\brgb\(|\bhsl\(/);
  });
});
