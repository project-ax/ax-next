import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UsagePricesCard } from '../UsagePricesCard';
import { UsageOverrideEditor } from '../UsageOverrideEditor';
import { PersonalUsageLine } from '../../PersonalUsageLine';
import type { UsageUser } from '@/lib/usage-admin';

afterEach(() => vi.unstubAllGlobals());
function wire() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      return new Response(
        JSON.stringify(
          url === '/api/usage'
            ? {
                spendUsd: 0.3,
                turnsLastHour: 2,
                limits: { dailySpendUsd: 10, turnsPerHour: 100 },
              }
            : (body ?? {}),
        ),
        { status: 200 },
      );
    }),
  );
  return calls;
}
const user = {
  userId: 'u1',
  displayName: 'Sam',
  overrides: { dailySpendUsd: 10 },
} as UsageUser;
describe('Usage follow-ups', () => {
  it('saves and removes an exact model price through the authenticated wire', async () => {
    const calls = wire();
    const onSaved = vi.fn();
    const { rerender } = render(<UsagePricesCard prices={[]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add model price' }));
    fireEvent.change(screen.getByLabelText('Model reference'), {
      target: { value: 'openrouter/vendor/model' },
    });
    fireEvent.change(screen.getByLabelText('Input (USD/M)'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save model price' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: '/admin/usage/prices',
      method: 'PUT',
      body: {
        prices: [{ model: 'openrouter/vendor/model', inputUsdPerMillion: 1 }],
      },
    });
    rerender(<UsagePricesCard prices={onSaved.mock.calls[0]![0]} onSaved={onSaved} />);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove price for openrouter/vendor/model',
      }),
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).toEqual({ prices: [] });
  });
  it('renaming an edited price replaces its previous model entry', async () => {
    const calls = wire();
    const old = {model:'vendor/old',inputUsdPerMillion:1,outputUsdPerMillion:2,cacheReadUsdPerMillion:0,cacheWriteUsdPerMillion:0};
    const onSaved=vi.fn(); render(<UsagePricesCard prices={[old]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', {name:'Edit price for vendor/old'}));
    fireEvent.change(screen.getByLabelText('Model reference'),{target:{value:'vendor/new'}});
    fireEvent.click(screen.getByRole('button', {name:'Save model price'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalled());
    expect(calls[0]!.body).toEqual({prices:[{...old,model:'vendor/new'}]});
  });
  it('clearing a person’s fields removes overrides rather than saving zero limits', async () => {
    const calls = wire();
    const onSaved = vi.fn();
    render(<UsageOverrideEditor user={user} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Daily spend (USD)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save person’s limits' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toEqual({
      url: '/admin/usage/users/u1/limits',
      method: 'DELETE',
      body: undefined,
    });
  });
  it('offers retry instead of crashing on an unexpected successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<PersonalUsageLine />);
    expect(await screen.findByText('Usage unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
  it('shows the signed-in person’s spend against their effective cap', async () => {
    const calls = wire();
    render(<PersonalUsageLine />);
    expect(
      await screen.findByText('$0.30 of $10.00 used in the last 24 hours'),
    ).toBeInTheDocument();
    expect(screen.getByText('2 of 100 messages in the last hour')).toBeInTheDocument();
    expect(calls[0]!.url).toBe('/api/usage');
  });
});
