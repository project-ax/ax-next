/**
 * TASK-341 / audit D1 — what an agent's card says under its name.
 *
 * It used to be `${a.visibility} · ${a.ownerId} · ${a.model}`: a lowercase
 * enum, a raw database id, and a provider model ref, on the card an admin
 * scans to find the agent they want. `usr_abc123` identifies the row to the
 * machine and to nobody else.
 */
import { describe, expect, it } from 'vitest';
import { agentCaption } from '../AgentForm';
import type { AgentModelOption } from '../../../lib/admin';
import type { Team } from '../../../../mock/admin/teams';

const models: AgentModelOption[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet', kind: 'either' },
];
const teams = [{ id: 'tm_9f2', name: 'Marketing' }] as unknown as Team[];

describe('agentCaption', () => {
  it('says who can see it and what it runs, in words', () => {
    expect(
      agentCaption(
        { visibility: 'personal', ownerId: 'usr_abc123', model: 'claude-sonnet-4-6' },
        teams,
        models,
      ),
    ).toBe('Personal · Claude Sonnet');
  });

  it('never leaks the owner id of a personal agent', () => {
    const caption = agentCaption(
      { visibility: 'personal', ownerId: 'usr_abc123', model: 'claude-sonnet-4-6' },
      teams,
      models,
    );
    expect(caption).not.toContain('usr_abc123');
  });

  it('names the team rather than its id, because that one IS meaningful', () => {
    expect(
      agentCaption(
        { visibility: 'team', ownerId: 'tm_9f2', model: 'claude-sonnet-4-6' },
        teams,
        models,
      ),
    ).toBe('Team · Marketing · Claude Sonnet');
  });

  it('omits a team it cannot name rather than printing the id', () => {
    expect(
      agentCaption(
        { visibility: 'team', ownerId: 'tm_unknown', model: 'claude-sonnet-4-6' },
        teams,
        models,
      ),
    ).toBe('Team · Claude Sonnet');
  });

  it('says nothing about the model while the list is still loading', () => {
    // Deliberate: a caption is a summary and the edit form carries the exact
    // value, so falling back to the raw `anthropic/claude-sonnet-4-6` here
    // would reintroduce the exact thing this finding is about.
    expect(
      agentCaption(
        { visibility: 'personal', ownerId: 'usr_abc123', model: 'claude-sonnet-4-6' },
        teams,
        null,
      ),
    ).toBe('Personal');
  });

  it('omits a model ref no configured provider offers', () => {
    expect(
      agentCaption(
        { visibility: 'personal', ownerId: 'usr_abc123', model: 'some/retired-model' },
        teams,
        models,
      ),
    ).toBe('Personal');
  });
});
