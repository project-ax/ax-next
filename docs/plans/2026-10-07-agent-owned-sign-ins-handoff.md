# Handoff — agent-owned connector sign-ins epic (2026-10-07)

Paste the prompt at the bottom into a new session. Everything above it is context.

## The epic, in one paragraph

Agents act as "digital employees" with their own accounts: agent 1 uses Gmail as bob@, agent 2 as alice@, even when one person owns both.

- Every agent owns its sign-ins.
- Admins alone define connectors (Admin › Connectors).
- People add connectors to agents from the agent rail. Signing in is part of Add, all or nothing.
- The spec is `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` (on these branches). Its "Slices" section was revised: the lookup flip lands last.

## Where things are

**Worktree:** `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-owned-sign-ins`. Never use the shared main checkout.

| Slice | Branch | PR | State |
|---|---|---|---|
| 1 — purge sign-ins on delete | `feat/agent-owned-sign-ins` | #969 → main | review-clean, CI 11/11 green |
| 2a — admins define connectors, Settings › Sites | `feat/agent-owned-sign-ins-2a` | #970 → slice 1 | review-clean; no CI (stacked) |
| 2b — delete cleanup + one-time non-admin removal | `feat/agent-owned-sign-ins-2b` | #971 → 2a | review-clean; no CI (stacked) |
| 2c — agent proposals go to admins | `feat/agent-owned-sign-ins-2c` (head `5e2eefa88`, **not pushed**) | none yet | all tasks + final review + fix wave re-reviewed clean; **full gate was running when the session ended** |

**CI only runs on PRs targeting `main`**, so the stacked PRs get CI once #969 merges and they're retargeted.

**Per-slice plans:** `docs/plans/2026-10-07-agent-owned-sign-ins-slice{1,2a,2b,2c}-plan.md`.

**Ledger** (git-ignored, survives on disk): `.superpowers/sdd/2026-10-07-agent-owned-sign-ins-slice2c-plan/progress.md`. It holds every 2c ruling and deferred minor. Slices 1, 2a and 2b ledgers were deleted after their PRs; their rulings are in the PR bodies and the decisions shards.

**Decisions shards** (on the branches): `.claude/memory/decisions/2026-10-07-SIGNINS-{1,2,3,4}.md`.

## Immediate next steps

1. **Re-run the 2c gate.** The background run died with the old session.

   ```bash
   export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000
   pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
   ```

   A file-level failure from a container-slot or hook timeout under load is the machine. Re-run that package on its own before calling it red.
2. **Push 2c and open its PR** with base `feat/agent-owned-sign-ins-2b`, following the PR bodies of #969, #970 and #971. Required sections:
   - **What changes.**
   - **Boundary review:**
     - `connectors:list-authored-pending-all` and `connectors:clear-authored-by-id`: alternate impl is an external approvals queue; no leaky names; unscoped system reads/deletes are only called by adminOnly routes.
     - The `createOnly` upsert flag: alternate impl is put-if-absent; route-set only.
     - Removed: `connectors:proposed`, `list-authored`, `list-authored-pending`, `activate-authored`, `clear-authored`, `agent:apply-authored-connector-grant`, `skills:approved-caps-set`.
   - **Security review**, with three lines:
     - **Sandbox:** no new reach. It narrows creation to admins, `POST /admin/connectors` is create-only (confused-deputy fix), and "Set it up" carries only the fields the editor shows.
     - **Injection:** proposal text is untrusted and rendered as text. The proposer label is an uncapped display name. "Set it up" auto-probes host discovery (HTTPS 443, GET, DNS-pinned, rate-limited).
     - **Supply chain:** N/A.
   - **Known gaps:**
     - no per-user cap on pending requests (each needs a held call approved by a human);
     - the remote form writes to the vault before the create, so a 409 can leave a written key;
     - existing pending drafts surface with their age.
3. **Continue the epic with slice 3**, then 4, 5, 6 and 7, each with its own plan, subagent-driven, stacked:
   - **Slice 3 — agent-owned sign-in + all-or-nothing Add.**
     - mcp-oauth `begin` requires an agent, always uses agent scope, and adds `prompt=select_account` (`select_account consent` for Google).
     - The callback writes the token, then attaches, then seeds the tool verdicts. On any failure it deletes the token.
     - Pending state carries Add vs Sign in again.
     - The API-key Add route writes at agent scope with the same compensation.
     - Rail menu: Edit / Remove, plus Sign in again on rows that need sign-in. Delete `signOutIfUnused` and the no-agentId sign-in callers.
   - **Slice 4 — "Signed in as".** Capture identity through OIDC id_token/userinfo when advertised. `status-batch` gains `account`, `signedInBy` and `signedInAt`. Rows fall back to "Signed in by X on date".
   - **Slice 5 — lookup flip + boot purge.**
     - `account:` refs resolve agent → global only, and writes of `account:` at user scope are refused.
     - A boot purge removes user-scope `account:` rows (`credentials:purge-account {scopes:['user']}`).
     - **It must also drop the user AND agent reconnect markers for non-live ids.** mcp-oauth misses the boot-time events; see SIGNINS-3.
     - Retire `remove-personal-sign-in` and the user marker table, and update the 22 test files that assume person-level rows.
   - **Slice 6 — routine skip warning:** `lastWarning` next to `lastStatus`/`lastError`.
   - **Slice 7 — the (walk):** two Linear accounts on two agents on kind (`--context kind-ax-next-dev` only).
   - **Deploy only after slice 5.**

