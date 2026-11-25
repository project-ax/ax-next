/**
 * PeoplePicker: find a person by name. Debounced, abortable, newest answer
 * only; the state lines and fixed options come from SHARING_COPY.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import { searchPeople, SharingRequestError, type PersonMatch } from '@/lib/agent-sharing-api';
import { PEOPLE_SEARCH_DEBOUNCE_MS, PeoplePicker, type PeoplePickerProps } from '../PeoplePicker';

vi.mock('@/lib/agent-sharing-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-sharing-api')>()),
  searchPeople: vi.fn(),
}));
const searchMock = vi.mocked(searchPeople);

const ALICE: PersonMatch = { id: 'u-alice', displayName: 'Alice Archer' };
const ALICIA: PersonMatch = { id: 'u-alicia', displayName: 'Alicia Bell' };
const LABEL = 'Who can use it';

function renderPicker(over: Partial<PeoplePickerProps> = {}) {
  const props: PeoplePickerProps = {
    label: LABEL,
    placeholder: SHARING_COPY.picker.placeholder,
    excludeIds: new Set<string>(),
    onPickPerson: vi.fn(),
    ...over,
  };
  return { ...render(<PeoplePicker {...props} />), props };
}

const trigger = () => screen.getByRole('combobox', { name: LABEL });
const searchBox = () => screen.getByPlaceholderText(SHARING_COPY.picker.placeholder);

function openPicker() {
  fireEvent.click(trigger());
}

function type(text: string) {
  fireEvent.change(searchBox(), { target: { value: text } });
}

async function pause(ms = PEOPLE_SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PeoplePicker', () => {
  it('no search for one character, and it says to keep typing', async () => {
    renderPicker();
    openPicker();
    type('a');
    await pause();
    expect(searchMock).not.toHaveBeenCalled();
    expect(screen.getByText(SHARING_COPY.picker.keepTyping)).toBeTruthy();
  });

  it('typing quickly makes one search, after the pause, with the trimmed text', async () => {
    searchMock.mockResolvedValue([]);
    renderPicker();
    openPicker();
    type(' ');
    type(' a');
    type('  al');
    type('  ali');
    await pause(PEOPLE_SEARCH_DEBOUNCE_MS - 1);
    expect(searchMock).not.toHaveBeenCalled();
    expect(screen.getByText(SHARING_COPY.picker.searching)).toBeTruthy();
    await pause(1);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]?.[0]).toBe('ali');
  });

  it('offers matches except the excluded ones, and picking one reports it and clears the field', async () => {
    searchMock.mockResolvedValue([ALICE, ALICIA]);
    const { props } = renderPicker({ excludeIds: new Set([ALICIA.id]) });
    openPicker();
    type('ali');
    await pause();
    expect(screen.queryByText(personLabel(ALICIA.displayName))).toBeNull();
    fireEvent.click(screen.getByText(personLabel(ALICE.displayName)));
    expect(props.onPickPerson).toHaveBeenCalledWith(ALICE);
    openPicker();
    expect((searchBox() as HTMLInputElement).value).toBe('');
  });

  it('says there are no matches when everyone found is excluded', async () => {
    searchMock.mockResolvedValue([ALICE]);
    renderPicker({ excludeIds: new Set([ALICE.id]) });
    openPicker();
    type('ali');
    await pause();
    expect(screen.getByText(SHARING_COPY.picker.noMatches)).toBeTruthy();
  });

  it('fences a name before showing it', async () => {
    const spoof = `Eve${String.fromCharCode(0x202e)}live`;
    searchMock.mockResolvedValue([{ id: 'u-eve', displayName: spoof }]);
    renderPicker();
    openPicker();
    type('eve');
    await pause();
    expect(screen.getByText(personLabel(spoof))).toBeTruthy();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x202e));
  });

  it('only the latest search is shown', async () => {
    let resolveFirst: (v: PersonMatch[]) => void = () => {};
    let resolveSecond: (v: PersonMatch[]) => void = () => {};
    searchMock
      .mockImplementationOnce(() => new Promise<PersonMatch[]>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => new Promise<PersonMatch[]>((r) => (resolveSecond = r)));
    renderPicker();
    openPicker();
    type('ali');
    await pause();
    type('alic');
    await pause();
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => resolveSecond([ALICIA]));
    await act(async () => resolveFirst([ALICE]));
    expect(screen.getByText(personLabel(ALICIA.displayName))).toBeTruthy();
    expect(screen.queryByText(personLabel(ALICE.displayName))).toBeNull();
  });

  it('a rate-limited search says so', async () => {
    searchMock.mockRejectedValue(new SharingRequestError('/admin/people', 429, 'rate-limited'));
    renderPicker();
    openPicker();
    type('ali');
    await pause();
    expect(screen.getByText(SHARING_COPY.picker.searchRateLimited)).toBeTruthy();
  });

  it("any other failure says search isn't working", async () => {
    searchMock.mockRejectedValue(new Error('boom'));
    renderPicker();
    openPicker();
    type('ali');
    await pause();
    expect(screen.getByText(SHARING_COPY.picker.searchFailed)).toBeTruthy();
    expect(screen.queryByText(SHARING_COPY.picker.searchRateLimited)).toBeNull();
  });

  it('a fixed option is listed first and reports its id', async () => {
    searchMock.mockResolvedValue([ALICE]);
    const onPickFixed = vi.fn();
    renderPicker({
      fixedOptions: [
        { id: 'just-me', label: SHARING_COPY.picker.justMeOption },
        { id: 'everyone', label: SHARING_COPY.picker.everyoneOption, hint: SHARING_COPY.picker.everyoneHint },
      ],
      onPickFixed,
    });
    openPicker();
    type('ali');
    await pause();
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toContain(SHARING_COPY.picker.justMeOption);
    expect(options[1]).toContain(SHARING_COPY.picker.everyoneOption);
    expect(options[1]).toContain(SHARING_COPY.picker.everyoneHint);
    expect(options[2]).toContain(personLabel(ALICE.displayName));
    fireEvent.click(screen.getByText(SHARING_COPY.picker.everyoneOption));
    expect(onPickFixed).toHaveBeenCalledWith('everyone');
  });

  it('a search aborted by newer typing never shows a failure', async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    searchMock.mockImplementationOnce(
      () =>
        new Promise<PersonMatch[]>((_r, rej) => {
          rejectFirst = rej;
        }),
    );
    renderPicker();
    openPicker();
    type('ali');
    await pause();
    expect(searchMock).toHaveBeenCalledTimes(1);
    // Typing again aborts the first request; it rejects before the debounce fires.
    type('alic');
    await act(async () => {
      rejectFirst(new DOMException('aborted', 'AbortError'));
    });
    expect(screen.queryByText(SHARING_COPY.picker.searchFailed)).toBeNull();
    expect(screen.getByText(SHARING_COPY.picker.searching)).toBeTruthy();
  });

  it('with people disabled, the fixed options still work and nobody is searched for', async () => {
    searchMock.mockResolvedValue([ALICE]);
    const onPickFixed = vi.fn();
    renderPicker({
      peopleDisabled: true,
      fixedOptions: [{ id: 'everyone', label: SHARING_COPY.picker.everyoneOption }],
      onPickFixed,
    });
    expect((trigger() as HTMLButtonElement).disabled).toBe(false);
    openPicker();
    expect((searchBox() as HTMLInputElement).disabled).toBe(true);
    type('ali');
    await pause();
    expect(searchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(personLabel(ALICE.displayName))).toBeNull();
    fireEvent.click(screen.getByText(SHARING_COPY.picker.everyoneOption));
    expect(onPickFixed).toHaveBeenCalledWith('everyone');
  });

  it('cannot be opened when disabled', () => {
    renderPicker({ disabled: true });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });
});
