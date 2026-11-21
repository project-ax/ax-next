# TASK-1182: a memory switch flip and a bot's first bind take turns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team member flips a channel's memory switch while the agent's own Slack bot is binding that channel at its first mention. Whichever of the two runs second sees what the other wrote, so the bot's binding ends with the switch's last value.

**Architecture:** There are two writers of a binding's `remember`: `setRemember` (a flip) and the bot's first bind. Both open a transaction whose FIRST statement is `pg_advisory_xact_lock` on (agent, channel). Their reads and writes follow in later statements, so each one's snapshot is taken after the other has committed. `setRemember` keeps its one-statement CTE unchanged. The bot's first bind moves out of `router.ts` into a new store method, `ChannelStore.bindBot`. It reads the starting switch (the agent's shared binding, else the kept switch, else on) and inserts the binding, all under the lock. The router reads the shared install before calling it, outside the transaction.

**Tech Stack:** TypeScript, Kysely `sql` on Postgres (testcontainers), vitest. No migration, hook, IPC action, route, UI or dependency change.

**Spec:** card TASK-1182 (follow-up of TASK-1180, PR #1215); `docs/plans/2026-11-09-channel-slack-design.md` §4 (the TASK-1167 As built bullets, `:541-569`); `.claude/memory/decisions/2026-11-20-TASK-1180.md` (residual 1 and the YAGNI-cuts row, which this card reverses). Decisions for this plan: `.claude/memory/decisions/2026-11-20-TASK-1182.md`.

## Global Constraints

- Every writer of a binding's `remember` takes the switch lock as the **first statement of its transaction**. Nothing it decides with is read before the lock is held. A lock taken inside the working statement doesn't count: that statement's snapshot predates the wait.
- Lock: `SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([agentId, channelId])}, 18427161))`. It is transaction-scoped, never session-scoped. Keep the seed as a literal in the SQL text, as `packages/tool-policy/src/routine-consent.ts` does.
- `setRemember` keeps TASK-1180's rule: ONE statement writes every binding of that agent in that channel, plus the kept switch. The CTE text is unchanged.
- The bot's first bind writes no kept switch. Its starting switch is not a flip (TASK-1180).
- The starting-switch order is unchanged (TASK-1179/1180): the agent's own binding on the shared app's install, else the kept switch, else on. Another agent's binding there is never read.
- A lock-holding transaction makes no network call and touches no other store, so it never needs a second pool connection. The shared install is read before `bindBot` (pool max 10, `database-postgres`).
- Tests never sleep. A test session holds a row to stop one side partway, and `pg_blocking_pids` tells the test when the other side is waiting.
- Sibling hot spots (TASK-1170 and TASK-1173 are editing `packages/channel-slack` in parallel):
  - `plugin.test.ts`: append only, at the end of the file.
  - The design doc: edit `:563-569` only.
  - `router.test.ts`: edit only the lines named below.
- Prose in code comments and docs follows each file's existing plain style. The changeset uses the CLAUDE.md voice, with no jokes because this is a privacy fix.

## Review Focus

1. **A lock wait longer than `statement_timeout`** (30 s by default in `database-postgres`). The waiting transaction rolls back. A bind writes no binding, and the sender hears `COPY.turnFailed`. A flip answers 500 and writes nothing. *Check by reading:* every write sits after the lock, inside one `db.transaction()`. No test: it would need a 30 s hold.
2. **Pool safety.** No second connection is taken inside `bindBot`'s or `setRemember`'s transaction. `d.installs.current()` runs before `bindBot`, and `bindBot` reads only through its transaction. *Check by reading* `router.ts` `bindBotChannel` and `channel-store.ts` `bindBot`.
3. **Deadlock-freedom.** Both lock-takers take the advisory lock before touching any row. The other writers of these rows take no advisory lock: `remove`, `installs.remove`, `removeForAgent`, `recordThread` and the boot fill. So no cycle can form. A side effect: two flips of one agent's channel now queue instead of possibly deadlocking (TASK-1180 residual 4). *Check by reading.*
4. **A bind whose switch can't be read binds nothing and runs nothing.** Pinned by Task 3's `bindFails` row, plus the transaction itself.
5. **The moved starting-switch rule against real Postgres.** Three cases: another agent's binding, a live shared ON beside an older kept OFF, and no shared app. Pinned by Task 2's table test.

---

## What the code says (the card's claims, checked at `d16bea681`)

1. **CONFIRMED: the race is real, in both orders.**
   - `bindBotChannel` reads the switch in separate autocommit statements: `startingRemember` → `sharedRemember` → `keptRemember` (`router.ts:892`, `:922-939`). It then inserts in another statement, `upsert` (`:904`).
   - `setRemember` is one autocommit CTE (`channel-store.ts:299-317`).
   - **Order (b):** the bind reads ON, the flip commits OFF, then the bind inserts ON.
   - **Order (a):** the flip's UPDATE takes its snapshot and waits on the shared binding's row. Meanwhile the bind reads ON and commits a new bot binding ON. Under READ COMMITTED the UPDATE re-checks only rows it already found, so it never flips the new one.
2. **The card's literal mechanism, a row lock in `channel_slack_v1_memory_switches`, can't work alone.**
   - The kept row is missing for a channel connected since the last boot and never flipped. (Every boot backfills one for each bound pair, `migrations.ts:432-456`.) `FOR UPDATE` on a missing row locks nothing.
   - Materializing the row at bind time would write a kept switch for a non-flip, which changes TASK-1180's semantics.
   - The card allows "an equivalent". The equivalent is an advisory lock on the same key. `packages/tool-policy/src/routine-consent.ts:55-56` states this exact rule: "Advisory locks also serialize absent rows".
3. **The writers of `remember`** (grep `remember` in `packages/channel-slack/src`):
   - `upsert`'s insert, used by the shared connect (`channels.ts`, always on) and the bot's first bind;
   - `setRemember`, reached from both `agent-routes.ts:569` and `:590`;
   - the boot fill, which writes the kept switch only.

   Only the flip and the bot's first bind can disagree about one channel. TASK-1168 refuses a shared connect once the agent's bot is live.
4. **Advisory-lock conventions:** the one-bigint form `hashtextextended(key, seed)`, with one seed family per package:
   - routines: `1842713x`;
   - tool-policy: `1842714x`;
   - decisions: `1842715x`.

   `18427161` is unused (grep), so channel-slack takes it. tool-policy's `scopeLock` keys on `JSON.stringify([a, b])`, which is unambiguous whatever the ids contain.
5. **Test seams:**
   - `router.test.ts` runs on the in-memory `memoryChannelStore`, wrapped in a `bindings` object with failure injection (`:576-609`).
   - `channel-store.test.ts` and `plugin.test.ts` run on real Postgres.
   - `plugin.test.ts` already drives a bot's first mention and the shared switch route through the wiring (the TASK-1180 tests at `:2885-2981`). The events route acks and dispatches without waiting (`events.ts:290-298`), so a test can start a mention and keep going.
   - The probe pool there has `max: 2`: one connection for a holder session and one for probes.
6. **The memory canary** (`presets/memory/src/__tests__/canary.test.ts`) pins only channel-slack's mounted routes. No route changes, so it is untouched.
7. **No `.claude/memory` row pins a touched file by blob sha.**

**What made the card look true (rule 5).** TASK-1180 shipped the race as an accepted residual. Its living record is the design doc's "A flip racing the bot's first answer in that channel can leave the bot on the value from just before the flip" (`docs/plans/2026-11-09-channel-slack-design.md:566-567`). Task 4 rewrites it. Code prose that moves with the change is fixed in the task that edits its file:

- the `channel-store.ts` header (`:30-46`);
- `migrations.ts:101-103`, which names "router.ts" as the kept switch's reader;
- the `channel-store.test.ts` TASK-1180 header (`:452`, "router.ts reads it");
- `router.ts`'s RouterDeps doc (`:144-152`) and the `bindBotChannel` doc (`:854-872`).

The SPA's re-read comment (`AgentSlack.tsx:272-274`) and its test stay true. The row moves to the bot's list, and the switch value it shows is now the last one written.

## Approaches

- **A. Advisory lock + a `bindBot` store method (chosen).**
  - Both lock-takers live in `channel-store.ts`, so "every writer of `remember` takes the lock" can be checked in one file, beside TASK-1180's one-statement rule.
  - The router keeps the Slack-facing checks and passes data in.
  - Cost: the starting-switch rule moves into the store. The router's TASK-1179/1180 tests then exercise the fake's copy of it, so Task 2 adds a real-Postgres table test of the rule.
- **B. Advisory lock + `withSwitchLock(agentId, channelId, fn)`, which hands the router a transaction-bound store.** Smaller diff, and the router tests stay as they are. Rejected:
  - it splits the lock's correctness across two files;
  - every future caller has to know not to make network calls or touch another store inside the callback.
- **C. A row lock on a materialized kept-switch row.** Rejected: it writes a kept switch on a non-flip (finding 2).
- **D. SERIALIZABLE plus a retry loop.** Rejected: a retry budget is a correctness cliff (`decisions.md`, TASK-220).
- **E. An in-process mutex.** Rejected: it relies on the chart's one-replica pin rather than code, and the card asks for a database lock.

---

### Task 1: Two acceptance tests, one per order, red on main `[tier: sensitive]`, **security-checklist required** (the evidence for the privacy note)

**Files:**
- Modify: `packages/channel-slack/src/__tests__/plugin.test.ts`. Append after the last line (`:3129`, the outer `describe`'s `});`). Touch nothing above it.

**Interfaces:**
- Consumes these existing module-level helpers: `boot`, `seedSupportBot`, `botChannelSlackFetch`, `botMentionBody`, `request`, `signed`, `askMemory`, `NOT_REMEMBERED`, `createChannelStore`, `probe`, `probePool`, `Answer`, and the constants `INSTALL_ID`, `BOT_INSTALL_ID`, `BOT_SIGNING_SECRET`, `NOW_MS`, `SUPPORT_CH`, `TEAM_AGENT`, `ADMIN`, `GRACE`.
- Produces nothing other tasks use.

- [ ] **Step 1: Write the tests.** The barrier choreography is the algorithm here, so it is given in full. Keep the names, values and assertions.

```ts
// ── TASK-1182 ───────────────────────────────────────────────────────────────

/** The sessions waiting on a lock `pid` holds: Postgres's own word that one side is blocked, never a sleep. */
async function waitingOn(pid: number): Promise<number[]> {
  const r = await sql<{ pid: number }>`
    SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
  `.execute(probe);
  return r.rows.map((row) => row.pid);
}

/*
  TASK-1182: a memory switch flip and the agent's own bot's first bind in a
  channel take one lock on the agent and channel, so whichever comes second
  sees what the other wrote. Before the fix they could interleave, and the
  bot's binding kept the switch from before the flip: the channel was
  remembered although the team's last choice was off. Each test stops one
  side partway with a session of its own, and moves on only when Postgres
  says the other side is waiting, never after a sleep.
*/
describe("a memory switch flip and the agent's own bot's first bind take turns (TASK-1182)", () => {
  /** TASK-1180's world with the bot not yet answered in #support; its mention, and the shared switch turned off, through the wiring. */
  async function race() {
    const slack = botChannelSlackFetch();
    const { s, call, harness } = await boot({ fetchImpl: slack.fetchImpl });
    await seedSupportBot(s);
    const channels = createChannelStore(probe);
    expect(await channels.remove(BOT_INSTALL_ID, SUPPORT_CH, TEAM_AGENT.id)).toBe(true);
    const mention = (eventId: string, ts: string) => {
      const body = botMentionBody(eventId, ts, 'hello there');
      return call('POST', '/slack/events/:installId', request('POST', `/slack/events/${BOT_INSTALL_ID}`, {
        params: { installId: BOT_INSTALL_ID }, body, headers: signed(body, NOW_MS, BOT_SIGNING_SECRET),
      }));
    };
    const switchOff = () =>
      call('POST', '/settings/slack/:agentId/remember', request('POST', `/settings/slack/${TEAM_AGENT.id}/remember`, {
        as: ADMIN.id, params: { agentId: TEAM_AGENT.id },
        body: Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, remember: false })),
      }));
    return { s, harness, channels, mention, switchOff };
  }

  /** The one waiter on `pid`, once there is one. */
  async function waiterOn(pid: number): Promise<number> {
    let waiter = 0;
    await vi.waitFor(async () => {
      const [found] = await waitingOn(pid);
      expect(found).toBeDefined();
      waiter = found!;
    }, { timeout: 10_000 });
    return waiter;
  }

  it('the flip first: the bind waits for it, starts off, and memory stays out of the thread', async () => {
    const { s, harness, channels, mention, switchOff } = await race();
    // Holding the shared binding's row stops the flip inside its write, after its snapshot.
    const holder = await probePool.connect();
    let flip: Promise<Answer> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM channel_slack_v1_channels WHERE install_id = $1 AND channel_id = $2 FOR UPDATE',
        [INSTALL_ID, SUPPORT_CH],
      );
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      flip = switchOff();
      const flipPid = await waiterOn(holderPid);
      expect((await mention('Ev07ABCDEF61', '1763036300.000700')).status).toBe(200);
      // Before the fix the bind doesn't wait: it binds with the switch it reads, still on.
      await vi.waitFor(async () => {
        const waits = (await waitingOn(flipPid)).length === 1;
        expect(waits || (await channels.get(BOT_INSTALL_ID, SUPPORT_CH)) !== null).toBe(true);
      }, { timeout: 10_000 });
      await holder.query('COMMIT');
      expect(await flip).toEqual({ status: 200, body: {}, done: true });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      void flip?.catch(() => {});
    }
    await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
    expect((await channels.get(BOT_INSTALL_ID, SUPPORT_CH))?.remember).toBe(false);
    expect((await channels.get(INSTALL_ID, SUPPORT_CH))?.remember).toBe(false);
    expect(await channels.keptRemember(TEAM_AGENT.id, SUPPORT_CH)).toBe(false);
    const thread = `conv:slack:${BOT_INSTALL_ID}:${SUPPORT_CH}:1763036300.000700`;
    expect((await channels.getThread(thread))?.notRemembered).toBe(true);
    expect(await askMemory(harness.bus, thread)).toEqual(NOT_REMEMBERED);
  });

  it('the bind first: the flip waits for it, then turns the binding it wrote off too', async () => {
    const { s, harness, channels, mention, switchOff } = await race();
    // An uncommitted row under the bot binding's key stops the bind at its write, after its read.
    const holder = await probePool.connect();
    let flip: Promise<Answer> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO channel_slack_v1_channels (install_id, channel_id, agent_id, connected_by_user_id, channel_name)
         VALUES ($1, $2, $3, $4, 'support')`,
        [BOT_INSTALL_ID, SUPPORT_CH, TEAM_AGENT.id, GRACE],
      );
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      expect((await mention('Ev07ABCDEF62', '1763036400.000800')).status).toBe(200);
      const bindPid = await waiterOn(holderPid);
      let flipped = false;
      flip = switchOff().finally(() => {
        flipped = true;
      });
      // Before the fix the flip doesn't wait: it can't see the binding the bind is about to write.
      await vi.waitFor(async () => {
        expect(flipped || (await waitingOn(bindPid)).length === 1).toBe(true);
      }, { timeout: 10_000 });
      await holder.query('ROLLBACK');
      expect(await flip).toEqual({ status: 200, body: {}, done: true });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      void flip?.catch(() => {});
    }
    await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
    expect((await channels.get(BOT_INSTALL_ID, SUPPORT_CH))?.remember).toBe(false);
    expect((await channels.get(INSTALL_ID, SUPPORT_CH))?.remember).toBe(false);
    expect(await channels.keptRemember(TEAM_AGENT.id, SUPPORT_CH)).toBe(false);
    // Not the thread's flag: the turn may record it just before the flip commits or just after.
    // Memory is refused either way, once the bot's binding is off.
    const thread = `conv:slack:${BOT_INSTALL_ID}:${SUPPORT_CH}:1763036400.000800`;
    expect(await askMemory(harness.bus, thread)).toEqual(NOT_REMEMBERED);
  });
});
```

- [ ] **Step 2: Run them on the unfixed tree. Both must be red, for the right reason.**

Run (with `DOCKER_HOST` set as CLAUDE.md's Docker section says): `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts -t "TASK-1182"`

Expected: 2 failed. Each fails at `expect((await channels.get(BOT_INSTALL_ID, SUPPORT_CH))?.remember).toBe(false)` with `expected true to be false`.

A `waitFor` timeout means the barrier is wrong, not the product. In that case, fix the test before going on. Record both failure lines for the PR and the decisions shard.

- [ ] **Step 3: Commit:** `[TASK-1182] channel-slack: a switch flip and the bot's first bind, interleaved both ways (red)`

