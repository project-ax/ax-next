import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelCombobox } from '../ModelCombobox';

const groups = [
  {
    providerName: 'Anthropic',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
];

describe('ModelCombobox', () => {
  it('renders the disabled trigger when no providers are configured', () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={[]}
        value=""
        onChange={vi.fn()}
        disabled
      />,
    );
    const trigger = screen.getByRole('combobox', { name: /fast model/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it('clicking the trigger opens the popover with grouped options', async () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={groups}
        value=""
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: /fast model/i }));
    expect(await screen.findByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('claude-opus-4-7')).toBeTruthy();
  });

  it('selecting an option calls onChange with the model id', async () => {
    const onChange = vi.fn();
    render(
      <ModelCombobox
        ariaLabel="Runner model"
        groups={groups}
        value=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: /runner model/i }));
    const option = await screen.findByText('claude-sonnet-4-6');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('typing into the search input filters options', async () => {
    render(
      <ModelCombobox
        ariaLabel="Fast model"
        groups={groups}
        value=""
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: /fast model/i }));
    const input = await screen.findByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: 'haiku' } });
    expect(screen.getByText(/claude-haiku-4-5-20251001/)).toBeTruthy();
    expect(screen.queryByText('claude-opus-4-7')).toBeNull();
  });
});
