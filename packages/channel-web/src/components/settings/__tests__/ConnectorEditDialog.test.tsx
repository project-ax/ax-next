import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: 'Read and write Drive.',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const FULL: Connector = {
  ...SUMMARY,
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'token', kind: 'api-key' }],
  },
};

describe('ConnectorEditDialog', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(FULL);
  });
  afterEach(() => vi.restoreAllMocks());

  it('create mode: a blank form, submitting calls createConnector with a slugged id', async () => {
    const onSaved = vi.fn();
    render(
      <ConnectorEditDialog
        target="new"
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'Stripe Billing' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.connectorId).toBe('stripe-billing');
    expect(body.name).toBe('Stripe Billing');
    expect(body.visibility).toBe('private');
    expect(onSaved).toHaveBeenCalled();
  });

  it('create mode: a name-less submit never creates a connector', async () => {
    // The Service-name input is `required`, so the browser blocks submission;
    // the component also guards with `if (!form.name.trim()) return` as
    // defense-in-depth. Either way, createConnector must NOT fire.
    render(
      <ConnectorEditDialog
        target="new"
        open
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const form = (await screen.findByLabelText(/service name/i)).closest('form')!;
    // Submit the form directly (bypasses native validation in jsdom) to exercise
    // the component-level guard, then assert no create happened.
    fireEvent.submit(form);
    await Promise.resolve();
    expect(connectorsLib.createConnector).not.toHaveBeenCalled();
  });

  it('edit mode: prefills from the full connector and patches on save', async () => {
    const onSaved = vi.fn();
    render(
      <ConnectorEditDialog
        target={SUMMARY}
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(name).toHaveValue('Google Drive'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(connectorsLib.patchConnector).toHaveBeenCalledWith(
        'gdrive',
        expect.objectContaining({ connectorId: 'gdrive', name: 'Google Drive' }),
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('exposes the admin-only Sharing + default-on fields', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    expect(screen.getByText(/^Sharing$/i)).toBeInTheDocument();
    expect(screen.getByText(/default-on for all agents/i)).toBeInTheDocument();
  });

  it('keeps the mechanism behind an Advanced disclosure (collapsed by default)', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    // Transport/command fields are hidden until Advanced is expanded.
    expect(screen.queryByLabelText(/transport/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /advanced — how it connects/i }));
    expect(await screen.findByLabelText(/transport/i)).toBeInTheDocument();
  });

  it('surfaces a save error from the server', async () => {
    vi.spyOn(connectorsLib, 'createConnector').mockRejectedValue(
      new Error('connector id taken'),
    );
    render(
      <ConnectorEditDialog
        target="new"
        open
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'Dup' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByText(/connector id taken/i)).toBeInTheDocument(),
    );
  });
});