---

### Task 2: The switch lock, a locked flip, and the bot's first bind as one store call `[tier: sensitive]`, **security-checklist required**

**Files:**
- Modify: `packages/channel-slack/src/channel-store.ts`:
  - the header at `:30-46`;
  - the `ChannelStore` interface: the `setRemember` doc at `:125-137`, and the new `bindBot` after `keptRemember` (`:143`);
  - `setRemember` at `:287-319`;
  - the new `bindBot` implementation;
  - a new private `lockSwitch` near the table constants (`:175-177`).
- Modify: `packages/channel-slack/src/__tests__/memory-channel-store.ts`: the header at `:24-28`, and a new `bindBot`.
- Modify: `packages/channel-slack/src/migrations.ts:101-103`, the kept switch's reader: "(router.ts)" becomes `bindBot` (channel-store.ts).
- Test: `packages/channel-slack/src/__tests__/channel-store.test.ts`. Add a new `describe` after the TASK-1180 block (it ends at `:634`), and change `:452` "(router.ts reads it)" to "(bindBot reads it)".

**Interfaces:**
- Produces the following signatures, which Task 3 uses:
  - `ChannelStore.bindBot(b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>, sharedInstallId: string | null): Promise<boolean>`. It answers the switch it bound a new binding with. A reconnect keeps the stored switch (as `upsert` does), and the caller reads the binding back.
  - `memoryChannelStore().store.bindBot` follows the same rules.
