# TASK-251 — `routines:recent-fires-for-agent` stops carrying `FireRow.id`

## Problem

`routines:recent-fires-for-agent` declares its output as `{ fires: FireRow[] }`, and
`FireRow` carries `id: number` — the postgres `BIGSERIAL` primary key
(`packages/routines/src/migrations.ts:130`). That is storage vocabulary on a hook
payload, which invariant 1 forbids. No runtime bug: the only bus consumer
(`packages/channel-web/src/server/routes-workspace.ts:1711`) already declares a local
`FireRow` without `id` and firewalls it at the HTTP boundary. This is hygiene — stop
declaring what we must not deliver.

## The trap (why the obvious fix is wrong)

`FireRowSchema` is **shared**: `RecentFiresOutputSchema` (`routines:recent-fires`) uses
the same object. `packages/core/src/hook-bus.ts:131-146` returns
`returns.safeParse(...).data`, and a zod object **strips undeclared keys**. So deleting
`id` from `FireRowSchema` would silently delete it from `routines:recent-fires` too,
breaking `FireRowsTable.tsx:53`'s `key={f.id}` — and the HTTP hop is an untyped
`get<T>`, so **tsc would not complain**.

## Tasks

1. **Narrow the for-agent hook only** (`packages/routines/src/types.ts`)
   - `export type AgentFireRow = Omit<FireRow, 'id'>` with a doc comment naming the
     invariant and the reason the shared row keeps `id`.
   - `RecentFiresForAgentOutput.fires: AgentFireRow[]`.
   - `const AgentFireRowSchema = FireRowSchema.omit({ id: true })`, used by
     `RecentFiresForAgentOutputSchema`.
   - `FireRowSchema` / `RecentFiresOutputSchema` / the domain `FireRow` are UNTOUCHED.
   - The store still returns the wider row; the `returns` schema strips `id` at the bus
     boundary (the documented, authoritative mechanism). `store.ts` and
     `store.test.ts`'s `f.id` pagination assertions keep working.
   - Load-bearing: yes — this is the fix.

2. **Test pair** (`packages/routines/src/__tests__/return-schemas.test.ts`)
   - for-agent: `expect('id' in out.fires[0]).toBe(false)`.
   - recent-fires: assert `id` IS still `42` — this is what catches the collateral strip.
   - Load-bearing: yes (Bug Fix Policy; the second assertion is the regression guard).

3. **Truthful comment** (`packages/channel-web/src/server/routes-workspace.ts:372-374`)
   - Its comment says `id` "is present in the payload and is DELIBERATELY not read".
     After task 1 it is no longer present. Update it so the codebase does not carry a
     false comment.
   - Load-bearing: yes (comment accuracy; the epic already burned a card on false
     comments).

## Out of scope (follow-ups)

- `FireNowOutput.fireId: number` (`types.ts:49`, `:260`) — the same BIGSERIAL, and
  `FireNowControl.tsx:39` actually RENDERS it (`Fired (#${out.fireId})`). Fixing it
  needs a UI decision, so it is a separate card.
- The domain `FireRow.id` and `routines:recent-fires` — deliberately left alone.

## Gate

`pnpm build` (tsc — does not cover `__tests__`, so type-check the test deliberately) +
`pnpm --filter @ax/routines test` + `pnpm --filter @ax/channel-web test` + `pnpm lint`,
then the full `pnpm test`.
