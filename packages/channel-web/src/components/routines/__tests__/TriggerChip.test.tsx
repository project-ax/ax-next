import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TriggerChip } from '../TriggerChip';

describe('TriggerChip', () => {
  it('summarizes a webhook with a legacy signature setting as just its path', () => {
    render(<TriggerChip schedule={null} webhook={{ kind: 'webhook', path: '/hook', hmac: { app: 'stripe' } }} />);
    expect(screen.getByTitle('When it runs')).toHaveTextContent(/^webhook \/hook$/);
  });
});