- Private: `lockSwitch(db: Kysely<ChannelSlackDatabase>, agentId: string, channelId: string): Promise<void>`.

- [ ] **Step 1: Write the failing table test** in `channel-store.test.ts`:

```ts
/*
  TASK-1182. A team agent's own bot's first bind of a channel (bindBot) reads
  the switch the team last set for the agent there and writes the binding
  with it, in one transaction under the lock a flip takes: the agent's
  binding of the channel on the shared app's install, else the kept switch,
  else on. Another agent's binding there is never read, and the bind keeps
  nothing: it isn't a flip.
*/
describe("a team agent's own bot's first bind (bindBot)", () => {
  /** The bot's binding goes on its own install, OTHER_INSTALL; INSTALL is the shared app's. */
  const bind = (shared: string | null) =>
    channels.bindBot(
      { installId: OTHER_INSTALL, channelId: SUPPORT, agentId: AGENT, connectedByUserId: BOB, channelName: 'support' },
      shared,
    );
  /** Switched off, then disconnected: the off is kept and there's no shared binding. */
  const keptOff = async () => {
    await connect();
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
  };

  it.each([
    ["this agent's shared binding is off", () => connect({ remember: false }), INSTALL, false],
    ["this agent's shared binding is on, beside an older off kept", async () => { await keptOff(); await connect(); }, INSTALL, true],
    ['no shared binding, an off kept', keptOff, INSTALL, false],
    ['no shared app, an off kept', keptOff, null, false],
    ["another agent's shared binding is off: that agent's switch, never read", () => connect({ agentId: OTHER_AGENT, remember: false }), INSTALL, true],
    ['nothing anywhere', async () => {}, INSTALL, true],
  ] as const)('%s: the bot binds with it', async (_case, setup, shared, want) => {
    await setup();
    const kept = await channels.keptRemember(AGENT, SUPPORT);
    expect(await bind(shared)).toBe(want);
    expect(await channels.get(OTHER_INSTALL, SUPPORT)).toEqual({
      installId: OTHER_INSTALL, channelId: SUPPORT, agentId: AGENT, connectedByUserId: BOB,
      channelName: 'support', remember: want, createdAt: expect.any(Date),
    });
    // Not a flip: the bind keeps nothing.
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(kept);
  });
});
```