## Owner decisions (don't relitigate)

- B: the account belongs to the agent ("digital employee").
- A: every agent owns its sign-ins.
- Team agents get one account per connector, used by everyone.
- Admin-only connectors. Personal Settings › Connectors is removed; Admin › Connectors replaces it.
- Signing in is part of Add (all or nothing).
- API key: filled in at creation means shared; blank means each agent adds its own. This is fixed at creation.
- No choice step. The popup opens directly, with `prompt=select_account`.
- Row menu: Edit + Remove, plus Sign in again on expired rows.
- Migration: everyone signs in again.
- Remove all existing non-admin connectors, including `'system'`-owned ones: "I don't care if existing skills are broken".
- Site lists moved unchanged to Settings › Sites. Merging them is TASK-886.

## Rulings made for the owner (see the PR bodies and shards)

- The `keyMode` `personal`→`agent` rename was dropped (cost vs benefit).
- Slice 2 was split into 2a/2b/2c.
- A non-owner admin may only relabel a shared connector. Reach comes from the stored row, and the 403 `owner-only-change` only chooses the message (parser-differential lesson).
- The one-time non-admin sweep has a persisted marker. Purge failures block the marker; unparseable rows don't.
- Only shared creates clear requests. Dedup and queue hiding are shared-only (cross-tenant).
- The chat connector card was removed, not made informational. Approval is creation.

## Board cards filed this epic

- **TASK-886 (Backlog):** web_extract reads given links freely and asks only for made-up addresses, leaving one Allowed sites list.
- **TASK-887 (Backlog):** retargeting a connector must sign agents out and clear its shared key. Also notes the interim delete-and-recreate gap that 2b and 5 close.
- **Follow-up candidates, not yet filed:**
  - the stdio sweep hard-deletes despite reported purge failures;
  - an mcp-oauth↔connectors contract test for the meaning of absent `clientRegistration`/`scopes`;
  - `scripts/test-remote-mcp-modal.mjs` is stale (it waits for a button the form no longer has);
  - `connectors:live-ids` rejects a whole batch on one invalid id;
  - a browser walk of Admin › Connectors / Awaiting approval / Settings › Sites.

## Process that worked (user chose subagent-driven, "keep going until done")

- **One plan per slice**, written by the controller with exact file:line pointers from an Explore mapping.
- **Per task:**
  1. An implementer subagent (sonnet for mechanical work, opus for judgment or security) gets the brief plus the report contract.
  2. A task reviewer, with an adversarial named-risk list.
  3. Fix rounds that resume the same implementer.
  4. A scoped re-review.
- **Per slice:** a final `ax-code-reviewer` on the `fable` model, then one fix wave, then a scoped re-review.
- **Background commit security reviews fire automatically and found real bugs every slice.** Treat each one as a fix-round input.
- **Operating notes:**
  - Use `pnpm --filter X test` (filter first).
  - Run Docker suites one at a time, and set `AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`.
  - Rebuild a package (`pnpm --filter X build`) before running the k8s preset tests that import its dist.
  - zsh: never name a variable `path`.
  - The default kubectl context is GKE PROD.
  - Board ids: claim one card at a time with `scripts/board-task-id.sh`. The list view lags, so verify the card by node id.

---

## Prompt for the new session

```
Continue the agent-owned connector sign-ins epic in ax-next. Work ONLY in the worktree
/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-owned-sign-ins (branch feat/agent-owned-sign-ins-2c).
Read docs/plans/2026-10-07-agent-owned-sign-ins-handoff.md first, then the spec
docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md and the 2c ledger
.superpowers/sdd/2026-10-07-agent-owned-sign-ins-slice2c-plan/progress.md.

State: slices 1/2a/2b are PRs #969/#970/#971 (stacked). Slice 2c is done and review-clean at 5e2eefa88 but
NOT pushed and its full gate didn't finish. Next: re-run the full gate (see handoff for the exact command and
env), push 2c and open its PR with base feat/agent-owned-sign-ins-2b (boundary review + security review in the
body, per the handoff). Then continue with slice 3 using the same process: write the slice plan
(superpowers:writing-plans), execute subagent-driven (superpowers:subagent-driven-development), final
ax-code-reviewer review, PR stacked on the previous slice. Keep going until the epic is done; don't stop to
check in between tasks. Respect the owner decisions listed in the handoff; don't relitigate them.
Safety: default kubectl context is PRODUCTION — only ever use --context kind-ax-next-dev. Never merge to main
or force-push without asking.
```
