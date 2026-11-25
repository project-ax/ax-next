/**
 * Owners (TASK-1247): the list, Add owner with its plain confirmation, and
 * Remove. Acceptance tests: each drives the list the way a person would and
 * pins the exact owners write. The whole list is written every time, so a
 * write built from the wrong list drops an owner, or brings one back.
 *
 * Owners are Vinay (creator) and Bob; you are Vinay unless a test says
 * otherwise. Words come from SHARING_COPY; tests never repeat a sentence.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharingView } from '@ax/agents';
import { OWNERS_MAX } from '@/lib/agent-sharing';
import { searchPeople, setOwners, SharingRequestError } from '@/lib/agent-sharing-api';
import type { AuthUser } from '@/lib/auth';
import { SHARING_COPY } from '@/lib/sharing-copy';
import { UserProvider } from '@/lib/user-context';
import { AgentOwners } from '../AgentOwners';

vi.mock('@/lib/agent-sharing-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-sharing-api')>()),
  setOwners: vi.fn(),
  searchPeople: vi.fn(),
}));

const setOwnersMock = vi.mocked(setOwners);
const searchMock = vi.mocked(searchPeople);

type Owner = SharingView['owners'][number];

const FERN = 'Fern';
const VINAY: Owner = { id: 'vinay', displayName: 'Vinay', creator: true };
const BOB: Owner = { id: 'bob', displayName: 'Bob', creator: false };
const CAROL_OWNER: Owner = { id: 'carol', displayName: 'Carol', creator: false };
const CAROL = { id: 'carol', displayName: 'Carol' };
const NAMES: Record<string, string> = { vinay: 'Vinay', bob: 'Bob', carol: 'Carol' };

/** Bidi override, built from a code so no typed escape decodes into the literal character. */
const RLO = String.fromCharCode(0x202e);

function person(id: string, name: string): AuthUser {
  return { id, email: `${id}@example.com`, name, role: 'user' };
}
const AS_VINAY = person('vinay', 'Vinay');
const AS_BOB = person('bob', 'Bob');

/** AgentOwners as AgentSharing holds it: each save's answer replaces the list. */
function Section({ initial }: { initial: Owner[] }) {
  const [owners, setOwnersState] = useState(initial);
  return (
    <AgentOwners
      agentId="agt_fern"
      agentName={FERN}
      owners={owners}
      onSaved={(sharing) => setOwnersState(sharing.owners)}
    />
  );
}

function renderOwners(owners: Owner[], me: AuthUser | null = AS_VINAY) {
  const section = <Section initial={owners} />;
  return render(me === null ? section : <UserProvider value={me}>{section}</UserProvider>);
}

const ownersList = () => screen.getByRole('list', { name: SHARING_COPY.owners.heading });
const rows = () => within(ownersList()).getAllByRole('listitem');
const removeButton = (name: string) =>
  screen.getByRole('button', { name: SHARING_COPY.owners.remove(name) });

async function openAddOwner(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: SHARING_COPY.owners.add }));
  return screen.findByRole('dialog', { name: SHARING_COPY.owners.addTitle(FERN) });
}

function search(dialog: HTMLElement, query: string) {
  fireEvent.click(within(dialog).getByRole('combobox', { name: SHARING_COPY.owners.fieldLabel }));
  fireEvent.change(screen.getByPlaceholderText(SHARING_COPY.owners.placeholder), {
    target: { value: query },
  });
}

async function pickPerson(dialog: HTMLElement, query: string, name: string) {
  search(dialog, query);
  fireEvent.click(await screen.findByRole('option', { name }));
}

/** Add owner → pick `name` → the confirmation that names them. */
async function confirmationFor(query: string, name: string): Promise<HTMLElement> {
  await pickPerson(await openAddOwner(), query, name);
  return screen.findByRole('dialog', { name: SHARING_COPY.owners.confirmTitle(name, FERN) });
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue([CAROL]);
  // The server answers with the owners as saved: echo what was sent.
  setOwnersMock.mockImplementation(async (_agentId, userIds) => ({
    audience: { kind: 'just-me' },
    owners: userIds.map((id) => ({ id, displayName: NAMES[id] ?? null, creator: id === 'vinay' })),
  }));
});

