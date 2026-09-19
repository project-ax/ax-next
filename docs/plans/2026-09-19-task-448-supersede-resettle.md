# TASK-448 — `memory:facts:supersede` leaves a stale closure it never repairs

**Card:** `[TASK-448]` · **Found by:** TASK-422's round-2 `ax-code-reviewer` pass (PR #607)
**Design:** `docs/plans/2026-09-18-dem-first-memory-design.md` §3.4
**Pre-existing since:** TASK-421 (PR #603) — `supersedeIds` has never re-settled.

---

## 1. The bug

`supersedeIds` is a single-row `UPDATE`. It ends the named rows and stops. Closures
the retracted row had itself **authored** — neighbours carrying `closed_by = <this
id>` — keep their `valid_end`/`closed_by` on the authority of a row that now asserts
nothing.

```
A = lives_in Boston  (JAN)
B = lives_in Seattle (JUN)   -> rule 1 closes A: until=JUN, closedBy=B
supersede([B])               -> B retracted (closed_by NULL, finite valid_end)
```

`recall` now returns **neither**: A is closed, B is retracted. The user's side of
this: *"I deleted the new fact and my old one disappeared too."* An empty answer
where `A` is the correct one.

TASK-422 built the repair (`resettleSlotGroups` re-derives a group without its
retracted rows, so A comes back active) but only `memory:facts:reindex` calls it,
and only for groups a newly-resolved **pending** row joined. A group with no pending
row is never revisited, so the stale closure is permanent.

## 2. Why this is `supersede`'s job, not `reindex`'s

The re-settle is caused by the retraction and should be atomic with it. Leaving it
to a later `reindex` means the store is *observably wrong* in between, and the
window has no bound — nothing schedules a reindex, and a deployment with no pending
rows never runs one at all.

**What must NOT change:** excluding retracted rows from the peer set is correct and
stays. TASK-421 pins it (`a superseded row (closedBy null) does not bound a
later-inserted earlier statement, unlike a rule-closed one`). That case exercises
the `record` path, which this card does not touch — verify it still passes rather
than adjusting it.

## 3. The change

**`supersedeIds` (`closure.ts`)** — inside the existing transaction, after closing:
1. Collect the `(about, slot)` of every row it **actually** closed, where `slot` is a
   real slot — `NULL` and `PENDING_SLOT` rows have no chain and are skipped.
2. De-duplicate (several retracted rows may share a group).
3. `resettleSlotGroups(driver, agentKey, groups)` → the changed ids.
4. Return `{ closed, resettled }`.

Idempotent by construction: a second `supersede` of the same ids closes nothing, so
it collects no groups and re-settles nothing.

**`SupersedeOutput` (contract)** gains `resettled: string[]` — same meaning and same
doc-comment caveats as `ReindexOutput.resettled`, *including* that it names rows that
were **re-opened**. Factor the shared prose rather than writing it twice.

**Retire the stale lines this card was filed off** (contract rule 5 — the card's own
evidence is a doc block written during TASK-422):
- `supersedeIds`' "## Known gap: closures this row AUTHORED elsewhere are not
  repaired" block — delete it; describe what it now does.
- `resettleSlotGroups`' docstring: *"Plain `supersede` does not do this … `reindex`
  is the operation that does."* — now false.
- `ReindexOutput.resettled`'s softened "nothing schedules one" caveat.
- `docs/plans/2026-09-19-task-422-degraded-pending-plan.md` §3 out-of-scope bullet.
- `docs/plans/2026-09-19-dem-first-handoff.md` §3.1's re-open note.
- Grep the **prose** spellings too (`never re-settles`, `Known gap`, `single-row`),
  not just the symbol.

## 4. Boundary review — `memory:facts:supersede` (CHANGED service-hook signature)

- **Alternate impl:** `@ax/memory-facts-postgres` (TASK-423), same re-settle over a
  postgres store; plus an in-memory backend for product-layer tests.
- **Payload field names that might leak:** none. `resettled: string[]` is a list of
  statement ids — the same domain vocabulary `ReindexOutput.resettled` and
  `RecordedStatement.closes` already use. No `rowid`, `valid_end`, `agent_key`,
  `batch_seq`, `table`.
- **Subscriber risk:** none — service hook, no subscribers. **No consumer exists at
  all** (`@ax/memory` is unbuilt), which is exactly why the shape changes now: it is
  free today and expensive the day after the product layer ships.
- **Back-compat:** additive. An existing caller reading only `closed` is unaffected.
- **Wire surface:** not an IPC action.

## 5. Tests

Contract cases in `@ax/memory-facts-contract`'s `runFactsContract`, beside the
existing `memory:facts:supersede` block. Each negative assertion pairs with a
positive one so a `supersede` that no-ops cannot pass.

- **The headline:** A closed by B; `supersede([B])` → A is **active again**
  (`until`/`closedBy` both cleared), named in `resettled`, and `recall` returns A.
- Retracting a row that closed **nothing** → `closed: [id]`, `resettled: []`.
- Retracting a row with **no slot** → nothing re-settled (no chain exists).
- Retracting a **pending-slot** row → nothing re-settled (pending rows are inert).
- **Chain of three:** A←B←C; `supersede([C])` re-opens B and leaves A closed by B.
- **Two rows of the same group in one call** → the group is re-settled once and the
  result is correct (not applied twice).
- **Provenance immunity survives**: retracting an `agent` row in a slot also holding
  a `human` row re-derives without re-closing across the rank boundary.
- **Tenancy:** agent A's `supersede` never re-settles agent B's chain.
- Idempotent: a second identical `supersede` → `closed: []`, `resettled: []`.
- Existing TASK-421 case still passes **unmodified**.

## 6. YAGNI

| Item | Load-bearing? |
|---|---|
| Re-settle on supersede | Yes — the defect. |
| `SupersedeOutput.resettled` | Yes — a caller cannot otherwise learn which rows changed; free to add now, expensive later. |
| Retiring the stale doc block | Yes — contract rule 5; it is this card's own evidence. |
| Re-settling groups of rows that were NOT closed (already-retracted ids) | **No — cut.** Nothing changed, so nothing to re-derive. |

## 7. Security

No sandbox, IPC, plugin-loading, untrusted-content or dependency change. SQL stays
parameterized; the re-settle reuses TASK-422's already-reviewed code path. Tenancy is
unchanged — `agentScopeKey(ctx)` scopes both the close and the re-settle.
`security-checklist` not triggered.