- [ ] **Step 2: Run it.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-store.test.ts -t "bindBot"` → 6 failed (`channels.bindBot is not a function`).

- [ ] **Step 3: Implement in `channel-store.ts`.**
  - **`lockSwitch`** runs the Global Constraints' lock statement on whatever `db` it is handed (always a transaction). Its doc says:
    - why an advisory lock and not a row's: the kept row may not exist, and the new binding doesn't until the bind writes it;
    - why it is its own first statement: a statement's snapshot predates any wait inside it;
    - the seed's family: routines 1842713x, tool-policy 1842714x, decisions 1842715x, channel-slack 18427161;
    - that a hash collision costs a wait, nothing else.
  - **`setRemember`** returns `db.transaction().execute(async (trx) => { await lockSwitch(trx, agentId, channelId); … })`. The existing CTE runs unchanged on `trx`, and the answer is the same.
  - **`bindBot`** is one `db.transaction()`:
    1. `lockSwitch(trx, b.agentId, b.channelId)`;
    2. `const locked = createChannelStore(trx)` (its `get`, `keptRemember` and `upsert` run on `trx`; never call its `setRemember`, `bindBot` or `removeForAgent`, which open transactions);
    3. `sharedInstallId === null ? null : locked.get(sharedInstallId, b.channelId)`, used only when its `agentId === b.agentId`;
    4. `?? await locked.keptRemember(b.agentId, b.channelId)`;
    5. `?? true`;
    6. `await locked.upsert({ ...b, remember })`;
    7. return `remember`.
  - **The interface doc of `bindBot`** says: the order above; "read and written in one transaction holding the lock `setRemember` takes on this agent and channel, so a flip and this bind never interleave: a flip that came first is what it reads, and one that comes second reaches the binding it wrote (TASK-1182)"; the answer; and "a failed read throws before anything is written: the switch is never guessed".
  - **The `setRemember` doc** gains one sentence: it takes the switch lock first, so it waits for a bot's first bind of the channel that is in progress, then reaches the binding that bind wrote.
  - **The header** (`:30-46`):
    - the kept switch's reader becomes `bindBot`;
    - add a paragraph: "A flip and a team agent's own bot's first bind never interleave (TASK-1182): each takes the switch lock on the agent and channel (`lockSwitch`) as its transaction's first statement and reads only after it, so whichever comes second sees what the other wrote. Any future writer of a binding's `remember` takes it too."

- [ ] **Step 4: Implement the fake's `bindBot`** in `memory-channel-store.ts`. Same order: the shared row at `key(sharedInstallId, b.channelId)` when it is this agent's, else `switches`, else `true`. Then `store.upsert({ ...b, remember })`, and return `remember`. Push `'bindBot'` to `calls`. Add one header sentence saying no lock is needed: the fake computes and writes in one synchronous run, so nothing can come between.

- [ ] **Step 5: Run the store suite and the package.**
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-store.test.ts` → PASS, including the existing `:520` "Disconnect … while a flip waits" barrier test.
  - `pnpm --filter @ax/channel-slack test` → PASS, except Task 1's two tests, which stay red (the router doesn't call `bindBot` yet: mutant M1).
  - `pnpm --filter @ax/channel-slack build` → PASS.