describe('AgentOwners — the list', () => {
  it('lists the owners with the creator first, marked, and marks you', () => {
    const { unmount } = renderOwners([VINAY, BOB]);
    const [creator, bob] = rows();
    expect(within(creator!).getByText('Vinay')).toBeTruthy();
    expect(within(creator!).getByText(SHARING_COPY.owners.creator)).toBeTruthy();
    expect(within(creator!).getByText(SHARING_COPY.owners.you)).toBeTruthy();
    expect(within(bob!).getByText('Bob')).toBeTruthy();
    expect(within(bob!).queryByText(SHARING_COPY.owners.creator)).toBeNull();
    expect(within(bob!).queryByText(SHARING_COPY.owners.you)).toBeNull();
    unmount();

    renderOwners([VINAY, BOB], AS_BOB);
    const [creatorAgain, you] = rows();
    expect(within(creatorAgain!).queryByText(SHARING_COPY.owners.you)).toBeNull();
    expect(within(you!).getByText('Bob')).toBeTruthy();
    expect(within(you!).getByText(SHARING_COPY.owners.you)).toBeTruthy();
  });

  it('fences a spoofed name, and an unknown one reads as Someone', () => {
    renderOwners([
      VINAY,
      { id: 'mallory', displayName: 'Bo' + RLO + 'b', creator: false },
      { id: 'ghost', displayName: null, creator: false },
    ]);
    const [, spoofed, unknown] = rows();
    expect(within(spoofed!).getByText('Bo b')).toBeTruthy();
    expect(spoofed!.textContent).not.toContain(RLO);
    expect(within(unknown!).getByText(SHARING_COPY.someone)).toBeTruthy();
  });
});

describe('AgentOwners — Add owner asks first', () => {
  it('Add owner asks first, says what owners can change including what routines do, and saves the creator, the current owners and the new one', async () => {
    renderOwners([VINAY, BOB]);
    const confirm = await confirmationFor('Ca', 'Carol');

    // The consequences are what the confirmation says, and what it announces.
    expect(within(confirm).getByText(SHARING_COPY.owners.consequences(FERN, { kind: 'you' }))).toBeTruthy();
    expect(
      screen.getByRole('dialog', { description: SHARING_COPY.owners.consequences(FERN, { kind: 'you' }) }),
    ).toBe(confirm);
    expect(setOwnersMock).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.owners.confirm }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setOwnersMock).toHaveBeenCalledTimes(1);
    expect(setOwnersMock).toHaveBeenCalledWith('agt_fern', ['vinay', 'bob', 'carol']);
    const after = rows();
    expect(after).toHaveLength(3);
    expect(within(after[2]!).getByText('Carol')).toBeTruthy();
  });

  it('cancelling the confirmation saves nothing', async () => {
    renderOwners([VINAY, BOB]);
    const confirm = await confirmationFor('Ca', 'Carol');
    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.owners.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setOwnersMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('Carol')).toBeNull();
  });

  it('a co-owner adding an owner is told the routines run as the creator', async () => {
    renderOwners([VINAY, BOB], AS_BOB);
    const confirm = await confirmationFor('Ca', 'Carol');

    expect(within(confirm).getByText(SHARING_COPY.owners.consequences(FERN, { kind: 'name', name: 'Vinay' }))).toBeTruthy();
    expect(within(confirm).queryByText(SHARING_COPY.owners.consequences(FERN, { kind: 'you' }))).toBeNull();

    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.owners.confirm }));
    await waitFor(() =>
      expect(setOwnersMock).toHaveBeenCalledWith('agt_fern', ['vinay', 'bob', 'carol']),
    );
  });

  it('a creator whose name is literally "you" is still named, not read as the viewer', async () => {
    const creatorYou: Owner = { id: 'vinay', displayName: 'you', creator: true };
    renderOwners([creatorYou, BOB], AS_BOB);
    const confirm = await confirmationFor('Ca', 'Carol');

    const named = SHARING_COPY.owners.consequences(FERN, { kind: 'name', name: 'you' });
    expect(within(confirm).getByText(named)).toBeTruthy();
    expect(confirm.textContent).not.toContain('your connections');
  });

  it('never offers someone who is already an owner', async () => {
    searchMock.mockResolvedValue([{ id: 'bob', displayName: 'Bob' }, CAROL]);
    renderOwners([VINAY, BOB]);
    search(await openAddOwner(), 'Bo');
    expect(await screen.findByRole('option', { name: 'Carol' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Bob' })).toBeNull();
  });

  it('Add owner is unavailable at ten owners', () => {
    const others: Owner[] = Array.from({ length: OWNERS_MAX - 1 }, (_, i) => ({
      id: `p${i}`,
      displayName: `Person ${i}`,
      creator: false,
    }));
    renderOwners([VINAY, ...others]);
    expect(rows()).toHaveLength(OWNERS_MAX);
    expect(screen.queryByRole('button', { name: SHARING_COPY.owners.add })).toBeNull();
    expect(screen.getByText(SHARING_COPY.owners.cap)).toBeTruthy();
  });

  it('a refused save shows the message and leaves the owners as they were', async () => {
    setOwnersMock.mockRejectedValue(
      new SharingRequestError('/admin/agents/agt_fern/owners', 400, 'unknown-person'),
    );
    renderOwners([VINAY, BOB]);
    const confirm = await confirmationFor('Ca', 'Carol');
    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.owners.confirm }));

    expect(await within(confirm).findByText(SHARING_COPY.errors.unknownPerson)).toBeTruthy();
    // It stays on the confirmation, so Add owner can be tried again.
    expect(
      screen.getByRole('dialog', { name: SHARING_COPY.owners.confirmTitle('Carol', FERN) }),
    ).toBe(confirm);

    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.owners.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setOwnersMock).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('Carol')).toBeNull();
  });
});

