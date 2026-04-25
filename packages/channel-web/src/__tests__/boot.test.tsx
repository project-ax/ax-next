import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '../App';

describe('boot', () => {
  it('mounts the App without throwing', () => {
    const { container } = render(<App />);
    expect(container.textContent).toContain('boot');
  });
});
