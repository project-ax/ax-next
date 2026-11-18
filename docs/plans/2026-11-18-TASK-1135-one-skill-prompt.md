# TASK-1135: one prompt for a skill that reaches a connector, naming its host. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task's heading carries its tier; tasks marked **security-checklist** need the `security-checklist` skill walked before the PR.

**Goal:** In an attended turn, one "use this skill" request shows exactly one card, the skill card. In Slack, that card names the host(s) the skill will reach. Allow attaches the skill.

**Architecture:** Three changes. First, a policy flag makes `@ax/decisions` skip the redundant `request_capability` hold when someone is there to answer the tool's own card (the hold stays for routines and outsiders). Second, `request_capability` tells the model in fixed words that nothing is connected yet and to end its turn. Third, channel-slack reads the `hosts` and `packages` that the card already carries (the same fields the web's grant row draws) and names them in the prompt.

**Tech stack:** TypeScript, vitest, zod (bus `returns` schemas), Slack Block Kit (`plain_text`), Postgres-backed canaries (Testcontainers; needs an explicit `DOCKER_HOST`).

**Spec:** the card, plus `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md` findings 1 and 7. Rationale and rejected options are in `.claude/memory/decisions/2026-11-18-TASK-1135.md`.

## Root cause (traced in code)

1. **Turn 1.** The model calls `request_capability`. tool-policy holds it (`packages/tool-policy/src/rules.ts:145-152`), and decisions records a pending row (`packages/decisions/src/pre-call.ts:258-417`). The runner ends the turn at the hold. Slack posts **prompt 1**, which shows only the summary "Wants to gain access to a new service or key".
2. **Allow, then the continuation.** The warm agent re-issues the call, and it runs. It returns `{status:'requested', skillId}` (`packages/skill-broker/src/tools/request-capability.ts:318`) and fires the `chat:permission-request` skill card (`:298-316`).
   - The model read `requested` as "now connected!" (TASK-1130 context shard) and called `web_extract`. tool-policy held that call (`rules.ts:245-255`: the host isn't on the allowlist), so Slack posted **prompt 2**.
   - The skill card became **prompt 3**: "Wants to start using the walk-weather-report skill: …" (`packages/channel-slack/src/copy.ts:158-161`).
   - The prompt can't name hosts because `narrowPermission` drops `hosts` (`packages/channel-slack/src/turn-registry.ts:64-66,146-151`).
3. **Why prompts 1 and 2 came from different turns.** One turn posts at most one held prompt (`turn.ts:640-642` `firstHeld`).
4. **The web has the same double ask.** First the ApprovalCard, then the GrantRow. Nothing de-duplicates them.

## Design

- **Prompt 1 (the redundant hold).** Add `PolicyRule.holdsOnlyUnattended?: true` on `skills.request-capability`. `tool-policy:evaluate` reports it on a `hold` answer. `@ax/decisions`, already reading attendance on its hold branch, returns `undefined` (the call runs) when the turn is `attended`.
  - Attended means a web or Slack conversation and not an outsider's turn (`decisions/src/attendance.ts:139-148`).
  - Unattended turns are still held: a routine's own run, an outsider's turn, or any lookup that fails.
  - This changes the web too, on purpose.
- **Prompt 2 (the misread result).** When a card fires, `request_capability` returns `{status:'requested', skillId, message}`, where `message` is fixed host-written text: not connected yet, end your turn, don't try another way. The descriptor gains one sentence to match.
  - No structural turn stop exists for a host tool. Adding one would span both runners and the wire.
- **Prompt 3 names its reach.** `reach: {hosts, downloads} | null` is narrowed from the card.
  - `COPY.skillSubject` puts the reach clause *before* the description, so the 400-unit subject cap can only cut the description.
  - Slack offers Allow only when every host passes `HOST_RE` and that head survives `cleanPromptSubject` unchanged. Otherwise the person gets the web link, as for a key.
- **Not in scope.**
  - The unattended double ask.
  - TASK-1137's no-reach branch. That branch is left unchanged, but note: `walk-haiku` now gets *no* prompt in an attended turn. If TASK-1137 makes that branch fire a card, it should return the same `message`.
  - Narration (TASK-1141).
  - `capabilityHandoffNote`: a runner-side change, so no runner image rebuild.
  - Durable Slack prompts.

## Global constraints

- Invariant 2: decisions mirrors the new field in its local `PolicyAnswer` and never imports tool-policy. channel-slack keeps its own `HOST_RE` copy.
- Only `holdsOnlyUnattended === true` on a `verdict === 'hold'` answer relaxes. Absent, stripped, any other value, or an attendance answer other than `'attended'` all hold.
- `request_capability` never returns a host, slot name, package or key to the model (`packages/skill-broker/SECURITY.md`).
- Every Slack word is a `COPY` line. A subject is `plain_text`, cleaned once at draw (`blocks.ts`). No `<!`, `<@`, `<#` or bare broadcast in COPY (copy.test.ts invariants).
- Test with `pnpm --filter <pkg> test` (filter BEFORE the script), and run `pnpm --filter <pkg> build` (tsc) too: vitest tolerates type errors.
  - Final gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  - Docker-backed suites (decisions canary, preset-k8s composition) need an explicit `DOCKER_HOST` (CLAUDE.md).
- No change under `packages/agent-runner-core`, `packages/agent-claude-sdk-runner` or `packages/agent-aisdk-runner`.
- kubectl: always `--context kind-ax-next-dev`. The default context is GKE prod.

## Boundary review (`tool-policy:evaluate`'s answer gains optional `holdsOnlyUnattended: true`)

- **Alternate impl:** an external policy engine (say an OPA- or Cedar-backed `tool-policy:evaluate`) can say "hold only when nobody is there" with the same field.
- **Leaky names:** none. "Unattended" is product vocabulary (is a person there to answer?), not a channel, transport or storage term.
- **Subscriber risk:** the callers are decisions' pre-call and its routine authorization, which reads only `verdict`. A caller that ignores the field keeps holding, which is the safe direction.
- **Wire surface:** none. This is not an IPC action. The runner still sees allow, hold or deny at `tool.pre-call`. The `chat:permission-request` payload is unchanged: `hosts` and `packages` are already on it.

## Review focus

1. **The bus drops the new field** (the `returns` z.object strips undeclared keys). Every attended request is held again, silently. → Task 1, canary test.
2. **The attendance read can't tell.** No conversation, a failed lookup, or an outsider's turn must still hold. → Task 2, tests (unattended) and canary (outsider, routine).
3. **The card lacks `hosts`/`packages`, or they're malformed.** That's an older producer or a test fixture. Slack must send the person to the web app, never offer Allow without the reach. → Task 4.
4. **Many hosts, a long skill id, a host outside `HOST_RE`, or an id the cleaner would change.** Slack must not show a cut or altered host list. It falls back to the web link. → Task 4.
5. **The model still calls another held tool after the card.** No automated test can measure this. Task 3 pins the exact text, and the kind walk is the check (Manual acceptance).

---

### Task 1: tool-policy, a hold that applies only when nobody is there `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/tool-policy/src/types.ts`. `PolicyRule` (after `routineConsent?`, ~line 140), `EvaluateResult` (~line 244), `EvaluateResultSchema` (lines 730-745).
- Modify: `packages/tool-policy/src/evaluate.ts:117-147`.
- Modify: `packages/tool-policy/src/rules.ts:117-152`.
- Test: `packages/tool-policy/src/__tests__/rules.test.ts` (41-48 and new tests), `evaluate.test.ts`, `tool-policy.canary.test.ts:32-50`.

**Interfaces:**
- Produces:
  - `PolicyRule.holdsOnlyUnattended?: true`
  - `EvaluateResult.holdsOnlyUnattended?: true`: present only when the matched rule sets it AND the answer's verdict is `'hold'`.
  - Schema: `holdsOnlyUnattended: z.literal(true).optional()`.

- [ ] **Step 1: Write the failing tests.**
  - `rules.test.ts`, new test `'holdsOnlyUnattended is on skills.request-capability alone, and only a hold may carry it'`. Assert `BUILTIN_RULES.filter(r => r.holdsOnlyUnattended === true).map(r => r.id)` equals `['skills.request-capability']`, and every flagged rule has `verdict === 'hold'`.
  - `rules.test.ts`, the existing test at :41. Rename it `'holds request_capability when nobody is there to answer its own card'`. Keep `verdict === 'hold'` and add `expect(rule!.holdsOnlyUnattended).toBe(true)`. Rewrite its comment: AW-4's canary now takes the first hold rule WITHOUT the flag.
  - `evaluate.test.ts`, new test `'a hold that holds only unattended calls says so; no other answer carries the field'`.
    - `evaluate(BUILTIN_RULES, {name:'request_capability', input:{skillId:'x'}})` matches `{verdict:'hold', ruleId:'skills.request-capability', holdsOnlyUnattended:true}`.
    - The answers for `connector_propose`, `web_search` and `'no_such_tool'` have no `holdsOnlyUnattended` property.
    - A synthetic rule `{id:'t.x', match:{tool:'x'}, providedBy:'host', verdict:'hold', capability:'do x', subject:'agent', egress:{urlField:'url'}, holdsOnlyUnattended:true}`, evaluated with `allowedHosts: new Set(['a.example'])` on `{url:'https://a.example/p'}`, gives `verdict:'allow'` with no `holdsOnlyUnattended`.
  - `tool-policy.canary.test.ts`.
    - Add `...(holdRule.holdsOnlyUnattended === true ? { holdsOnlyUnattended: true } : {})` to the expected object at :39-50.
    - Add a new test `'holdsOnlyUnattended survives the bus returns parse'`: call `tool-policy:evaluate` through the bus for `request_capability` and expect `.holdsOnlyUnattended` to be `true`.
    - Comment it: deleting the schema line makes this fail, and decisions would then hold every attended request again.
- [ ] **Step 2: Run `pnpm --filter @ax/tool-policy test`.** Expected: FAIL (the property is missing).
- [ ] **Step 3: Implement.**
  - Doc the field on `PolicyRule`: only for a hold whose tool does nothing but put its OWN card in front of the person, where Allow on that card is what grants; never on a tool that acts by itself.
  - In `evaluate()`, compute the verdict once, then spread `holdsOnlyUnattended: true` only when `rule.holdsOnlyUnattended === true && verdict === 'hold'`.
  - In `rules.ts`, set the flag on `skills.request-capability`.
    - Replace the comment at 142-144 ("The canary's rule…"): attended calls run, because the card asks; this hold is for unattended calls (TASK-1135); AW-4's canary uses the first hold rule without the flag.
    - Add to the Holds block (118-123) that the "turn-scoped card" premise is stale: `@ax/conversations` has persisted every permission card as a `permission-card` event since TASK-66 (`conversations/src/plugin.ts:1256-1291`).
- [ ] **Step 4: Run `pnpm --filter @ax/tool-policy test && pnpm --filter @ax/tool-policy build`.** Expected: PASS.
  - Other suites that `toEqual` a `request_capability` answer (`verdict-hooks.test.ts:127`, `routine-consent.canary.test.ts:88`) gain the field. Update only those expectations.
- [ ] **Step 5: Commit.**

### Task 2: decisions, don't hold it when someone is there to answer the card `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/decisions/src/pre-call.ts:59-73` (`PolicyAnswer`) and `:258-286` (step 3).
- Test: `packages/decisions/src/__tests__/pre-call.test.ts`, `decisions.canary.test.ts:179-186,208` plus a new describe block.
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts:1277-1279,1355` (switch the held-call tool).
- Modify: `presets/k8s/src/index.ts:1108-1110,1180-1182` (comments).

**Interfaces:**
- Consumes: Task 1's `holdsOnlyUnattended` on the answer.
- Produces: `PolicyAnswer.holdsOnlyUnattended?: boolean | undefined`, and the info log `decision_hold_skipped_attended {plugin, tool, ruleId}`.

- [ ] **Step 1: Write the failing tests.** `pre-call.test.ts`, new describe `'TASK-1135: a hold that applies only when nobody is there'`, with `ONLY_UNATTENDED = {...HOLD, holdsOnlyUnattended: true}` and the file's `build()`:
  - `'attended: the call runs, nothing is recorded or raised, and it is logged'`.
    - `await sub(ctx(), CALL)` is `undefined`, and `store.rows.size` is `0`.
    - Nothing is heard on `decisions:raised`: subscribe on a bus as at :685.
    - The logger saw `decision_hold_skipped_attended` with `{tool:'request_capability', ruleId:'skills.request-capability'}`. To capture log lines, use `ctx({ logger: createLogger({ reqId: 'r', writer: (l) => lines.push(l) }) })` from `@ax/core`, as `agents-deleted.test.ts:162` does.
  - `'unattended: held as before, and the row says unattended'`. With `attendanceFor: async () => 'unattended'`, the result is `isHold`, and the row has `attendance === 'unattended'`.
  - `'only true relaxes: absent or any other value holds in an attended turn'`. Run it for `HOLD` and for `{...HOLD, holdsOnlyUnattended: 'yes' as unknown as boolean}`.
  - `'attendance is read once per held call'`. A counting `attendanceFor` is called exactly once for a flagged unattended hold, and once for a plain hold.
  - `'a non-hold answer never reads the flag or attendance'`. `{...ALLOW, holdsOnlyUnattended: true}` gives `undefined`, and `{...DENY, holdsOnlyUnattended: true}` gives a rejection that is not a hold. `attendanceFor` is not called in either case.
- [ ] **Step 2: Run `pnpm --filter @ax/decisions test -- pre-call`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - At the top of step 3 (before `naming`), set `const attendance = await deps.attendanceFor(ctx)`.
  - If `answer.holdsOnlyUnattended === true && attendance === 'attended'`, log and `return undefined`.
  - Use `attendance` in the `Decision` row (replacing the read at :286).
  - Doc the mirror field the way `irreversible` is documented (optional on this side).
- [ ] **Step 4: Fix the canary.**
  - Use one selector, `r.verdict === 'hold' && r.holdsOnlyUnattended !== true`, for both `IRREVERSIBLE_RULES` (:184) and `HOLD_RULE` (:208). It picks `connectors.propose`.
  - Add `expect(HOLD_RULE.holdsOnlyUnattended).not.toBe(true)` where the constants are first used.
  - New describe `'TASK-1135: request_capability over the real rule table'`, booted with `slackChannels()`, firing `tool:pre-call` with `{id:'c-cap', name:'request_capability', input:{skillId:'walk-weather-report'}}`:
    - `userCtx` (web) and `slackCtx(h,'user')`: not a hold, not a rejection, `decisions:list` for `u1` is empty, and nothing is heard on `decisions:raised`.
    - `slackCtx(h,'external')`: held, and the row has `attendance:'unattended'` and `ruleId:'skills.request-capability'`.
    - `routineCtx`: held. Approve it, and a `recordExecutor(h,'request_capability')` runs exactly once with the recorded call.
- [ ] **Step 5: Keep the Slack composition green.**
  - In the two held-call tests (:1279 and :1355), call `connector_propose` with input `{ connectorId: 'calendar' | 'drive' }` instead of `request_capability`.
  - Comment: an attended `request_capability` is no longer held (TASK-1135).
  - In `presets/k8s/src/index.ts`, say the AW-3 table holds `request_capability` when nobody is there to answer its card (:1108-1110), and that the canary exercises its host replay on the unattended path (:1180-1182).
- [ ] **Step 6: Run `pnpm --filter @ax/decisions test && pnpm --filter @ax/decisions build && pnpm --filter @ax/preset-k8s test -- channel-slack-composition`.** Expected: PASS.
- [ ] **Step 7: Commit.**

### Task 3: skill-broker, "not connected yet: end your turn" `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/skill-broker/src/tools/request-capability.ts:15-27` (descriptor), `:41-44` (result type), `:316-318` (card path).
- Modify: `packages/skill-broker/src/plugin.ts:91-94` (comment), `packages/skill-broker/SECURITY.md:30-34`.
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts` (275, 411, 448, 780, 840) and `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts:787,856,928`.

**Interfaces:**
- Produces:
  - `export const REQUESTED_MESSAGE: string`.
  - `RequestCapabilityResult = { status: 'requested' | 'not-found'; skillId: string; message?: string }`. `message` is present iff a card was fired.

- [ ] **Step 1: Write the failing tests** in `plugin.test.ts`.
  - `'a fired card: the answer says not connected yet and to end the turn, in fixed words that name no host, slot or package'`.
    - Use a skill whose connector resolves to hosts `['api.open-meteo.com']`, a slot `'api_key'` and npm `['left-pad']`.
    - The ack equals `{status:'requested', skillId, message: REQUESTED_MESSAGE}`.
    - `REQUESTED_MESSAGE` doesn't match `/open-meteo|api_key|left-pad/`.
  - `'no card (nothing it reaches): the answer is unchanged, TASK-1137 owns that branch'`. The ack equals `{status:'requested', skillId}`.
  - `'the descriptor says to end the turn after requesting'`. The description contains `'end your turn after requesting it'`.
  - Update the existing `toEqual` acks: a card path gains `message`; a no-reach path doesn't. Check each against whether its test fires a card.
- [ ] **Step 2: Run `pnpm --filter @ax/skill-broker test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use this exact text. *(Superseded after review: the shipped descriptor and message differ. See `request-capability.ts` and the review rows in the decisions shard; don't restore the wording below.)*
  - Descriptor: insert after "…the approval surface handles it.":
    `Until the user approves, the skill is not connected: end your turn after requesting it, and don't try to do the same thing another way in the meantime.`
  - Constant:
    `REQUESTED_MESSAGE = "Not connected yet. The user has been asked to approve this skill, and it can't be used until they do. Tell them in one short sentence that you've asked, then end your turn. Don't try to do the same thing another way in the meantime (for example with web_extract): wait for their answer."`
  - Return it only after `bus.fire('chat:permission-request', …)`. Pattern and comment style: `REPLY_MESSAGES` in `packages/tool-connector-propose/src/plugin.ts:80-86`.
  - `SECURITY.md`: the result is a status, the skill id and, when a card was raised, one fixed host-written sentence. Never hosts, slots or keys.
  - `plugin.ts:91-94`: held by the AW-3 table when nobody is there to answer its card.
- [ ] **Step 4: Run `pnpm --filter @ax/skill-broker test && pnpm --filter @ax/skill-broker build && pnpm --filter @ax/skills test -- skill-install`.** Expected: PASS. Update the e2e card-path acks only.
- [ ] **Step 5: Commit.**

### Task 4: channel-slack, the skill prompt names what it reaches `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/turn-registry.ts:56-66,140-153`.
- Modify: `packages/channel-slack/src/copy.ts:140-161`.
- Modify: `packages/channel-slack/src/permission-prompts.ts:52-64,182-201`.
- Modify: `packages/channel-slack/src/limits.ts:194-200` (comment).
- Modify: `packages/channel-slack/src/turn.ts:78-79,855-858` (comments only: `askFor` already passes the card to `skillPromptFor`).
- Test: `turn-registry.test.ts`, `copy.test.ts`, `permission-prompts.test.ts`, `turn.test.ts`.
- Fixture: `presets/k8s/src/__tests__/channel-slack-composition.test.ts:1531` fires a skill card without `hosts`/`packages`. Give it the broker's shape, `hosts: []` and `packages: {npm: [], pypi: []}`, or it gets the web link instead of buttons.
  - channel-slack's own fixtures (`turn.test.ts:234-243`, `turn-registry.test.ts:270`, `plugin.test.ts:1017`) already carry both. Any expected subject derived from them now includes the reach.

**Interfaces:**
- Produces:
  - `export interface SkillReach { readonly hosts: readonly string[]; readonly downloads: boolean }` in turn-registry.ts. copy.ts and permission-prompts.ts import it as a type.
  - `PermissionIn` skill: `{kind:'skill'; skillId; description; needsKey; reach: SkillReach | null}`.
  - `COPY.skillSubject(skillId: string, description: string, reach?: SkillReach): string`. With `reach` omitted, or empty hosts and `downloads:false`, it is unchanged.
  - `skillPromptFor`: signature unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `copy.test.ts`, new test `'a skill prompt names what it reaches right after the skill, before the description (TASK-1135)'`. Exact strings:
    - `('walk-weather-report','Gets the current weather for a city.',{hosts:['api.open-meteo.com'],downloads:false})` → `'Wants to start using the walk-weather-report skill, which needs to reach api.open-meteo.com. Gets the current weather for a city.'`
    - `('gmail','',{hosts:['gmail.googleapis.com','oauth2.googleapis.com'],downloads:false})` → `'Wants to start using the gmail skill, which needs to reach gmail.googleapis.com and oauth2.googleapis.com.'`
    - `('x','Does x.',{hosts:['a.example','b.example','c.example'],downloads:true})` → `'Wants to start using the x skill, which needs to reach a.example, b.example and c.example, and it will download some extra software from the internet. Does x.'`
    - `('pdf-tools','Works with PDFs.',{hosts:[],downloads:true})` → `'Wants to start using the pdf-tools skill, which will download some extra software from the internet. Works with PDFs.'`
    - `('gmail','X',{hosts:[],downloads:false})` equals `COPY.skillSubject('gmail','X')`.
  - `copy.test.ts`, the sample table at :38: add `['gmail','Reads and sends email from your Gmail account.',{hosts:['gmail.googleapis.com'],downloads:true}]`, so the no-ping and no-broadcast invariants cover it.
  - `turn-registry.test.ts`, new test `"a skill card's reach: its hosts and whether it downloads; null (card kept) when hosts or packages isn't the broker's shape"`.
    - `{hosts:['api.open-meteo.com'], packages:{npm:[],pypi:[]}}` → `{hosts:['api.open-meteo.com'], downloads:false}`.
    - `npm:['left-pad']` → `downloads:true`.
    - Each of these gives `reach:null` and the card still reaches the sink: `hosts` absent, `'x'` or `[1]`; `packages` absent, `{npm:[]}` (no `pypi`), or `'x'`.
    - Update the existing expected objects at :308 and :342 to include `reach`.
  - `permission-prompts.test.ts`, `describe('skillPromptFor…')`. Give the `card()` helper a default `reach: {hosts: [], downloads: false}` so existing expectations hold, then add:
    - `'names every host before the description, with Allow and Deny'`. `reach {hosts:['api.open-meteo.com'],downloads:false}` → `{kind:'buttons', subjectText:'Wants to start using the gmail-sender skill, which needs to reach api.open-meteo.com. Reads and sends email from your Gmail account.'}`.
    - `"a reach it can't read, a host the egress proxy would refuse, or a reach the subject can't hold whole: the web link, never buttons"`. Each of these is `kind:'web'`:
      - `reach:null`
      - hosts `['API.example.com']`, `['*.example.com']` or `['a.example <!here>']`
      - 30 hosts of the form `` `${'a'.repeat(50)}-${i}.example` ``
      - skillId `'x<!here>'` with one valid host
    - `'with the longest id a prompt takes, every host survives the draw'`. Use skillId `'a'.repeat(128)`, hosts that keep the head ≤ 400, and a 240-char description: `kind:'buttons'`, and `cleanPromptSubject(subjectText)` contains every host.
    - `'a card that needs a key still names its reach on the web link'`. `needsKey:true` with a valid reach gives `kind:'web'` and a `subjectText` that contains the host.
  - `turn.test.ts`.
    - Set `SUBJECT` (:998) and the other card-derived subjects (:1119, :1153) to `COPY.skillSubject(id, desc, {hosts:['gmail.googleapis.com'], downloads:false})`, matching the fixture at :234-243.
    - Add `hosts?` to that fixture.
    - New test `'the prompt names the host the skill reaches (TASK-1135)'`. With hosts `['api.open-meteo.com']`, `subjects(calls)[0]` equals `cleanPromptSubject(COPY.skillSubject('gmail-sender', DESCRIPTION, {hosts:['api.open-meteo.com'], downloads:false}))`.
- [ ] **Step 2: Run `pnpm --filter @ax/channel-slack test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **turn-registry.** `reachOf(hosts, packages)` returns null unless `hosts` is an array of strings and `packages` is a record whose `npm` and `pypi` are arrays. `downloads` is `npm.length + pypi.length > 0`. A null reach keeps the card.
  - **copy.**
    - Clauses:
      - `which needs to reach ${list}`
      - `which will download some extra software from the internet`
      - both: `which needs to reach ${list}, and it will download some extra software from the internet`
    - List: `a` / `a and b` / `a, b and c`.
    - Assembly: `${lead}, ${clause}.`, or `${lead}, ${clause}. ${description}`. The existing blank-description test (`cleanPromptSubject(description) === ''`) still decides.
    - Update the COPY doc block (141-157) to say the reach comes before the description so the cap can only cut the description.
  - **permission-prompts.** Add a private `nameableReach(p): SkillReach | null`, which returns:
    - null for `p.reach === null`
    - the reach itself when it has no hosts and no downloads
    - null when any host fails `HOST_RE`
    - null unless `cleanPromptSubject(head) === head`, with `head = COPY.skillSubject(p.skillId, '', reach)`
    
    `skillPromptFor` builds `subjectText` with `nameableReach(p) ?? undefined` and returns `web` when it is null, or for the existing reasons.
  - **Comments.**
    - Rewrite `permission-prompts.ts:52-64`: the card now comes in the turn itself, the subject names the reach, and the web is used when it can't.
    - Update `turn.ts:78-79,857-858` and the `PROMPT_SUBJECT_MAX` comment.
- [ ] **Step 4: Run `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build && pnpm --filter @ax/preset-k8s test -- channel-slack-composition`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: composition canary, one prompt naming its host `[tier: integration]`

**Files:**
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`. Add a new `it` after the skill test (~1585).

**Interfaces:**
- Consumes: Tasks 1, 2 and 4 (real tool-policy, decisions and channel-slack in `KEEP`). The broker isn't in `KEEP`, so the script fires its card the way the broker does.

- [ ] **Step 1: Write the test** `"a skill that reaches a connector: a member's request isn't held, its card is the one prompt and names the host, and Allow attaches it; an outsider's is still held for the owner's Today (TASK-1135)"`.
  - The `invokeScript` fires `tool:pre-call` with `{id, name:'request_capability', input:{skillId:'walk-weather-report'}}` and records the verdict. Then:
    - **Not a hold:** a text chunk, then `chat:permission-request` with `{kind:'skill', skillId:'walk-weather-report', description:'Gets the current weather for a city.', hosts:['api.open-meteo.com'], slots:[], packages:{npm:[],pypi:[]}}`.
    - **A hold:** the held `tool-result` chunk.
    - Either way, `chat:turn-end`.
  - **Mel (attended).**
    - The verdict is not a hold, and `listDecisions('usr_mel')` is `[]`.
    - `promptsIn(calls)` has length 1, its blocks' JSON contains `'api.open-meteo.com'`, and `sentText(calls)` doesn't contain `'I need your OK'`.
    - Mel's Allow → `grantCalls` has exactly one entry with `skillId:'walk-weather-report'` as `usr_mel`.
  - **Carol (outsider).**
    - The verdict is a hold, and `listDecisions('usr_ada')` has one pending row with `ruleId:'skills.request-capability'`.
    - No prompt is posted for her turn.
- [ ] **Step 2: Run `pnpm --filter @ax/preset-k8s test -- channel-slack-composition`.** Expected: PASS.
  - Vacuity check, once: temporarily change Task 2's condition to `false` and run again. Expected: this test FAILS on Mel's verdict. Then restore the condition. Never use `git stash`.
- [ ] **Step 3: Commit.**

### Task 6: docs, changeset, memory `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`.
  - :501-503: the skill card now comes in the turn itself; tool-policy holds `request_capability` only when nobody is there.
  - :695-698: replace the gap "A skill prompt shows only the id and description…" with what's shown now (hosts, a download sentence, and the web link when the reach can't be named whole).
  - Add a known gap: an outsider's skill request still asks the owner twice in Today (the held call, then the card after replay).
