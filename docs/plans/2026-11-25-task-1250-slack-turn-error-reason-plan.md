# TASK-1250: Slack says why a turn failed, in the web's words — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed Slack turn ends with the same sentence the web app shows for its reason code, with the host's detail line under it as inert text, instead of "Something went wrong" for everything.

**Architecture:** The reason→sentence table moves out of channel-web into a new import-free `@ax/core/turn-error-text` subpath that both channels import (channel-web re-exports it). channel-slack reads `reason` and `detail` off `chat:turn-error`, picks the shared sentence (or its own wording for the three reasons whose web sentence points at a web-only screen), defuses the detail for Markdown, and keeps the detail whichever of `chat:turn-error` and the terminated `agent:invoke` outcome arrives first.

**Tech Stack:** TypeScript, pnpm monorepo, vitest (fake timers for the wait), Slack `markdown_text` replies.

**Spec:** board card TASK-1250 (Vinay's 11-25 decision: one shared table, Slack wording layered on top) plus the Design section below. Every decision with its alternatives: `.claude/memory/decisions/2026-11-25-TASK-1250.md`.

## Design

### What happens today (read at e132ea17d)

- The host fires `chat:turn-error {reqId, reason, detail?}` (`chat-orchestrator/src/orchestrator.ts:2189-2236`). On an outsider's turn it withholds `detail` and keeps `reason` to a host code (`outsiderReason`, TASK-1091).
- channel-slack drops both: `turn-registry.ts:282-285` calls `sink.error()` with nothing; `turn.ts:783` decides `{reason: 'turn-error'}`; `turn.ts:854-863` keeps a terminated outcome's code for the log only; `reply-stream.ts:616` pushes `COPY.turnFailed` for every `error`.
- The table lives in `channel-web/src/lib/turn-error-labels.ts`, where invariant 2 keeps channel-slack from importing it.

### Decisions (alternatives in the shard)

1. **Shared home: a new import-free `@ax/core/turn-error-text` subpath.** Same move TASK-753 made for `@ax/core/humanize` (channel-web's lib file became a re-export) and TASK-782 for `@ax/core/error-codes`. channel-slack depends only on `@ax/core`; a file that imports nothing bundles into the SPA without the hook bus. Not `@ax/ipc-protocol`: channel-slack doesn't depend on it, it is the host↔runner wire, and TASK-782 rejected it for the same reason.
2. **Wording unchanged, byte for byte.** channel-web keeps `lib/turn-error-labels.ts` as a re-export plus its two web-only helpers; its turn-error tests are not edited. The table is frozen (two plugins in one process share it). A new guarded lookup `turnErrorLabel` is the one place the prototype guard lives.
3. **Slack's own wording for three live reasons only** (exact copy in Task 3): `agent-model-provider-unknown` ("…in Settings"), `connector-needs-reconnect` and `connectors-need-reconnect` ("Open Connectors…"). Each keeps the web's first sentence word for word. "Open Connectors" becomes a link to `<origin>/workspace/agents/<id>/settings/connectors`, the page the web's own button opens (`AgentView.tsx` `openSettings('connectors')`). Not overridden: "Retry" (a verb; the web's button says "Resend"), and the replay-only or routine-only reasons (`chat:start:storage-full`, `connector-needs-sign-in`, `provider-key-missing-connector-needs-sign-in`, `system-prompt:brief-*`), which can't reach a live Slack turn.
4. **An outsider's (`external`) turn gets a reason's sentence only when it is true for them.** Seven reasons qualify (Task 3's `OUTSIDER_TURN_ERRORS`). The rest speak to the account the turn runs as ("You've reached your daily usage limit", "needs you to sign in again") and keep `COPY.turnFailed`. Allowlist, so a new reason fails closed. Precedent: TASK-1091 tells an outsider only "Some tools aren't available…", never the owner's connector wording. Detail visibility stays the host's call: Slack shows whatever `detail` arrives.
5. **The detail is defused for Markdown by a new `cleanDetailLine`** (Task 2), not by `neutralizeSlackControls` alone. That one marks `<` only before `!`, `@`, `#`, `&`, so `<http://evil|Sign in>` and `[Sign in](https://evil)` pass through it, and replies are `markdown_text`. Connector names are admin/user-authored; a dev-service path comes from sidecar log output. Bare URLs stay clickable: they show their own target (the model-text policy).
6. **The order race** (next section): the turn-error decides with its reason and detail; a non-busy terminated outcome that comes first waits up to `TURN_ERROR_WAIT_MS` (5 s) for it.
7. **Only the turn's reply changes.** The nine `COPY.turnFailed` sites in `router.ts` (:421, :429, :528, :634, :728, :796, :917, :941, :1011) are the router's own failures before or instead of a turn, with no reason code; they stay. `COPY.busy`, Slack's own 30-minute cap and a thrown invoke keep their lines. `slack_turn_failed` log fields are unchanged.

### The order race, as the orchestrator does it

- The two exits that carry a detail, `orchestrator.ts:5707` (proxy open, connector names) and `:5952` (sandbox open, `dev-service-failed`), `await fireTurnError(…, detail)` and `chat:end` before `return outcome`. Their turn-error always reaches Slack first.
- One exit reverses it: F2b, `onChatEnd` (`:6199-6228`). It resolves the waiter, then fires a bounded `chat:turn-error`, so Slack's subscriber can run after Slack's invoke continuation (the ax-conventions "fire that races its caller" trap). It carries no detail and the same reason.
- `conversation:busy` fires no turn-error at all.
- Warm/routed DMs still call `agent:invoke` and follow the same rules. A woken continuation (`followContinuation`) has no invoke: its turn-error is its only failure signal, so no wait applies.
- **Slack's rule:** first decision wins, as today. The turn-error decides with `{reason, detail}`. A non-busy terminated outcome that arrives before it does not decide; it waits up to `TURN_ERROR_WAIT_MS` for the turn's own turn-error, then ends with the outcome's code (sentence, no detail). A turn-end during the wait ends it at once, still as an error. When the turn-error already decided, no wait is armed, so the usual order adds no latency.

### Non-goals

- No hook, payload, manifest, IPC or capability change, so **no boundary review**. Say so in the PR.
- channel-slack `plugin.ts:319` and `:353` manifest strings still say "15-minute cap" (pinned by `plugin.test.ts`; the cap is 30 minutes since #1255). Suggested follow-up, not this PR.
- Accepted per the card: on an attended channel turn the detail is posted in the channel thread, readable by everyone in the channel.
- Accepted: on a member's turn the F2b reason can be a runner's own text, so a compromised runner can choose which authored sentence Slack shows (the web has the same property). It is never printed; only looked up.

### Security

`security-checklist` is **required**: untrusted text (a sidecar's log path, admin/user-authored connector names, a runner-chosen reason) now reaches a Slack Markdown message, and what outsiders are told changes. No new dependency.

## Global Constraints

- `pnpm --filter <pkg> test` puts the filter **before** the script. After Task 1, build `@ax/core` before running channel-web or channel-slack tests: vitest resolves `@ax/core/turn-error-text` through `dist/` (`Failed to resolve import "@ax/core/turn-error-text"` means "build core"). Run `pnpm build` (tsc) alongside vitest.
- Full gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm lint`. Locally `@ax/auth-better`'s Docker teardown may time out with every assertion passing; read past it.
- `packages/core/src/turn-error-text.ts` imports nothing and re-exports nothing. channel-web and channel-slack import the table only from `@ax/core/turn-error-text`, never from each other.
- Every web sentence stays byte for byte (typographic `’` and `—` included). These four files are not edited: `channel-web/src/lib/__tests__/turn-error-labels.test.ts`, `lib/__tests__/workspace-api-stream-error.test.ts`, `components/workspace/__tests__/AgentConversationError.test.tsx`, `components/workspace/__tests__/AgentView.test.tsx`.
- Slack's own words live in `copy.ts`. channel-slack sources spell the zero-width space as the escape `\u200B`, never the character (`source-hygiene.test.ts`).
- The reason code is never printed anywhere a person reads; it is only looked up.
- Commit subjects start `[TASK-1250]`. Memory rows go in the shard, never a root archive.

## Review Focus

1. **A member's turn-error whose `reason` is the runner's own text** (F2b; any characters, up to 4096): the generic line, the text never shown. Pinned in Task 3 (it.each) and router.test's existing runner-text case (Task 4).
2. **A connector named like a link or a mention** (`[Sign in again](https://evil.example)`, `<http://evil.example|Sign in>`, `<!channel>`): shown as typed, opens nothing, pings nobody. Pinned in Task 2 and Task 4 test 4.
3. **A reason that is an `Object.prototype` key** (`toString`, `__proto__`, `constructor`): the generic line, never `function Object()…`. Pinned in Task 1 and Task 3.
4. **An outsider whose turn fails on the owner's usage limit or a dead sign-in:** the generic line, never "You've reached…" or "needs you to sign in again". Pinned in Task 3 and Task 4 test 6.
5. **A terminated outcome whose turn-error never comes, or a turn-end instead:** the reply still ends as an error within `TURN_ERROR_WAIT_MS`, no sink, lane or timer left behind. Pinned in Task 4 tests 9 and 10 and the router "nothing left behind" split.

## File map

| File | Change | Task |
|---|---|---|
| `packages/core/src/turn-error-text.ts` (new) | the table, `turnErrorLabel`, `turnErrorText`, `MAX_DETAIL_CHARS` | 1 |
| `packages/core/package.json` | `exports["./turn-error-text"]` | 1 |
| `packages/core/src/__tests__/turn-error-text.test.ts` (new) | imports-nothing, guard, frozen | 1 |
| `packages/channel-web/src/lib/turn-error-labels.ts` | re-export + web-only helpers; new header | 1 |
| `packages/channel-web/src/lib/__tests__/turn-error-labels-shared.test.ts` (new) | identity with core | 1 |
| `channel-web/src/lib/workspace-api.ts:76,2420`, `lib/workspace-types.ts:777`, `server/routes-workspace.ts:324-328,3996`, `chat-orchestrator/src/orchestrator.ts:3954-3955` | comments; one import | 1 |
| `packages/channel-slack/src/format.ts` | `cleanDetailLine` | 2 |
| `packages/channel-slack/src/__tests__/format.test.ts` | its tests | 2 |
| `packages/channel-slack/src/copy.ts` | header :4-7; three `turnError*` lines after `turnFailed` (:88) | 3 |
| `packages/channel-slack/src/turn-error-line.ts` (new) | `turnFailureLine`, `SLACK_TURN_ERRORS`, `OUTSIDER_TURN_ERRORS` | 3 |
| `packages/channel-slack/src/turn-registry.ts` | `TurnErrorIn` type (3); `error(e)`, narrowing, header (4) | 3, 4 |
| `packages/channel-slack/src/__tests__/{turn-error-line,copy}.test.ts` | tests | 3 |
| `packages/channel-slack/src/limits.ts` | `TURN_ERROR_WAIT_MS` after `TURN_END_GRACE_MS` (:224) | 4 |
| `packages/channel-slack/src/reply-stream.ts` | `finish(outcome, failLine?)`; header :62-67 | 4 |
| `packages/channel-slack/src/turn.ts` | sink, wait, failure line, connectors link; header :100-107 | 4 |
| `docs/plans/2026-11-09-channel-slack-design.md:1267-1275,1302` | turn end, failure line, 30-minute cap | 4 |
| `packages/channel-slack/src/__tests__/{turn-registry,reply-stream,turn,router}.test.ts` | tests | 4 |
| `.changeset/slack-turn-error-reason.md` | release note | 5 |

Order: 1 → 2 → 3 → 4 → 5.

---

### Task 1: The table moves to `@ax/core/turn-error-text` [tier: integration]

**Files:**
- Create: `packages/core/src/turn-error-text.ts`, `packages/core/src/__tests__/turn-error-text.test.ts`
- Modify: `packages/core/package.json` (`exports`, next to `./error-codes`)
- Modify: `packages/channel-web/src/lib/turn-error-labels.ts`
- Create: `packages/channel-web/src/lib/__tests__/turn-error-labels-shared.test.ts`
- Modify (comments, one import): `packages/channel-web/src/lib/workspace-api.ts:76` and `:2420`; `packages/channel-web/src/lib/workspace-types.ts:777-779`; `packages/channel-web/src/server/routes-workspace.ts:324-328` and `:3996`; `packages/chat-orchestrator/src/orchestrator.ts:3954-3955`

**Interfaces:**
- Produces (`@ax/core/turn-error-text`; the file imports nothing):
  - `export const DEFAULT_TURN_ERROR: string` (unchanged value)
  - `export const ERROR_LABELS: Readonly<Record<string, string>>` (`Object.freeze`d; the same 18 entries, same bytes)
  - `export const MAX_DETAIL_CHARS = 400`
  - `export function turnErrorLabel(reason: string): string | undefined`: the table's own sentence, or `undefined` (never an inherited member)
  - `export function turnErrorText(reason: string, detail?: string | null): string`: unchanged behaviour, now `turnErrorLabel(reason) ?? DEFAULT_TURN_ERROR` plus the clamped detail line

- [ ] **Step 1: Write the failing tests**

`packages/core/src/__tests__/turn-error-text.test.ts`:

```ts
// 'imports nothing, so the channel-web SPA can bundle it': copy error-codes.test.ts:19-26, reading '../turn-error-text.ts'
it('turnErrorLabel answers a known reason with its sentence', () => {
  expect(turnErrorLabel('dev-service-failed')).toBe('A dev service failed to start.');
});
it.each(['sandbox-terminated', '', 'toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
  'turnErrorLabel(%j) is undefined, never an inherited member',
  (reason) => expect(turnErrorLabel(reason)).toBeUndefined(),
);
it('turnErrorText still falls back to the default and puts the detail under the sentence', () => {
  expect(turnErrorText('sandbox-terminated')).toBe(DEFAULT_TURN_ERROR);
  expect(turnErrorText('dev-service-failed', 'svc down')).toBe('A dev service failed to start.\nsvc down');
});
it('the table can’t be changed by either plugin that shares it', () => {
  expect(Object.isFrozen(ERROR_LABELS)).toBe(true);
});
```

`packages/channel-web/src/lib/__tests__/turn-error-labels-shared.test.ts`:

```ts
import * as shared from '@ax/core/turn-error-text';
import * as web from '../turn-error-labels';
it('re-exports the shared table and function, not copies (TASK-1250)', () => {
  expect(web.ERROR_LABELS).toBe(shared.ERROR_LABELS);
  expect(web.turnErrorText).toBe(shared.turnErrorText);
  expect(web.DEFAULT_TURN_ERROR).toBe(shared.DEFAULT_TURN_ERROR);
  expect(web.MAX_DETAIL_CHARS).toBe(shared.MAX_DETAIL_CHARS);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/core test -- turn-error-text`
Expected: FAIL, `../turn-error-text.js` not found. (The channel-web test can't resolve the subpath yet.)

- [ ] **Step 3: Create `packages/core/src/turn-error-text.ts`**

- Move `turn-error-labels.ts:34-162` (`DEFAULT_TURN_ERROR`, `ERROR_LABELS` with every per-code comment) and `:218-261` (`MAX_DETAIL_CHARS`, `turnErrorText` with its prototype comment) verbatim. The prototype comment moves onto `turnErrorLabel`, whose body is today's two lines (`const found: unknown = ERROR_LABELS[reason]; return typeof found === 'string' ? found : undefined`).
- Wrap the literal in `Object.freeze(...)` and type it `Readonly<Record<string, string>>`.
- New file header, covering:
  - the one table (invariant 4) for every surface that turns a turn-error reason into words: channel-web's live strip and reloaded row, and channel-slack's failed-turn reply;
  - why `@ax/core` (every plugin depends on it; this file imports nothing, so the SPA bundles it without the hook bus);
  - Slack layers its own wording only for reasons whose sentence points at a web-only screen (channel-slack `copy.ts`);
  - `detail` is untrusted, and each surface renders it as inert text;
  - its history: Fault A `transport.ts`, then channel-web `lib/turn-error-labels.ts` (TASK-372), then here (TASK-1250).
- Rewrite `MAX_DETAIL_CHARS`'s doc for both surfaces. Drop the stale "Kept client-side so wording/i18n is one place" (`:38`).
- Add to `package.json` `exports`: `"./turn-error-text": { "types": "./dist/turn-error-text.d.ts", "default": "./dist/turn-error-text.js" }`.

- [ ] **Step 4: Rewrite `packages/channel-web/src/lib/turn-error-labels.ts`**

- It keeps `CONNECTORS_TAB_REASONS`, `turnErrorOpensConnectors` and `turnErrorMessageNotSaved` unchanged.
- It replaces the moved code with `export { DEFAULT_TURN_ERROR, ERROR_LABELS, MAX_DETAIL_CHARS, turnErrorText } from '@ax/core/turn-error-text';`.
- New header, modelled on `lib/humanize.ts`: the table lives in `@ax/core/turn-error-text` (TASK-1250) so Slack says the same thing; this file re-exports it beside the web-only helpers; its two readers are unchanged. The stale claim at `:5-7` ("Every surface that renders a turn failure goes through `turnErrorText`") goes. That claim is the line that made Slack's own generic line look fine.

- [ ] **Step 5: Point the comments at the new home**

- `workspace-api.ts:76`: "The table lives in `@ax/core/turn-error-text` (shared with Slack since TASK-1250); `./turn-error-labels` re-exports it beside the web-only helpers."
- `workspace-api.ts:2420`: "(that table now lives in `@ax/core/turn-error-text`, see the import note above)".
- `workspace-types.ts:777`: "`turnErrorText` (`@ax/core/turn-error-text`) owns the wording…".
- `routes-workspace.ts:3996`: "the wording is `turnErrorText`'s job (`@ax/core/turn-error-text`) on both paths".
- `routes-workspace.ts:328`: import `MAX_DETAIL_CHARS` from `'@ax/core/turn-error-text'`. The comment at `:324-327` becomes: "imported from the shared, import-free table so the host, the browser and Slack can't drift about where that line ends (invariant 4)".
- `orchestrator.ts:3954-3955`: "The reason is read by routines (`refusedBeforeAssembly`) and by the shared sentences in `@ax/core/turn-error-text` (channel-web, channel-slack)".

- [ ] **Step 6: Verify**

Run:

```bash
pnpm --filter @ax/core build && pnpm --filter @ax/core test
pnpm --filter @ax/channel-web test -- turn-error workspace-api-stream-error AgentConversationError AgentView
pnpm --filter @ax/channel-web build && pnpm --filter @ax/chat-orchestrator build
git diff --stat -- packages/channel-web/src/lib/__tests__/turn-error-labels.test.ts packages/channel-web/src/lib/__tests__/workspace-api-stream-error.test.ts packages/channel-web/src/components/workspace/__tests__/AgentConversationError.test.tsx packages/channel-web/src/components/workspace/__tests__/AgentView.test.tsx
```

Expected:
- Everything passes.
- channel-web's build runs `vite build`, which proves the SPA bundles the subpath.
- The `git diff --stat` prints nothing.

- [ ] **Step 7: Commit** `[TASK-1250] Turn-error sentences move to @ax/core/turn-error-text, shared by the web and Slack`

---

### Task 2: A failed turn's detail, fit for a Slack Markdown reply [tier: sensitive]

**Files:**
- Modify: `packages/channel-slack/src/format.ts` (export after `cleanPromptSubject`, ~:175)
- Test: `packages/channel-slack/src/__tests__/format.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `MAX_DETAIL_CHARS` (Task 1, `@ax/core/turn-error-text`); `clampCodeUnits` (`@ax/core`); `replaceSurfaceRewriters` (`@ax/core/surface-text`).
- Produces: `export function cleanDetailLine(raw: string): string`. Returns `''` when nothing printable is left. Otherwise returns `'\u200B' + line`, where `line` is one line of at most `MAX_DETAIL_CHARS` visible code units, every `<` and every `](` is followed by `\u200B`, and `neutralizeSlackControls` has run on it.

The order is the algorithm. Each step matters, so the cap is the web's and every mark is judged on the final text:

```
clampCodeUnits(raw, MAX_DETAIL_CHARS)
→ replaceSurfaceRewriters(·).replace(/\s+/g, ' ').trim()      // '' → return ''
→ .replace(/</g, '<\u200B').replace(/\]\(/g, ']\u200B(')       // no Slack token, autolink, HTML or Markdown link/image can form
→ neutralizeSlackControls(·)                                    // broadcast words, entity references
→ '\u200B' + ·                                                  // no Markdown block (heading, quote, list, setext rule) can start the line
```

- [ ] **Step 1: Write the failing tests**

```ts
const ZWSP = '\u200B';
const DIAG = "Dev service 'kafka' couldn't write /var/lib/kafka (read-only filesystem) — add /var/lib/kafka to the service's writablePaths.";
describe('cleanDetailLine: a failed turn’s detail, fit for a Markdown reply (TASK-1250)', () => {
  it('passes a host diagnosis through as written, behind one leading mark', () => {
    expect(cleanDetailLine(DIAG)).toBe(ZWSP + DIAG);
  });
  it.each([
    '<!channel> look here', 'Connector: <@U07BOB0001>', 'Connector: <#C07SUPPORT|general>',
    'Connector: <http://evil.example|Sign in again>', 'Connector: <https://evil.example>',
    'Connector: [Sign in again](https://evil.example)', 'Connector: ![x](https://evil.example/p.png)',
    'Connector: <img src=x onerror=alert(1)>', 'Connector: @here @channel @everyone',
    'Connector: &lt;!here&gt; &#64;channel',
    "Dev service 'x' couldn't write /<!channel>/[a](//evil.example) (permission denied)",
  ])('%j pings, links and tags nothing, and still reads as written', (raw) => {
    const out = cleanDetailLine(raw);
    expect(out).not.toMatch(/<(?!\u200B)/);
    expect(out).not.toMatch(/\]\(/);
    expect(spellsMention(out)).toBe(false);
    expect(out.split(ZWSP).join('')).toBe(raw);
  });
  it('is one line: controls, bidi and invisible characters become single spaces', () => {
    expect(cleanDetailLine('a\nb\r\n\tc\u2028d\u202Ee\u200Bf')).toBe(`${ZWSP}a b c d e f`);
  });
  it('is clamped to the shared MAX_DETAIL_CHARS, never half an emoji', () => {
    expect(cleanDetailLine('x'.repeat(MAX_DETAIL_CHARS + 50))).toBe(ZWSP + 'x'.repeat(MAX_DETAIL_CHARS));
    expect(cleanDetailLine('x'.repeat(MAX_DETAIL_CHARS - 1) + '\u{1F600}')).toBe(ZWSP + 'x'.repeat(MAX_DETAIL_CHARS - 1));
  });
  it('marks a broadcast word the cap made', () => {
    expect(cleanDetailLine('x'.repeat(MAX_DETAIL_CHARS - 5) + '@heres')).toBe(`${ZWSP}${'x'.repeat(MAX_DETAIL_CHARS - 5)}@${ZWSP}here`);
  });
  it('starts no Markdown block', () => {
    for (const raw of ['# Heading', '> quoted', '---', '1. step']) expect(cleanDetailLine(raw)).toBe(ZWSP + raw);
  });
  it('is empty when nothing printable is left', () => {
    expect(cleanDetailLine(' \u200B\n\u202E ')).toBe('');
  });
  it('the reply’s own neutralizing pass changes nothing in it', () => {
    for (const raw of [DIAG, 'Connector: <!channel> [a](b) @here &lt;']) {
      const out = cleanDetailLine(raw);
      expect(neutralizeSlackControls(out)).toBe(out);
    }
  });
});
```

(`spellsMention` comes from `./lenient-decoder.js`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/channel-slack test -- format`
Expected: FAIL, `cleanDetailLine` is not exported.

- [ ] **Step 3: Implement `cleanDetailLine` in `format.ts`**

Follow the algorithm above. Its doc comment says:
- what the line is: the host's untrusted one-line specifics under a failed turn's sentence;
- why `neutralizeSlackControls` alone isn't enough: it leaves `<http://…|…>` and `[x](y)` live in `markdown_text`;
- that bare URLs stay clickable (they show their own target, as model text does);
- that the leading mark is invisible.

- [ ] **Step 4: Verify** with `pnpm --filter @ax/channel-slack test -- format && pnpm --filter @ax/channel-slack build`. Expected: PASS.

- [ ] **Step 5: Commit** `[TASK-1250] Slack: a failed turn's detail line can't ping, link or format`

---

### Task 3: Slack's failure line — the shared sentence, Slack's own wording, outsiders [tier: sensitive]

**Files:**
- Modify: `packages/channel-slack/src/turn-registry.ts` (type only, next to `StreamChunkIn` :89)
- Modify: `packages/channel-slack/src/copy.ts` (header :4-7; three lines after `turnFailed` :88)
- Create: `packages/channel-slack/src/turn-error-line.ts`
- Test: create `packages/channel-slack/src/__tests__/turn-error-line.test.ts`; modify `packages/channel-slack/src/__tests__/copy.test.ts`

**Interfaces:**
- Consumes: `ERROR_LABELS` and `turnErrorLabel` (Task 1); `cleanDetailLine` (Task 2).
- Produces:
  - `turn-registry.ts`: `export interface TurnErrorIn { reason?: string; detail?: string }`, "a `chat:turn-error` payload as channel-slack reads it: each field present only when a string". `reason` is looked up, never shown. `detail` is untrusted.
  - `copy.ts`: `COPY.turnErrorProvider: string`, `COPY.turnErrorReconnect(connectorsLink: string): string`, `COPY.turnErrorReconnectMany(connectorsLink: string): string`.
  - `turn-error-line.ts`:
    - `export const SLACK_TURN_ERRORS: ReadonlyMap<string, (connectorsLink: string) => string>` (exactly the three reasons above).
    - `export const OUTSIDER_TURN_ERRORS: ReadonlySet<string>` = `chat-run-timeout`, `dev-service-failed`, `agent-model-provider-unknown`, `chat:start:usage-limit-fleet`, `runner-boot-failed`, `system-prompt:identity-unavailable`, `conversation:message-not-saved`.
    - `export function turnFailureLine(error: TurnErrorIn | undefined, mode: TurnMode, connectorsLink: string): string`.
- `turnFailureLine` semantics:
  - **The sentence** is `COPY.turnFailed` when there is no `reason`, or when `mode === 'external'` and the reason is not in `OUTSIDER_TURN_ERRORS`. Otherwise it is `SLACK_TURN_ERRORS.get(reason)?.(connectorsLink) ?? turnErrorLabel(reason) ?? COPY.turnFailed`.
  - **The detail:** when `error.detail` is a string and `cleanDetailLine` of it is non-empty, the result is `${sentence}\n\n${cleaned}`. Otherwise it is the sentence alone.
  - `TurnMode` is a type-only import from `./turn.js`.

Exact copy, placed right after `turnFailed`, behind a comment. The comment says these replace a web sentence that points at a web-app screen, for the reasons a live Slack turn can fail with; each keeps the web's first sentence (copy.test.ts).

```ts
  turnErrorProvider:
    'This agent can’t run right now — the AI service it uses isn’t set up on this server. An admin can fix this in the web app’s Settings.',
  turnErrorReconnect: (connectorsLink: string) =>
    `One of this agent’s connectors needs you to sign in again. [Open Connectors](${connectorsLink}) in the web app, reconnect it, then retry.`,
  turnErrorReconnectMany: (connectorsLink: string) =>
    `Some of this agent’s connectors need you to sign in again. [Open Connectors](${connectorsLink}) in the web app, reconnect each one, then retry.`,
```

copy.ts header (`:4-7`, the stale claim "Nothing else in this package may compose Slack-facing words"): add that a failed turn's sentence is the one exception. It is the web app's own sentence, from `@ax/core/turn-error-text` (TASK-1250), so both surfaces say the same thing about the same failure, and `turn-error-line.ts` picks it. Only the `turnError*` lines here are Slack's words.

- [ ] **Step 1: Write the failing tests**

`turn-error-line.test.ts` (`LINK = 'https://ax.example/workspace/agents/agt_1/settings/connectors'`; `DIAG` as in Task 2):

```ts
const OWN: Record<string, string> = {
  'agent-model-provider-unknown': COPY.turnErrorProvider,
  'connector-needs-reconnect': COPY.turnErrorReconnect(LINK),
  'connectors-need-reconnect': COPY.turnErrorReconnectMany(LINK),
};
it('every reason in the shared table gets its sentence on a member’s turn, Slack’s own where the web’s points at a web app screen', () => {
  const reasons = Object.keys(ERROR_LABELS);
  expect(reasons.length).toBeGreaterThanOrEqual(18);
  for (const mode of ['dm', 'attended'] as const)
    for (const reason of reasons)
      expect(turnFailureLine({ reason }, mode, LINK), `${mode} ${reason}`).toBe(OWN[reason] ?? ERROR_LABELS[reason]);
});
it('Slack’s own wording and the outsider list name only reasons the table has', () => {
  for (const r of [...SLACK_TURN_ERRORS.keys(), ...OUTSIDER_TURN_ERRORS]) expect(Object.keys(ERROR_LABELS)).toContain(r);
  expect([...SLACK_TURN_ERRORS.keys()].sort()).toEqual(Object.keys(OWN).sort());
});
it.each([undefined, {}, { reason: 'sandbox-terminated' }, { reason: 'runner-error' },
  { reason: 'Error: mcpServers entry gmail has invalid transport' }, { reason: 'toString' }, { reason: '__proto__' }, { reason: 'constructor' }])(
  '%j keeps the generic line, never the web’s default',
  (e) => expect(turnFailureLine(e, 'dm', LINK)).toBe(COPY.turnFailed),
);
it('the detail goes under the sentence, cleaned, and under the generic line too', () => {
  expect(turnFailureLine({ reason: 'dev-service-failed', detail: DIAG }, 'dm', LINK))
    .toBe(`${ERROR_LABELS['dev-service-failed']}\n\n${cleanDetailLine(DIAG)}`);
  expect(turnFailureLine({ reason: 'sandbox-terminated', detail: DIAG }, 'dm', LINK))
    .toBe(`${COPY.turnFailed}\n\n${cleanDetailLine(DIAG)}`);
});
it('no detail, or one with nothing printable, says the sentence only', () => {
  for (const e of [{ reason: 'dev-service-failed' }, { reason: 'dev-service-failed', detail: ' \u200B ' }])
    expect(turnFailureLine(e, 'external', LINK)).toBe(ERROR_LABELS['dev-service-failed']);
});
it('an outsider hears a reason’s sentence only when it is true for them', () => {
  expect(OUTSIDER_TURN_ERRORS.size).toBe(7);
  for (const reason of OUTSIDER_TURN_ERRORS)
    expect(turnFailureLine({ reason }, 'external', LINK)).toBe(OWN[reason] ?? ERROR_LABELS[reason]);
  for (const reason of ['chat:start:usage-limit-daily', 'chat:start:usage-limit-rate', 'chat:start:usage-suspended',
    'chat:start:usage-check-unavailable', 'connector-needs-reconnect', 'connectors-need-reconnect']) {
    expect(turnFailureLine({ reason }, 'external', LINK), reason).toBe(COPY.turnFailed);
    expect(turnFailureLine({ reason }, 'dm', LINK), reason).not.toBe(COPY.turnFailed);
  }
});
```

copy.test.ts:
- Add `'turnErrorProvider', 'turnErrorReconnect', 'turnErrorReconnectMany'` to the key list (:79-143).
- Add to `ARGS` `turnErrorReconnect: [[CONNECTORS]], turnErrorReconnectMany: [[CONNECTORS]]`, with `const CONNECTORS = 'https://canopyworks.ai/workspace/agents/agt_123/settings/connectors'`. The link is host-built, like `artifactLink`'s, so it gets no HOSTILE case.
- Add this test:

```ts
it("a failed turn's own lines keep the web's first sentence, and link the agent's Connectors settings where the web has a button", () => {
  const first = (s: string): string => { const i = s.indexOf('. '); expect(i).toBeGreaterThan(20); return s.slice(0, i + 1); };
  expect(COPY.turnErrorProvider.startsWith(first(ERROR_LABELS['agent-model-provider-unknown']!))).toBe(true);
  expect(COPY.turnErrorProvider).not.toBe(ERROR_LABELS['agent-model-provider-unknown']);
  expect(COPY.turnErrorProvider).toContain('the web app');
  expect(COPY.turnErrorReconnect(CONNECTORS).startsWith(first(ERROR_LABELS['connector-needs-reconnect']!))).toBe(true);
  expect(COPY.turnErrorReconnectMany(CONNECTORS).startsWith(first(ERROR_LABELS['connectors-need-reconnect']!))).toBe(true);
  for (const line of [COPY.turnErrorReconnect(CONNECTORS), COPY.turnErrorReconnectMany(CONNECTORS)])
    expect(line).toContain(`[Open Connectors](${CONNECTORS})`);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/channel-slack test -- turn-error-line copy`
Expected: FAIL, the module and the COPY keys are missing.

- [ ] **Step 3: Implement.** Add the type, the COPY lines and header, and `turn-error-line.ts`. Its header says what picks the line, why outsiders get an allowlist (fails closed for a new reason; TASK-1091 precedent), and that the detail's visibility is the host's decision. Use a `Map` and a `Set`, never an object lookup.

- [ ] **Step 4: Verify** with `pnpm --filter @ax/channel-slack test -- turn-error-line copy format && pnpm --filter @ax/channel-slack build`. Expected: PASS.

- [ ] **Step 5: Commit** `[TASK-1250] Slack: the failed turn's line is the web's sentence, Slack's own where the web points at a screen`

---

### Task 4: Wire it through: the reason and detail reach the reply, whichever comes first [tier: sensitive]

**Files:**
- Modify: `packages/channel-slack/src/limits.ts` (after `TURN_END_GRACE_MS`, :218-224)
- Modify: `packages/channel-slack/src/turn-registry.ts`: `TurnSink.error` (:109); `onTurnError` (:282-285); header bullet (:13-15)
- Modify: `packages/channel-slack/src/reply-stream.ts`: `finish` in the interface (:107) and body (:597-638, the push at :616); header (:62-67)
- Modify: `packages/channel-slack/src/turn.ts`: `Decision` (:339-344); sink (:777-785); terminated branch (:854-865); finalization (:880-938); a `connectorsLink` beside `todayLink` (:550); header (:100-107)
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:1267-1275` and `:1302`
- Test: `packages/channel-slack/src/__tests__/turn-registry.test.ts`, `reply-stream.test.ts`, `turn.test.ts`, `router.test.ts`

**Interfaces:**
- Consumes: `turnFailureLine`, `TurnErrorIn` (Task 3).
- Produces:
  - `export const TURN_ERROR_WAIT_MS = 5_000` (doc: after `agent:invoke` reports a terminated turn other than `conversation:busy`, how long the reply waits for that turn's own `chat:turn-error`, which carries the reason's detail, before ending with the outcome's reason alone; the orchestrator fires it before answering on every such exit but one, which races and carries no detail, so this only bounds a turn-error that never comes)
  - `TurnSink.error(e: TurnErrorIn): void`
  - `ReplyStream.finish(outcome: ReplyOutcome, failLine?: string): Promise<void>`: an `error` ends with `failLine`, or `COPY.turnFailed` when it is absent or `''`. It is ignored for `complete` and `busy`.
- turn.ts behaviour:
  - `Decision` gains `turnError?: TurnErrorIn`.
  - Sink: `error: (e) => decide({ outcome: 'error', fail: { reason: 'turn-error' }, turnError: e })`.
  - `let terminated: string | null = null`, with `endTerminated = (code) => ({ outcome: 'error', fail: { reason: 'terminated', code }, turnError: { reason: code } })`.
  - Sink: `end: () => decide(terminated === null ? { outcome: 'complete' } : endTerminated(terminated))`.
  - The terminated branch: busy is unchanged. Otherwise it sets `terminated = code`, and only `if (!decided)` arms `errorWait = d.clock.setTimeout(() => decide(endTerminated(code)), TURN_ERROR_WAIT_MS)`. It does not decide at once.
  - Finalization clears `errorWait`. It calls `stream.finish(outcome, outcome === 'error' ? turnFailureLine(turnError, s.mode, connectorsLink) : undefined)`.
  - `connectorsLink` is `` `${d.publicOrigin}/workspace/agents/${encodeURIComponent(s.agentId)}/settings/connectors` ``, built beside `todayLink`, with a comment: the page channel-web's "Open Connectors" button opens (`workspace-route.ts` `AGENT_SETTINGS_SECTIONS`).
- turn-registry `onTurnError`: on a matched entry, it builds `TurnErrorIn` from the payload's `reason` and `detail`, each copied only when `typeof === 'string'` and nothing else, then calls `safely('error', () => sink.error(e))`.

- [ ] **Step 1: Write the failing tests**

turn-registry.test.ts: "a turn-error hands its sink the reason and the detail, each only when a string, and nothing else". Use `recordingSink({ error: (e) => got.push(e) })`, then:
- `r.onTurnError({ reqId: REQ, reason: 'dev-service-failed', detail: 'Dev service x failed', error: 'raw', extra: 1 })`
- `r.onTurnError({ reqId: REQ, reason: 42, detail: { x: 1 } })`
- expect `got` to equal `[{ reason: 'dev-service-failed', detail: 'Dev service x failed' }, {}]`.

reply-stream.test.ts (give `finishNow` (:197) an optional third `failLine` argument):
- Copy :555 as "finish('error', line) ends the reply with that line, not the generic one". `LINE = 'A dev service failed to start.\n\n\u200BDev service x failed.'`, `delivered(calls)` is `Let me look.\n\n${LINE}`, and the card is marked error as at :564.
- Copy :480 as "a posted reply ends with that line too". Expected `Hello world\n\n${COPY.artifactLink(AGENT_LINK)}\n\n${LINE}`.
- "an empty line falls back to the generic one, and a line means nothing for busy": `finish('error', '')` → `COPY.turnFailed`; `finish('busy', LINE)` → `COPY.busy`.

turn.test.ts:
- Extend `Script` (:167-194). `end` gains `'none'` (nothing fired). Add:
  - `turnError?: Record<string, unknown>`, merged over `{ reqId, reason: 'chat-run-timeout' }`;
  - `outcome?: Record<string, unknown>`, what the invoke returns (default complete);
  - `turnErrorAfterOutcome?: boolean`, which fires the turn-error on `setTimeout(…, 0)` after the invoke has answered (F2b's order).
- Wire them in the fake at :347-352.
- New `describe('runTurn: a failed turn says why (TASK-1250)')` with its own `afterEach(() => vi.useRealTimers())`. Fixtures: `TIMED_OUT = ERROR_LABELS['chat-run-timeout']!`, `SERVICE_FAILED = ERROR_LABELS['dev-service-failed']!`, `DIAG` as in Task 2, `CONNECTORS = 'https://ax.example/workspace/agents/agt_support/settings/connectors'`, and `terminated = (reason: string) => ({ kind: 'terminated', reason })`.

1. "a known reason ends the reply with its sentence": `{ chunks: [{ kind: 'text', text: 'Let me check.' }], end: 'turn-error', outcome: terminated('chat-run-timeout') }`, run `'dm'` → `h.reply()` is `Let me check.\n\n${TIMED_OUT}`.
2. "the orchestrator's order (turn-error, then terminated): dev-service-failed shows its detail": `{ chunks: [], end: 'turn-error', turnError: { reason: 'dev-service-failed', detail: DIAG }, outcome: terminated('dev-service-failed') }` → `${SERVICE_FAILED}\n\n\u200B${DIAG}`.
3. "an unknown reason keeps the generic line": `turnError: { reason: 'sandbox-terminated' }` → `COPY.turnFailed`.
4. "a connector to sign in again: Slack's own line, linking the agent's Connectors settings; a hostile name in the detail pings and links nothing":
   - Input: `turnError: { reason: 'connector-needs-reconnect', detail: 'Connector: <!channel> <@U07BOB0001> <http://evil.example|Sign in again> [Sign in](https://evil.example) @here' }`, run `'dm'`.
   - The reply starts with `COPY.turnErrorReconnect(CONNECTORS)`, and `spellsMention(reply)` is false.
   - The reply doesn't match `/<(?!\u200B)/`, and `reply.split('\n\n').at(-1)` doesn't match `/\]\(/`.
5. "a turn whose detail the host withheld says the sentence only": run `'external'`, `turnError: { reason: 'dev-service-failed' }` → exactly `SERVICE_FAILED`.
6. "an outsider hears the generic line for a reason that speaks to the agent's user": `turnError: { reason: 'chat:start:usage-limit-daily' }` → `'external'` gives `COPY.turnFailed`; `'dm'` gives `ERROR_LABELS['chat:start:usage-limit-daily']`.
7. "terminated first, then its turn-error (F2b's order): the detail is still kept": test 2 plus `turnErrorAfterOutcome: true` → the same reply; the `slack_turn_failed` fields are `{ installId: INSTALL.installId, reason: 'turn-error' }`.
8. "a continuation's turn-error says its reason": update :1854-1863 to expect `Sending.\n\n${TIMED_OUT}` (the log line is unchanged).
9. "terminated and no turn-error ever: the outcome's sentence after TURN_ERROR_WAIT_MS, and nothing left behind":
   - Setup: `vi.useFakeTimers()`; `{ chunks: [], end: 'none', outcome: terminated('dev-service-failed') }`; `const done = h.run('dm')`.
   - `advanceTimersByTimeAsync(TURN_ERROR_WAIT_MS - 1)` → `h.calls()` is `[]`.
   - Advance 1, then 60_000; `await done`.
   - The reply is `SERVICE_FAILED`, and `h.logged('slack_turn_failed')` is `[{ installId: INSTALL.installId, reason: 'terminated', code: 'dev-service-failed' }]`.
   - `h.sinks()` is `0` and `vi.getTimerCount()` is `0`.
10. "a turn-end heard while it waits still ends it as a failure, at once":
    - Setup: `vi.useFakeTimers()`; `{ chunks: [], end: 'none', outcome: terminated('chat-run-timeout') }`; `const done = h.run('dm')`.
    - `advanceTimersByTimeAsync(0)`; `await h.own.end()`; `advanceTimersByTimeAsync(TURN_ERROR_WAIT_MS - 1)`; `await done`.
    - The reply is `TIMED_OUT`. If the end did not decide, `done` never settles and the test times out.

Existing expectations that now say the reason's sentence: turn.test.ts :694, :869 and :1046 (`COPY.turnFailed` → `TIMED_OUT`); router.test.ts :1718-1729, renamed "turn-error → the reason's sentence", expecting `Partial answer\n\n${ERROR_LABELS['chat-run-timeout']}`.

Existing router tests whose terminated outcome has no turn-error now wait `TURN_ERROR_WAIT_MS`. Move them to fake timers, copying "a complete invoke whose turn-end never comes…" (:1849-1862). They become `vi.useFakeTimers()`, dispatch, `await vi.advanceTimersByTimeAsync(TURN_ERROR_WAIT_MS)`, `await vi.advanceTimersByTimeAsync(60_000)`, then the same assertions. Don't call `w.idle()` under fake timers. The sites:
- :1743-1752 (runner text → `COPY.turnFailed`, `code: 'runner-error'`);
- the it.each at :1760-1778;
- "nothing left behind" (:2137-2171): move ending :2143 out of the `endings` loop into its own fake-timer test, "a terminated outcome whose turn-error never comes releases its sink and lane once the wait ends" (`[w.registry.size(), w.queue.size()]` is `[0, 0]`).

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @ax/channel-slack test -- turn-registry reply-stream turn router`
Expected: the new tests FAIL. For example, test 2 gets `COPY.turnFailed`, and `TURN_ERROR_WAIT_MS` is not exported.

- [ ] **Step 3: Implement** the limits constant, the registry narrowing, `finish(outcome, failLine?)` and the turn.ts behaviour above.

- [ ] **Step 4: Update the prose that describes this behaviour**

- turn.ts header :100-107. The reply ends at the first of:
  - its turn-error, whose reason and detail word the last line (turn-error-line.ts);
  - a terminated outcome: `conversation:busy` → busy at once; any other waits up to `TURN_ERROR_WAIT_MS` for its turn-error, then → error with the outcome's reason; a turn-end meanwhile ends it the same way;
  - the rest as it is.
- reply-stream.ts header :62-67: "the failure line (the one `finish` is given: the reason's sentence and its detail; `COPY.turnFailed` when none) or the busy line".
- turn-registry.ts header: `chat:turn-error` hands its sink `reason` and `detail`, each only when a string.
- Design doc :1267-1275:
  - "a `terminated` invoke outcome" → "a `terminated` invoke outcome (`conversation:busy` at once; any other waits up to 5 seconds for the turn's own `chat:turn-error`, which carries the reason's detail: TASK-1250)".
  - "15-minute hard cap" → "30-minute hard cap".
  - Add one sentence: a failed turn's last line is the web app's sentence for its reason (`@ax/core/turn-error-text`), or Slack's own wording where the web's points at a web app screen, with the host's detail line under it as inert text; an outsider hears a reason's sentence only when it is true for them.
- Design doc :1302: "the 15-minute cap's stop" → "the 30-minute cap's stop".

- [ ] **Step 5: Verify**

Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`
Expected: PASS, with the suite no slower than before.

Mutation checks; restore each with `git checkout HEAD -- <file>` and confirm `git status --short` is clean before the next:
- (a) Make the terminated branch decide at once again → test 7 fails (no detail).
- (b) Make `end` decide `complete` during the wait → test 10 fails.
- (c) Drop the every-`<` rule in `cleanDetailLine` → Task 2's `<http://…|…>` row fails.

- [ ] **Step 6: Commit** `[TASK-1250] Slack: a failed turn says why, and keeps the detail whichever event comes first`

---

### Task 5: Changeset, full gate, PR notes [tier: mechanical]

**Files:**
- Create: `.changeset/slack-turn-error-reason.md`

- [ ] **Step 1: Write the changeset**

```md
---
'@ax/core': minor
'@ax/channel-slack': minor
'@ax/channel-web': patch
---

Slack now says why a turn failed, in the same words as the web app: "A dev service failed to start." with which one and why underneath, "The agent timed out.", a usage limit, and so on, instead of "Something went wrong" for everything. Where the web app would point at a button or Settings, Slack links the page instead. The detail line can't ping anyone or sneak in a link, and someone outside the agent's team only hears the reasons that are true for them.
```

- [ ] **Step 2: Run the full gate**

Run: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
Expected: all green; see Global Constraints for the auth-better teardown.

- [ ] **Step 3: Write the PR notes**

- **Security review** (from `security-checklist`). Walk:
  - the detail's sources: a sidecar log path; admin/user-authored connector names;
  - the runner-chosen reason on a member's turn;
  - the outsider allowlist;
  - the attended-channel residual;
  - no new capability or dependency.
- **Boundary review:** no hook-surface change.
- **Not in this PR:** the two "15-minute cap" manifest strings (`plugin.ts:319`, `:353`).

- [ ] **Step 4: Commit** `[TASK-1250] Changeset`

---

## Done-when → tests, and whether each could pass vacuously

| Card's done-when | Pinned by | Fails on today's code? |
|---|---|---|
| each known reason gets its sentence | Task 3 table loop (iterates the live table, length ≥ 18); Task 4 test 1 | Yes (today: always the generic line) |
| `dev-service-failed` shows its detail | Task 4 tests 2, 7 | Yes |
| unknown reason → generic line | Task 3 it.each; Task 4 test 3 | No: today is always generic. It guards the new mapping: a fallback to `DEFAULT_TURN_ERROR`, or a lost `typeof` guard, fails it |
| `<!channel>`, `<@U…>`, `<http://…\|…>` detail defused | Task 2 it.each (+ "reads as written"); Task 4 test 4 | Yes: "reads as written" and test 4 need the detail present; dropping the every-`<` rule fails the link row (mutation c) |
| detail withheld → sentence only | Task 4 test 5 (outsider turn, as in production); Task 3 | Yes |
| the order race never loses the detail | Task 4 tests 2 (turn-error first), 7 (terminated first), 9 (never comes: bounded), 10 (turn-end in the wait) | 7 fails on today's code and under mutation (a); 10 under mutation (b) |
| channel-web's turn-error tests pass, wording unchanged | the four files untouched (`git diff --stat` empty) + Task 1 identity test | The identity test fails on a copy of the table |