- [ ] **Step 6: Commit:** `[TASK-1182] channel-slack: a switch flip and a bot's first bind take one lock on the agent and channel`

---

### Task 3: The router binds through `bindBot` `[tier: integration]`

**Files:**
- Modify: `packages/channel-slack/src/router.ts`:
  - the RouterDeps `channels` doc and Pick (`:144-153`);
  - the `bindBotChannel` doc and body (`:854-912`);
  - delete `startingRemember` and `sharedRemember` with their docs (`:914-939`).
- Test: `packages/channel-slack/src/__tests__/router.test.ts`:
  - the world options at `:368-371`;
  - the `bindings` wrapper at `:601-609`;
  - the `it.each` at `:2849-2866`;
  - delete the test at `:2924-2938`.

**Interfaces:**
- Consumes `ChannelStore.bindBot(b, sharedInstallId): Promise<boolean>` (Task 2).
- RouterDeps `channels` becomes `Pick<ChannelStore, 'get' | 'recordThread' | 'bindBot'>`.

- [ ] **Step 1: Change the router tests first.**
  - **World options:** replace `keptReadFails` with `bindFails?: boolean`, doc: "The channel store fails a team agent's own bot's first bind (TASK-1182): it reads the switch and writes the binding in one transaction, so nothing is written."
  - **The `bindings` wrapper:** replace `upsert` and `keptRemember` with `async bindBot(...args: Parameters<ChannelStore['bindBot']>): ReturnType<ChannelStore['bindBot']>`. It throws the same `PluginError({ code: 'store-unavailable', … })` when `o.bindFails`, and otherwise returns `channels.store.bindBot(...args)`.
  - **The `it.each`:** rows `['switch', { bindFails: true }]` and `["shared app's install", { sharedReadFails: true }]`. Title: `"a bind that can't read the %s binds nothing and runs nothing: the switch is never guessed"`. Drop the comment "Binding read 1 is the bot's own binding, read 2 the shared app's." The body is unchanged.
  - **Delete** "a kept switch that can't be read binds nothing and runs nothing" (its case is now the `switch` row).