describe('AgentOwners — Remove', () => {
  it('Remove takes a co-owner off without asking, and neither the creator nor you have Remove', async () => {
    const { unmount } = renderOwners([VINAY, BOB]);
    expect(within(rows()[0]!).queryByRole('button')).toBeNull();

    fireEvent.click(removeButton('Bob'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(setOwnersMock).toHaveBeenCalledTimes(1);
    expect(setOwnersMock).toHaveBeenCalledWith('agt_fern', ['vinay']);
    unmount();

    // You are Bob: the creator isn't removable, and you can't remove yourself here.
    renderOwners([VINAY, BOB], AS_BOB);
    expect(within(ownersList()).queryAllByRole('button')).toHaveLength(0);
  });

  it('Remove sends everyone but that one person', async () => {
    renderOwners([VINAY, BOB, CAROL_OWNER], AS_BOB);
    expect(screen.queryByRole('button', { name: SHARING_COPY.owners.remove('Bob') })).toBeNull();
    expect(screen.queryByRole('button', { name: SHARING_COPY.owners.remove('Vinay') })).toBeNull();

    fireEvent.click(removeButton('Carol'));
    await waitFor(() => expect(setOwnersMock).toHaveBeenCalledWith('agt_fern', ['vinay', 'bob']));
    expect(setOwnersMock).toHaveBeenCalledTimes(1);
  });

  it('while a Remove saves, nothing else can change the owners, so the next write starts from what was saved', async () => {
    let answer!: (sharing: SharingView) => void;
    setOwnersMock.mockImplementationOnce(
      () =>
        new Promise<SharingView>((resolve) => {
          answer = resolve;
        }),
    );
    renderOwners([VINAY, BOB, CAROL_OWNER]);

    fireEvent.click(removeButton('Bob'));
    expect(removeButton('Carol')).toBeDisabled();
    expect(screen.getByRole('button', { name: SHARING_COPY.owners.add })).toBeDisabled();

    await act(async () => answer({ audience: { kind: 'just-me' }, owners: [VINAY, CAROL_OWNER] }));
    fireEvent.click(removeButton('Carol'));

    await waitFor(() => expect(setOwnersMock).toHaveBeenCalledTimes(2));
    expect(setOwnersMock).toHaveBeenNthCalledWith(1, 'agt_fern', ['vinay', 'carol']);
    expect(setOwnersMock).toHaveBeenNthCalledWith(2, 'agt_fern', ['vinay']);
  });

  it('a refused Remove says so and keeps the owner', async () => {
    setOwnersMock.mockRejectedValue(
      new SharingRequestError('/admin/agents/agt_fern/owners', 403, 'forbidden'),
    );
    renderOwners([VINAY, BOB]);
    fireEvent.click(removeButton('Bob'));

    expect(await screen.findByText(SHARING_COPY.errors.forbidden(FERN))).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(removeButton('Bob')).toBeEnabled();
  });

  it('without a signed-in person, nobody has Remove (it could be you)', () => {
    renderOwners([VINAY, BOB], null);
    expect(within(ownersList()).queryAllByRole('button')).toHaveLength(0);
  });
});
