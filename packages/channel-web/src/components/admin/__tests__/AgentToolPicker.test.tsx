import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AgentToolPicker } from '../AgentToolPicker';
import type { ToolCatalogState } from '@/lib/agent-tool-areas';
import { PROD_TOOL_CATALOG } from '@/lib/__tests__/agent-tool-catalog.fixture';

const OK: ToolCatalogState = { status: 'ok', ...PROD_TOOL_CATALOG };
const ROUTINES = [
  'routine_list',
  'routine_get',
  'routine_create',
  'routine_update',
  'routine_delete',
  'routine_fire_now',
];

function setup(
  props: Partial<{
    catalog: ToolCatalogState;
    selected: string[];
    unrestricted: boolean;
  }> = {},
) {
  const onChange = vi.fn();
  render(
    <AgentToolPicker
      catalog={props.catalog ?? OK}
      selected={props.selected ?? []}
      onChange={onChange}
      unrestricted={props.unrestricted ?? false}
    />,
  );
  return onChange;
}

describe('AgentToolPicker', () => {
  it('is a labelled group with a one-line prompt', () => {
    setup();
    expect(screen.getByRole('group', { name: 'Allowed tools' })).toBeTruthy();
    expect(screen.getByText('Pick what this agent can use.')).toBeTruthy();
  });

  it('ticking Routines picks its six tools', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Routines' }));
    expect(onChange).toHaveBeenCalledWith(ROUTINES);
  });

  it('unticking a full area removes only that area’s tools', () => {
    const onChange = setup({ selected: [...ROUTINES, 'Bash', 'routines'] });
    const box = screen.getByRole('checkbox', { name: 'Routines' });
    expect(box.getAttribute('data-state')).toBe('checked');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(['Bash', 'routines']);
  });

  it('a partly picked area shows how many, and its box is unchecked', () => {
    setup({ selected: ROUTINES.slice(0, 5) });
    expect(screen.getByText('5 of 6 picked')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Routines' }).getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  it('a tool box toggles one name', () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'routine_get' }));
    expect(onChange).toHaveBeenCalledWith(['routine_get']);
  });

  it('offers no box for a tool AX adds itself, nor for an unknown name', () => {
    setup({ selected: ['routines'] });
    for (const name of ['search_catalog', 'routine_report', 'routines']) {
      expect(screen.queryByRole('checkbox', { name })).toBeNull();
    }
  });

  it('says which saved names are not available here, without promising to remove them', () => {
    setup({ selected: ['Bash', 'routines'] });
    expect(screen.getByRole('status').textContent).toContain(
      '“routines” isn’t available here, so listing it does nothing right now. It may be a tool this deployment doesn’t run, or one this list doesn’t control.',
    );
  });

  it('lists several unknown names together', () => {
    setup({ selected: ['a', 'b'] });
    expect(screen.getByRole('status').textContent).toContain(
      'These aren’t available here, so listing them does nothing right now: “a”, “b”. They may be tools this deployment doesn’t run, or ones this list doesn’t control.',
    );
  });

  // A successful read only proves a name is missing from THIS boot (web tools
  // load only with a key, for one), so nothing removes it unless asked.
  it('nothing is removed until the owner clicks Remove it', () => {
    const onChange = setup({ selected: ['Bash', 'routines', 'routine_get'] });
    expect(onChange).not.toHaveBeenCalled();
    const remove = within(screen.getByRole('status')).getByRole('button', { name: 'Remove it' });
    // Inside the agent form: it must not submit it.
    expect(remove.getAttribute('type')).toBe('button');
    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith(['Bash', 'routine_get']);
  });

  it('with several unknown names the button says Remove them and removes them all', () => {
    const onChange = setup({ selected: ['a', 'Bash', 'b'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
    expect(onChange).toHaveBeenCalledWith(['Bash']);
  });

  it('a failed read shows the current list and offers nothing to pick', () => {
    setup({ catalog: { status: 'failed' }, selected: ['Bash', 'routines'] });
    expect(screen.getByText(/this agent keeps the ones it has: Bash, routines/)).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // A failed read is a danger Notice (alert); the note about unknown saved names is info (status).
    expect(screen.getByRole('alert')).toHaveTextContent(/this agent keeps the ones it has/);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a failed read leaves out the tools AX adds itself when listing what the agent keeps', () => {
    setup({ catalog: { status: 'failed' }, selected: ['Bash', 'search_catalog', 'routine_report', 'routines'] });
    expect(screen.getByText(/this agent keeps the ones it has: Bash, routines\./)).toBeTruthy();
    expect(screen.queryByText(/search_catalog|routine_report/)).toBeNull();
  });

  it('a failed read with only tools AX adds itself saved shows no empty list', () => {
    setup({ catalog: { status: 'failed' }, selected: ['search_catalog'] });
    expect(
      screen.getByText(
        'We couldn’t load the list of tools.',
      ),
    ).toBeTruthy();
  });

  it('a failed read with nothing saved says so plainly', () => {
    setup({ catalog: { status: 'failed' } });
    expect(
      screen.getByText(
        'We couldn’t load the list of tools.',
      ),
    ).toBeTruthy();
  });

  it('while loading, says so and offers nothing', () => {
    setup({ catalog: { status: 'loading' } });
    expect(screen.getByText('Loading the list of tools…')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('an unrestricted agent is told it can use every tool', () => {
    const line =
      'Right now this agent can use every tool, because none are picked. Picking any limits it to just those.';
    const { unmount } = render(
      <AgentToolPicker catalog={OK} selected={[]} onChange={vi.fn()} unrestricted />,
    );
    expect(screen.getByText(line)).toBeTruthy();
    unmount();
    setup({ unrestricted: false });
    expect(screen.queryByText(line)).toBeNull();
  });
});