- [ ] **Step 2: Run them.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts` → the `switch` row and the bot-bind tests fail: the router still calls `upsert`/`keptRemember`, which the wrapper no longer has.

- [ ] **Step 3: Implement in `router.ts`.**
  - **`bindBotChannel`:** after the `connectable` check:
    - `const shared = await d.installs.current();`
    - `wrote` loses `remember`;
    - `const remember = await d.channels.bindBot(wrote, shared?.installId ?? null);`
    - keep the `get` read-back;
    - the fallback becomes `{ ...wrote, remember, channelName: cleanChannelName(info.name), createdAt: new Date() }`;
    - keep the `taken` comment.
  - **Delete** `startingRemember` and `sharedRemember`.
  - **The `bindBotChannel` doc** replaces the `startingRemember` sentence. Its memory switch is the one the team last set for the agent in this channel, read and written by the store in one transaction under the lock a flip takes (channel-store.ts `bindBot`, TASK-1182). The shared app's install is read first, outside that transaction, so the transaction needs no second database connection. A stale answer is harmless: with no shared binding the store falls back to the kept switch, which every flip writes. The failure sentence becomes "a failed read of the shared app's install, or of the switch, throws before anything is written."
  - **The RouterDeps `channels` doc:** "the binding a team agent's own bot writes at its first mention in a channel (TASK-1167), with the switch the team last set for the agent there, under the lock a flip takes (`bindBot`, TASK-1182)."

- [ ] **Step 4: Run everything in the package.**
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts` → PASS. The TASK-1179/1180 bot tests are unchanged.
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts -t "TASK-1182"` → **2 passed** (Task 1's tests are now green).
  - `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build` → PASS.

- [ ] **Step 5: Mutants (predict, then diff).** For each one, edit, run `plugin.test.ts -t "TASK-1182"`, restore with `git checkout -- <file>`, and check that `git status --short` is clean between runs. Predicted red sets:

  | Mutant | Predicted red |
  |---|---|
  | M1: `bindBot` without `lockSwitch` | (a) and (b) |
  | M2: `setRemember` without `lockSwitch` | (a) and (b) |
  | M3: `setRemember` takes the lock inside the CTE statement | (b) only |
  | M4: `bindBot` takes the lock and reads the shared binding in one statement | (a) only |

  Record the actual sets in the decisions shard. A mutant that stays green is a test gap to fix before the PR.

- [ ] **Step 6: Commit:** `[TASK-1182] channel-slack: the bot's first bind reads and writes its switch under the switch lock`

