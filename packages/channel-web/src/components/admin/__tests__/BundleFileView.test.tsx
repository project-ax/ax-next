import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BundleFileView } from '../BundleFileView';

const FILES = [
  { path: 'SKILL.md', contents: '# Root skill doc' },
  { path: 'scripts/run.py', contents: 'print("hello")' },
];

describe('BundleFileView', () => {
  it('lists every file and shows the first file by default', () => {
    render(<BundleFileView files={FILES} />);
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeTruthy();
    expect(screen.getByText('# Root skill doc')).toBeTruthy();
  });

  it('switches the content pane when a file is selected', () => {
    render(<BundleFileView files={FILES} />);
    fireEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }));
    expect(screen.getByText('print("hello")')).toBeTruthy();
  });

  it('renders untrusted contents as text (no HTML injection)', () => {
    render(<BundleFileView files={[{ path: 'x.md', contents: '<img src=x onerror=alert(1)>' }]} />);
    // The literal string is shown; no <img> element is created.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders an empty state when there are no files', () => {
    render(<BundleFileView files={[]} />);
    expect(screen.getByText('No files.')).toBeTruthy();
  });
});
