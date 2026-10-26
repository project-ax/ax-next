# TASK-958: Keep step ids out of updates and asks

The TASK-954 walk's finding 2 records internal step ids in reports a person reads. The current populated checklist paragraph prints ids for `routine_report` edits, but neither it nor the get-done brief tells the agent to leave ids out of its update and ask. The premise holds; the walk is historical evidence, not stale guidance requiring a rewrite.

Use the checklist paragraph, beside the ids it explains, as the single instruction site. Keep ids available for edits and keep all step text quoted and labelled by its host-set author. No hooks, schemas, storage, UI, dependencies or tool descriptions change. The empty-checklist paragraph has no ids to explain. This is a prompt instruction, not a guarantee about every model response.

## Task 1 [tier: sensitive]

Add and pin this fixed wording in the populated steps paragraph of `packages/routines/src/checkin-message.ts`:

> Step ids are only for your step changes. In your update and ask, name a step by its words, never its id.

1. After `pnpm install --frozen-lockfile && pnpm build`, update the existing exact paragraph expectations in `packages/routines/src/__tests__/checkin-message.test.ts` first. Add a focused literal assertion for the instruction alongside assertions that both an agent step and a person step still carry their ids and quoted words. Existing tests cover an empty list, `steps: null`, quoting and author labels; retain them.
2. Run the focused test file and capture a red result caused by the missing sentence.
3. Insert the wording before the paragraph's final sentence (`A step the person wrote is in their words:`), so its colon still introduces the listed quoted text. Run the focused file again and capture green.
4. Run the security checklist: this renderer carries agent- and person-written steps, so confirm that the fixed guidance changes no interpolation, quoting, input caps, capabilities or authority labels. Include the structured note in the PR. No boundary review is needed because no hook or IPC signature changes.
5. Run `pnpm build`, `pnpm -r --no-bail run test`, `pnpm test:eslint-rules`, `pnpm test:scripts`, and `pnpm lint`. If Docker is unavailable, report affected suites honestly and rely on the full CI gate; do not restart OrbStack or touch a cluster.

After implementation, commit the code, tests, this plan and the decisions shard; obtain an independent exact-head review before opening a main-based PR. Stop at CI-green and mergeable under orchestration.

## Decisions and scope

- Put the instruction only where existing ids appear. Adding the same wording to the brief and tool description would add maintenance sites without closing another path in this bounded fix.
- The test pins the rendered instruction and retained internal edit ids. It does not make an untestable promise that an LLM will always comply.
- Security review is required by the repository's rule for a code path that handles untrusted content. The change is fixed copy only; no trust boundary is widened.
