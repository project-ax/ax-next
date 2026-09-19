// Shared contract test-suite for any plugin that registers the four
// workspace:* service hooks. The point: a single set of assertions that
// runs against every backend (MockWorkspace today, `@ax/workspace-git`
// next, anything else later) so we can prove the contract is genuinely
// interchangeable instead of accidentally git-shaped.
//
// Anything that passes here AND passes for `@ax/workspace-git` is
// backend-agnostic. Anything that needs backend-specific assertions
// belongs in that backend's own test file, not in here.
//
// This file imports `@ax/core` types only — no plugin imports — so the
// contract itself stays storage-agnostic (Invariant 1).

import { describe, it, expect } from 'vitest';
import { reject, type Plugin } from '@ax/core';
import { createTestHarness } from './harness.js';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceDiffInput,
  WorkspaceDiffOutput,
  WorkspaceVersion,
} from '@ax/core';

export function runWorkspaceContract(label: string, makePlugin: () => Plugin): void {
  describe(`workspace contract: ${label}`, () => {
    // Every scenario gets its own agentId. Backends that keep one process-
    // wide store (a shared git server, say) are then isolated scenario-from-
    // scenario by the very partition the isolation block below asserts,
    // instead of by a test-only override that switches the partition off.
    // That override is exactly how a ctx-ignoring backend used to slip
    // through this suite.
    let scenario = 0;
    async function load() {
      const h = await createTestHarness({ plugins: [makePlugin()] });
      const agentId = `contract-agent-${++scenario}`;
      return {
        ...h,
        /** This scenario's agent. Isolation cases derive siblings off it. */
        agentId,
        ctx: (overrides?: Parameters<typeof h.ctx>[0]) =>
          h.ctx({ agentId, ...overrides }),
      };
    }
    const enc = new TextEncoder();

    it('initial apply uses parent: null', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
      );
      expect(r.delta.before).toBeNull();
      expect(r.delta.after).toBe(r.version);
      expect(r.delta.changes).toHaveLength(1);
      expect(r.delta.changes[0]).toMatchObject({ path: 'a', kind: 'added' });
    });

    it('second apply must pass the previous version as parent', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
        )
      ).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 },
      );
      expect(v2.delta.before).toBe(v1);
      expect(v2.delta.changes[0]!.kind).toBe('modified');
    });

    it('parent mismatch raises PluginError with code: parent-mismatch', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [], parent: null },
      );
      await expect(
        h.bus.call('workspace:apply', h.ctx(), {
          changes: [],
          parent: 'definitely-not-a-real-version' as WorkspaceVersion,
        }),
      ).rejects.toMatchObject({ code: 'parent-mismatch' });
    });

    it('read returns { found: false } for unknown path', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        h.ctx(),
        { path: 'nope' },
      );
      expect(r.found).toBe(false);
    });

    it('read returns the version at which the bytes were stored', async () => {
      const h = await load();
      const v1 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
      );
      const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        h.ctx(),
        { path: 'a' },
      );
      expect(r.found).toBe(true);
      if (!r.found) return;
      expect(r.version).toBe(v1.version);
    });

    it('list with pathGlob honors the glob', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', h.ctx(), {
        changes: [
          { path: 'src/a.ts', kind: 'put', content: enc.encode('a') },
          { path: 'src/b.ts', kind: 'put', content: enc.encode('b') },
          { path: 'README.md', kind: 'put', content: enc.encode('r') },
        ],
        parent: null,
      });
      const list = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        h.ctx(),
        { pathGlob: 'src/**' },
      );
      expect([...list.paths].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('delete shows up as kind: deleted in the next delta', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
        )
      ).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'delete' }], parent: v1 },
      );
      expect(v2.delta.changes[0]).toMatchObject({ path: 'a', kind: 'deleted' });
    });

    it('contentAfter is lazy — not invoked unless called', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
      );
      const ch = r.delta.changes[0]!;
      expect(typeof ch.contentAfter).toBe('function');
      expect(await ch.contentAfter!()).toEqual(enc.encode('x'));
    });

    it('diff between two versions returns the same delta shape', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
        )
      ).version;
      const v2 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 },
        )
      ).version;
      const diff = await h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        h.ctx(),
        { from: v1, to: v2 },
      );
      expect(diff.delta.before).toBe(v1);
      expect(diff.delta.after).toBe(v2);
      expect(diff.delta.changes[0]!.kind).toBe('modified');
    });

    it('workspace:pre-apply veto rejects the apply (facade is wired for this backend)', async () => {
      // Finding 3: `workspace:apply` is the @ax/core facade — it fires
      // `workspace:pre-apply` (veto) around the backend's raw impl. A
      // registered veto must short-circuit the apply with
      // PluginError{code:'rejected'} and NOT mutate the workspace. Running
      // this through the shared contract proves every backend the contract
      // covers routes its public `workspace:apply` through the facade rather
      // than registering the raw hook directly.
      const h = await load();
      h.bus.subscribe('workspace:pre-apply', 'contract-veto', async () =>
        reject({ reason: 'contract veto', source: 'contract-veto' }),
      );
      await expect(
        h.bus.call('workspace:apply', h.ctx(), {
          // `.ax/**` is policy-visible, so it survives filterToPolicy and the
          // veto subscriber actually sees it.
          changes: [
            { path: '.ax/notes.md', kind: 'put', content: enc.encode('x') },
          ],
          parent: null,
        }),
      ).rejects.toMatchObject({ code: 'rejected' });

      // The workspace must be untouched — the rejected apply never reached
      // the backend impl, so the file isn't there.
      const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        h.ctx(),
        { path: '.ax/notes.md' },
      );
      expect(r.found).toBe(false);
    });

    it('opaque versions: subscribers must NOT depend on version string format', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [], parent: null },
      );
      // Documentation pin: if a subscriber reaches into r.version.startsWith('sha')
      // someday, they're violating the contract. This test asserts only that the
      // value is a string — nothing about its shape.
      expect(typeof r.version).toBe('string');
    });

    // -----------------------------------------------------------------------
    // TENANT ISOLATION (TASK-413)
    // -----------------------------------------------------------------------
    // Isolation is a property EVERY workspace backend owes its callers, and
    // until this block existed no shared assertion made any of them prove it.
    // That is how #583 happened: `@ax/workspace-git-server` partitioned
    // correctly, `@ax/workspace-git-core` never had, the chart's default
    // (`workspace.backend: local`) selects the core — and one user's Files tab
    // served another user's agent's file on a live deployment. Both backends
    // passed this same contract, start to finish, the whole time.
    //
    // THE PARTITION IS `agentId` ALONE. That is the policy `@ax/workspace-git-
    // server`'s `workspaceIdFor`, `@ax/workspace-git-core`'s
    // `workspaceIdForAgent` and the memory-index `agentScopeKey`s already
    // implement (TASK-257 / TASK-396), and it has to be asserted in BOTH
    // directions or the assertion is satisfied by the wrong key:
    //
    //   - different agentId  ⇒ ISOLATED (cases 1, 3, 5)
    //   - different userId   ⇒ SHARED   (case 4)
    //   - different sessionId ⇒ SHARED  (case 6)
    //
    // `ctx` carries exactly three identity fields, so those three axes are
    // the whole space: together they reject all seven wrong subsets of
    // {userId, agentId, sessionId}. MEASURED, one mutant per subset — the
    // isolation axis catches {}, {userId}, {sessionId}, {userId, sessionId};
    // the userId axis catches {userId, agentId}; the sessionId axis catches
    // {agentId, sessionId} and {userId, agentId, sessionId}.
    //
    // Case 6 exists because a round of review measured its absence. With
    // case 6 missing, a backend keyed on `(agentId, sessionId)` — "a fresh
    // workspace per conversation", an easy and plausible mistake — passed
    // all sixteen. Enumerating every FIELD is not enough; the completeness
    // claim is only as good as the subset you actually mutated.
    //
    // Case 2 is neither direction: it is a single-agent guard, and cases 4
    // and 6 double as guards. All pass before AND after any partitioning
    // fix, deliberately.
    //
    // Either direction alone passes under a partition on the pair
    // `(userId, agentId)`, which silently fragments a team agent's shared
    // files per-user. The sibling `runIndexContract` learned this the
    // expensive way: its original isolation case varied userId AND agentId
    // together, so it held under any partition containing either field. It
    // looked rigorous for months and pinned nothing about which key. Do not
    // reintroduce that shape — every ctx pair below varies EXACTLY ONE field.
    //
    // ⚠ NOT an access-control test. Nothing here says a caller MAY reach an
    // agent; that is the `agents:resolve` ACL's job, and since TASK-257 it is
    // the only barrier. This pins that two AUTHORIZED callers of one agent see
    // one workspace, and that two agents see two.
    describe('tenant isolation: the partition is agentId alone', () => {
      async function tenants() {
        const h = await load();
        // `sessionId` DEFAULTS to a constant, and that default is
        // load-bearing. It used to be `${userId}:${agentId}`, which made it
        // co-vary with whichever field a case was varying — so cases 1/3/5
        // varied agentId AND sessionId and passed against a backend
        // partitioned on `sessionId` alone (MEASURED: 1 red / 15 green, the
        // one red being case 4). With the default pinned, that same mutant
        // scores 3 red / 13 green: the direction cases catch it themselves.
        //
        // Case 6 then varies it EXPLICITLY, because a constant everywhere
        // pins nothing at all about `sessionId` — see the header.
        const caller = (
          userId: string,
          agentId: string,
          sessionId = 'contract-isolation',
        ) => h.ctx({ userId, agentId, sessionId });
        const write = (
          ctx: ReturnType<typeof caller>,
          path: string,
          body: string,
          parent: WorkspaceApplyInput['parent'] = null,
        ) =>
          h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
            'workspace:apply',
            ctx,
            { changes: [{ path, kind: 'put', content: enc.encode(body) }], parent },
          );
        const list = (ctx: ReturnType<typeof caller>) =>
          h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
            'workspace:list',
            ctx,
            {},
          );
        const read = (
          ctx: ReturnType<typeof caller>,
          path: string,
          version?: WorkspaceVersion,
        ) =>
          h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
            'workspace:read',
            ctx,
            version === undefined ? { path } : { path, version },
          );
        // Agent ids are suffixed off this scenario's base id, so two `it`s
        // never collide on a backend whose store outlives one plugin
        // instance (the git server's, for one).
        const A = `${h.agentId}-a`;
        const B = `${h.agentId}-b`;
        const SHARED = `${h.agentId}-shared`;
        return { h, caller, write, list, read, A, B, SHARED };
      }

      it("one agent's tree is invisible to a different agent", async () => {
        // Direction 1, the #583 walk reduced to its bones. The two ctxs differ
        // in agentId ONLY — same userId — so this cannot be satisfied by a
        // partition on userId.
        const { caller, write, list, read, A, B } = await tenants();
        const asA = caller('user-shared', A);
        const asB = caller('user-shared', B);

        await write(asA, 'CAVEMAN-POEM.md', 'CAVEMAN POEM\nby Caveman\n');

        expect((await list(asB)).paths).toEqual([]);
        expect(await read(asB, 'CAVEMAN-POEM.md')).toMatchObject({ found: false });
      });

      it('an agent still reads back its OWN file (anti-vacuity guard)', async () => {
        // A backend that answered "not found" to everybody satisfies every
        // isolation assertion in this block and is completely broken. It uses
        // ONE agent for that reason — it is not an isolation case. It passes
        // BEFORE and AFTER any partitioning fix, on purpose: it exists to fail
        // if a fix over-reaches. Do not "fix" it into failing against a pooled
        // backend — check instead that the others still do.
        const { caller, write, list, read, A } = await tenants();
        const asA = caller('user-shared', A);

        await write(asA, 'mine.md', 'hello');

        expect((await list(asA)).paths).toEqual(['mine.md']);
        const got = await read(asA, 'mine.md');
        expect(got.found).toBe(true);
        expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe(
          'hello',
        );
      });

      it('a second agent starts from an empty history — its first apply passes parent: null', async () => {
        // The structural half of isolation: not "B could not read A's file"
        // but "there is no single history for them to share". Against a pooled
        // backend A's apply advances the one head, so B's `parent: null`
        // raises `parent-mismatch` instead of succeeding.
        const { caller, write, list, A, B } = await tenants();
        const asA = caller('user-shared', A);
        const asB = caller('user-shared', B);

        const a1 = await write(asA, 'a.md', 'a');
        const b1 = await write(asB, 'b.md', 'b');
        expect(b1.delta.before).toBeNull();

        // ...and each history then continues independently from its OWN head.
        await write(asA, 'a2.md', 'a2', a1.version);
        await write(asB, 'b2.md', 'b2', b1.version);

        expect([...(await list(asA)).paths].sort()).toEqual(['a.md', 'a2.md']);
        expect([...(await list(asB)).paths].sort()).toEqual(['b.md', 'b2.md']);
      });

      it('two users of the SAME agent share ONE tree', async () => {
        // Direction 2, and the other anti-vacuity guard. The two ctxs differ
        // in userId ONLY — same agentId. A backend keyed on `(userId,
        // agentId)` passes every isolation case here and fails this one, which is
        // the whole reason both directions are asserted: it would turn a team
        // agent's shared files into per-user fragments and diverge from the
        // memory index, which partitions on agentId alone.
        //
        // Like the guard above, this passes against a fully pooled backend
        // too. That is correct — a guard is supposed to pass against the
        // mutant it is not aimed at.
        const { caller, write, list, read, SHARED } = await tenants();
        const alice = caller('user-alice', SHARED);
        const bob = caller('user-bob', SHARED);

        const first = await write(alice, 'team-notes.md', 'from alice');

        expect((await list(bob)).paths).toEqual(['team-notes.md']);
        const got = await read(bob, 'team-notes.md');
        expect(got.found).toBe(true);
        expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe(
          'from alice',
        );

        // The WRITE domain is shared too, not just the read view: bob
        // continues alice's history rather than forking a private one.
        const second = await write(bob, 'bob-notes.md', 'from bob', first.version);
        expect(second.delta.before).toBe(first.version);
        expect([...(await list(alice)).paths].sort()).toEqual([
          'bob-notes.md',
          'team-notes.md',
        ]);
      });

      it("an explicit version from one agent does not hand another agent the bytes", async () => {
        // `{ version }` is the one input that names a point in history
        // directly, so it is the obvious way around a partition enforced only
        // on the implicit head. Backends differ in HOW they refuse — a
        // storage-agnostic contract cannot demand `found: false` over a
        // thrown `unknown-version`, and both are honest refusals — so this
        // asserts the part that actually matters: agent B never receives
        // agent A's bytes. Against a pooled backend the read resolves and
        // hands them over.
        const { caller, write, read, A, B } = await tenants();
        const asA = caller('user-shared', A);
        const asB = caller('user-shared', B);

        const a1 = await write(asA, 'secret.md', 'agent A only');

        const out = await read(asB, 'secret.md', a1.version).catch(
          (err: unknown) => {
            // Only a STRUCTURED refusal counts. A bare `catch(() => notFound)`
            // would let an unrelated backend crash wear the isolation costume
            // and report green.
            expect(err).toMatchObject({ code: expect.any(String) });
            return { found: false } as WorkspaceReadOutput;
          },
        );
        expect(out.found).toBe(false);
      });

      it('two sessions of the SAME agent share ONE tree', async () => {
        // Direction 3, and the third guard. The two ctxs differ in sessionId
        // ONLY — same userId, same agentId.
        //
        // This case was MISSING until review measured what that cost: with
        // `sessionId` constant in every other case, nothing varied it, so
        // nothing pinned it out of the key, and a backend partitioned on
        // `(agentId, sessionId)` passed all sixteen assertions. That backend
        // is "a fresh workspace per conversation" — an agent's files would
        // vanish between chats and never be shared across a user's sessions.
        // It is the kind of wrong that looks like a feature.
        //
        // Like the other guards this passes against a fully pooled backend.
        const { caller, write, list, read, SHARED } = await tenants();
        const first = caller('user-shared', SHARED, 'session-one');
        const second = caller('user-shared', SHARED, 'session-two');

        const v1 = await write(first, 'across-sessions.md', 'written in session one');

        expect((await list(second)).paths).toEqual(['across-sessions.md']);
        const got = await read(second, 'across-sessions.md');
        expect(got.found).toBe(true);
        expect(got.found === true && new TextDecoder().decode(got.bytes)).toBe(
          'written in session one',
        );

        // One history, not two: the second session continues the first's.
        const v2 = await write(second, 'reply.md', 'written in session two', v1.version);
        expect(v2.delta.before).toBe(v1.version);
      });
    });
  });
}
