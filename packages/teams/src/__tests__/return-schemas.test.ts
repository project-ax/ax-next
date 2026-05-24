import { describe, it, expect } from 'vitest';
import {
  AddMemberOutputSchema,
  CreateTeamOutputSchema,
  IsMemberOutputSchema,
  ListForUserOutputSchema,
  ListMembersOutputSchema,
  type AddMemberOutput,
  type CreateTeamOutput,
  type IsMemberOutput,
  type ListForUserOutput,
  type ListMembersOutput,
  type Membership,
  type Team,
} from '../types.js';

// ARCH-13 drift guard for the `teams:*` returns schemas. Team/Membership carry
// real Date instances (createdAt/joinedAt -> z.date()).

const team: Team = {
  id: 't1',
  displayName: 'Platform',
  createdBy: 'u1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const membership: Membership = {
  teamId: 't1',
  userId: 'u2',
  role: 'member',
  joinedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('teams return schemas', () => {
  it('teams:create round-trips a fully-populated Team', () => {
    const full: CreateTeamOutput = { team };
    expect(CreateTeamOutputSchema.parse(full)).toEqual(full);
  });

  it('teams:list-for-user round-trips', () => {
    const full: ListForUserOutput = { teams: [team] };
    expect(ListForUserOutputSchema.parse(full)).toEqual(full);
  });

  it('teams:is-member round-trips with role present', () => {
    const full: IsMemberOutput = { member: true, role: 'admin' };
    expect(IsMemberOutputSchema.parse(full)).toEqual(full);
  });

  it('teams:is-member round-trips with role omitted', () => {
    const full: IsMemberOutput = { member: false };
    expect(IsMemberOutputSchema.parse(full)).toEqual(full);
  });

  it('teams:add-member round-trips a fully-populated Membership', () => {
    const full: AddMemberOutput = { membership };
    expect(AddMemberOutputSchema.parse(full)).toEqual(full);
  });

  it('teams:list-members round-trips', () => {
    const full: ListMembersOutput = { members: [membership] };
    expect(ListMembersOutputSchema.parse(full)).toEqual(full);
  });

  it('rejects a string createdAt (handler returns a Date)', () => {
    expect(
      CreateTeamOutputSchema.safeParse({ team: { ...team, createdAt: '2026-01-01' } }).success,
    ).toBe(false);
  });

  it('rejects an invalid role', () => {
    expect(
      AddMemberOutputSchema.safeParse({ membership: { ...membership, role: 'owner' } }).success,
    ).toBe(false);
  });
});