- Create: `.changeset/one-skill-prompt.md`. `patch` for `@ax/tool-policy`, `@ax/decisions`, `@ax/skill-broker` and `@ax/channel-slack`, written in the project voice. Format example: `.changeset/slack-permission-buttons.md`.
- Create: `.claude/memory/context/2026-11-18-TASK-1135.md`. One row for the new behaviour (attended `request_capability` runs and its card is the one question; log `decision_hold_skipped_attended`). One row CORRECTING `context.md:63`: conversations has persisted permission cards since TASK-66, and only Today's buffer is in memory. Write shards only; never edit the root archives.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Expected: green, except known-unrelated `@ax/auth-better` Docker teardown noise, which you should note and not skip.
- [ ] **Step 3: Commit.**

---

## Manual acceptance (kind) — the card's "Done when"

**Before any check.**
- Rebuild the kind host image (`make image`, then roll the host). No runner image is needed.
- Confirm that the image's compiled `@ax/decisions` dist contains `decision_hold_skipped_attended` (Docker layer caching has hidden fixes before).
- Confirm that `walk-weather-report` is still in the catalog with its open-meteo connector (TASK-1134).

1. **Web (the builder can run this; k8s-acceptance-loop).**
   - In a web chat, ask: "Use the walk-weather-report skill to get today's weather in Paris."
   - Expect: no ApprovalCard ("Wants to gain access to a new service or key"), one grant row reading "To do this, it needs to reach: api.open-meteo.com", and no held `web_extract` card in that turn.
   - The host log has `decision_hold_skipped_attended {tool:'request_capability'}`.
   - Connect attaches the skill.
2. **Slack (needs a person in the Slack client).** If the builder can't run it, file it as a follow-up `(walk)` card.
   - DM your personal agent the same request.
   - Expect exactly one card: "Wants to start using the walk-weather-report skill, which needs to reach api.open-meteo.com. …", with Allow and Deny, and no "I need your OK before I can do part of this." line.
   - Allow → "Connected. Send your message again and I'll use it."
   - Resend: the skill is attached.
3. **Outsider (optional).** An outsider's same request in a connected channel still says the owner was asked, and a pending row waits in the owner's Today.

**Automated substitute:** Task 5 (real decisions, tool-policy and channel-slack over Postgres; fake Slack API), Task 2's canary (real rule table, all four turn kinds), and Task 3's pinned model-facing text. No CI test can show that the model ends its turn after the message. Step 1 above or the Slack walk is that check.
