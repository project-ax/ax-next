// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Divider, Grid, Inline, Stack } from '../index.js';

describe('layout', () => {
  it('Stack defaults', () => {
    render(<Stack id="s">x</Stack>);
    const el = document.getElementById('s')!;
    expect(el.className).toContain('ax-gap-md');
    expect(el.className).toContain('ax-flex-col');
  });
  it('Inline justify + wrap', () => {
    render(<Inline id="i" justify="between" wrap>x</Inline>);
    const el = document.getElementById('i')!;
    expect(el.className).toContain('ax-justify-between');
    expect(el.className).toContain('ax-flex-wrap');
  });
  it('Grid responsive columns', () => {
    render(<Grid id="g" columns={{ base: 1, md: 7 }}>x</Grid>);
    const el = document.getElementById('g')!;
    expect(el.className).toContain('ax-grid-cols-1');
    expect(el.className).toContain('md:ax-grid-cols-7');
  });
  it('Divider roles', () => {
    const { unmount } = render(<Divider />);
    expect(screen.getByRole('separator').tagName).toBe('HR');
    unmount();
    render(<Divider orientation="vertical" />);
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('vertical');
  });
});