---

### Task 4: The design says it, plus a changeset `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:563-569` only. TASK-1170 edits other lines of this doc, including §9.
- Create: `.changeset/slack-switch-bind-lock.md`.

**Interfaces:** none.

- [ ] **Step 1: Edit the design.** Replace "A flip racing the bot's first answer in that channel can leave the bot on the value from just before the flip. After a flip on a channel still waiting for the bot, the page reads the status again, so it shows where the switch really landed." with:

  "A flip and the bot's first answer in that channel never interleave (TASK-1182). Both take one lock on the agent and channel, so whichever comes second sees what the other wrote, and the bot's binding ends with the switch's last value. After a flip on a channel still waiting for the bot, the page reads the status again, so a channel the bot answered in meanwhile shows on the bot's list."

- [ ] **Step 2: Write the changeset**, a patch for `'@ax/channel-slack'`:

```md
If someone turned a channel's "remember this channel" switch off at the same moment the agent's own Slack bot first answered there, the bot could go on remembering that channel. The switch and the bot's first answer now take turns, so the channel always ends up with the team's last choice.
```

- [ ] **Step 3: Check it.** `pnpm test:scripts` → PASS. It checks memory-cited paths and the memory guards.
- [ ] **Step 4: Commit:** `[TASK-1182] docs: a switch flip and the bot's first answer take turns`

