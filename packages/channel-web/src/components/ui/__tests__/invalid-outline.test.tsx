// @vitest-environment jsdom
/**
 * An invalid field that doesn't look invalid.
 *
 * Only `InputGroup` drew `aria-invalid`. A plain `Input` or `Textarea` with
 * `aria-invalid="true"` looked exactly like a valid one, so about a dozen
 * screens marked a field wrong for screen readers and nobody else. The task
 * dialog worked around it per control, and its "Note for you" field still
 * slipped through. The primitives now draw it themselves.
 *
 * jsdom has no stylesheet, so these check the classes that carry the outline.
 * That alone let a class through that drew nothing: Tailwind 3 has no
 * `aria-invalid:` variant and silently emits no CSS for it, so the last test
 * keeps the bare form out of the source.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '../input';
import { Textarea } from '../textarea';
import { InputGroup, InputGroupInput, InputGroupTextarea } from '../input-group';

describe('Input and Textarea draw aria-invalid', () => {
  it('outline and focus ring turn destructive when aria-invalid is set', () => {
    render(<><Input aria-label="Name" aria-invalid /><Textarea aria-label="Note" aria-invalid /></>);
    for (const control of [screen.getByLabelText('Name'), screen.getByLabelText('Note')]) {
      expect(control).toHaveAttribute('aria-invalid', 'true');
      expect(control).toHaveClass('aria-[invalid=true]:border-destructive', 'aria-[invalid=true]:focus-visible:ring-destructive');
    }
  });

  it('inside an InputGroup the group draws it, and the inner control stays borderless', () => {
    render(
      <>
        <InputGroup><InputGroupInput aria-label="Search" aria-invalid /></InputGroup>
        <InputGroup><InputGroupTextarea aria-label="Body" aria-invalid /></InputGroup>
      </>,
    );
    for (const control of [screen.getByLabelText('Search'), screen.getByLabelText('Body')]) {
      expect(control).toHaveClass('border-0', 'focus-visible:ring-0');
    }
  });
});

describe('the aria-invalid variant is one Tailwind 3 builds', () => {
  it('no source file uses the bare aria-invalid: variant (write aria-[invalid=true]: instead)', () => {
    const SRC = join(__dirname, '..', '..', '..');
    const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(tsx|ts)$/.test(entry.name) && !entry.parentPath.includes('__tests__'))
      .map(entry => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter(path => /(^|[\s"'`:])aria-invalid:[a-z]/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
