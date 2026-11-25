/**
 * AudienceDialog: at the people cap, Just me and Everyone must stay choosable
 * (the cap line tells people to choose Everyone), and only the people search
 * is switched off.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharingView } from '@ax/agents';
import { listAdminAgents } from '@/lib/admin';
import { AUDIENCE_MEMBERS_MAX } from '@/lib/agent-sharing';
import { SHARING_COPY } from '@/lib/sharing-copy';
import { AudienceDialog } from '../AudienceDialog';

vi.mock('@/lib/admin', async (original) => ({
  ...(await original<typeof import('@/lib/admin')>()),
  listAdminAgents: vi.fn(),
  getAdminAgent: vi.fn(),
}));
vi.mock('@/lib/agent-sharing-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-sharing-api')>()),
  searchPeople: vi.fn(),
  setAudience: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listAdminAgents).mockResolvedValue([]);
});

function fullList(): SharingView['audience'] {
  return {
    kind: 'list',
    members: Array.from({ length: AUDIENCE_MEMBERS_MAX }, (_, i) => ({
      type: 'user' as const,
      id: `u-${i}`,
      displayName: `Person ${i}`,
    })),
  } as SharingView['audience'];
}

describe('AudienceDialog at the people cap', () => {
  it('keeps Everyone and Just me choosable; only the people search is off', () => {
    render(
      <AudienceDialog
        open
        agentId="a1"
        agentName="Juniper"
        saved={fullList()}
        ownerIds={new Set(['owner'])}
        onSaved={vi.fn()}
        onOpenConnections={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(SHARING_COPY.picker.peopleCap)).toBeTruthy();
    const field = screen.getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel });
    expect((field as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(field);
    const input = screen.getByPlaceholderText(SHARING_COPY.picker.placeholder) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByText(SHARING_COPY.picker.everyoneOption));
    expect(screen.getByText(SHARING_COPY.audience.everyone)).toBeTruthy();
    expect(screen.queryByText(SHARING_COPY.picker.peopleCap)).toBeNull();
  });
});