---

## Final gate (before the PR)

1. Each of these must list nothing:
   - `git grep -n "startingRemember\|sharedRemember" packages`
   - `git grep -n "value from just before the flip" docs/plans/2026-11-09-channel-slack-design.md packages`
2. `git grep -n "pg_advisory" packages/channel-slack/src` lists only `channel-store.ts` (`lockSwitch` and its docs) and `migrations.ts:381` (existing).
3. `pnpm build && pnpm lint`.
4. `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with `DOCKER_HOST` as CLAUDE.md says. A Docker teardown or slot-wait timeout in an untouched package gets re-run alone, not waved through.
5. Rebase on `origin/main` and re-run `plugin.test.ts`, `router.test.ts` and `channel-store.test.ts`. TASK-1170 (bot-request DMs) edits `plugin.test.ts` after the TASK-1172 tests, `router.test.ts:~323` and other design-doc lines, so keep both sides. TASK-1173 touches `admin-routes.ts`/`slack-apps.ts` only.

## For the builder's handoff

- **PR security note** (from `security-checklist`, as the card asks):
  - **What was exposed:** a millisecond race could leave a bot channel's switch on after the team set it off, so memory could learn from members' messages in a channel the team excluded. Outsiders' turns were never remembered (unchanged).
  - **The fix:** a transaction-scoped advisory lock on (agent, channel), taken first by both writers.
  - **Untrusted input:** the lock key is the bot's agent id (from its install row) plus Slack's channel id (from a signature-verified event). It is JSON-encoded and bound as a parameter, never spliced into SQL.
  - **Denial of service:** no network call or other store inside the lock. `statement_timeout` bounds a wait. Only a team admin can flip, and a first bind happens once per bot and channel.
  - **Supply chain:** no dependency change.
  - **Residuals:**
    - the boot fill versus a flip (fails toward off; already in the design);
    - a crafted `/bot/remember` sent during the first bind now waits and then succeeds, instead of answering 404.
- **No boundary review.** `ChannelStore` is plugin-internal; no hook, IPC action or route changes.
- **Commit the planner's decisions shard together with this plan, or after it.** `.claude/memory/decisions/2026-11-20-TASK-1182.md` cites this file, and `memory-cited-paths-exist` only accepts tracked files.
- **TASK-1180 residual 4 is closed as a side effect:** two simultaneous flips of one agent's channel used to risk a deadlock and now queue. Say so in the PR. No test is added for it (YAGNI).
