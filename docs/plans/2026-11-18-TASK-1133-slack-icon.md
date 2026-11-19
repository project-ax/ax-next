# TASK-1133: Connect gives the Slack bot a picture Slack accepts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On real Slack, Connect sets the bot's picture, and no `slack_admin_failed {stage:'icon'}` line is logged.

**Architecture:** The admin's browser draws the bot's picture: the branding light logo (or, on a server with no logo and no product name, the AX mark) contained in a 512 px opaque white square, exported as a PNG. Connect sends it as `iconPng` (base64). channel-slack checks it (base64, size cap, PNG signature, square IHDR 512–2000 px) and uploads it to `apps.icon.set` as multipart `file`. The `url` path and the preset's `iconUrl` go.

**Tech Stack:** TypeScript, vitest (jsdom + node), Playwright Chromium (existing channel-web real-browser test pattern), Node 24 global `FormData`/`Blob`, `@ax/channel-slack` (host plugin), `@ax/channel-web` (SPA), `@ax/preset-k8s`.

**Spec:** the card (TASK-1133, from `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:65`), `docs/plans/2026-11-09-channel-slack-design.md` §3 step 3 and §7 row 2. Planner decisions, alternatives and evidence: `.claude/memory/decisions/2026-11-18-TASK-1133.md` (read it first; Task 2 appends its security-checklist row there).

## The problem, from the code (the card's premise is partly wrong)

- **We never upload an image.** `setAppIcon` sends a form `{app_id, url}` (`packages/channel-slack/src/slack-api.ts:510-512`), and the preset sets `url` to `${publicOrigin}/api/branding/logo/light` (`presets/k8s/src/index.ts:1539`). Slack fetches that itself. There is no "multipart shape" to check; the card's wording came from the TASK-1134 report's "The icon upload still fails" (`deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:42`).
- **That URL can't work where we've looked.** With no logo uploaded (every kind walk) the branding route answers 404 (`packages/branding/src/routes.ts`, `getLogo`), and Slack answers `error_bad_format` (measured, `.claude/memory/decisions/2026-11-13-TASK-1093.md` row "Early DM walk on kind"), not the `icon_not_accessible` that `admin-routes.ts:376-388` exempts. On prod the logo is a 517×123 SVG wordmark (builder's read-only GET, 2026-11-18). Slack's page today: `file` (multipart) or `url`; `error_bad_format` "Icon must be a valid image file"; `invalid_icon_size` "between 512x512px and 2000x2000px". Branding accepts PNG/WebP/JPEG/SVG with no size rule (`packages/branding/src/image-validation.ts`), and no hook returns logo bytes (`branding:get` → `{ name }` only).
- **The fix needs a raster square from somewhere, without a new dependency.** channel-web already makes one: `packages/channel-web/src/lib/favicon.ts` draws the same-origin logo into a canvas square (contain) and exports a PNG, "no server-side image library". This plan reuses that approach at 512 px.
- **Only Connect sets the icon.** Rename (`updateSlackApp`, `apps.manifest.update`) and the leftover-app pass (`deleteLeftoverApps`) never call `apps.icon.set`; neither changes here.

## Design (decided; the decisions shard has the alternatives)

- **Which picture** (mirrors `BrandMark.tsx` and the white-label rule, TASK-1093 decisions line 39): a light logo is set → that logo. No light logo and the product name is unset (`(name || 'ax') === 'ax'`, BrandMark's own test) → `src/assets/design/ax-mark-light.svg`. No light logo and a custom name → no picture: nothing is sent, Slack keeps its default, and that is not a failure.
- **How it's drawn:** a 512×512 canvas filled `#ffffff` (the light variant is drawn for light backgrounds, and Slack shows one picture in both of its themes), the image contained (aspect kept, centred) in the 384×384 box inset 64 px, `toDataURL('image/png')`. A PNG over 1 MiB, or any failure (branding read, load, decode, no 2d context, a tainted canvas, 5 s overall), means no picture: Connect goes on without one.
- **Branding is read fresh at Connect** (`fetchBranding()`), not from `useBranding()`: the provider falls back to the default branding when its read fails, which would put the AX mark on a branded server.
- **The wire:** `POST /admin/slack/connect` gains optional `iconPng` (standard base64, with padding, of the PNG). The route's body cap becomes `ADMIN_CONNECT_BODY_MAX_BYTES` (16 KiB + the base64 of 1 MiB); the other admin POSTs keep 16 KiB.
- **The server stays best-effort:** an absent `iconPng` → no Slack call, no log, `iconSet: false`. An unusable one (`parseIconPng` refuses) → never sent, `iconSet: false`, one warn `slack_admin_failed {installId, stage:'icon', code:<refusal>}`. Any Slack or network failure → `iconSet: false` and one warn with its code; the `icon_not_accessible` exemption goes (there's no URL any more). Connect's answer, status and undo don't change.
- **Not changing:** any hook, IPC action or plugin manifest (no boundary review; the connect body is an HTTP admin route channel-web mirrors by shape), Rename, Disconnect, the callback, the Connect form's look and copy, `iconSet` (the UI still ignores it). Existing installs keep Slack's default picture until they're connected again (follow-up, ship-time step 2).

## Global Constraints

- Picture: 512×512 PNG, opaque `#ffffff` background, 64 px inset, contain. Server accepts square, 512–2000 px a side, at most `SLACK_ICON_MAX_BYTES` = 1_048_576 decoded bytes (branding's `MAX_LOGO_BYTES`). The browser mirrors the cap as `SLACK_AVATAR_MAX_BYTES`, each constant's comment naming the other: channel-web never imports channel-slack, and channel-slack never imports branding (invariant 2).
- Log lines stay code-only: `slack_admin_failed` fields are exactly `installId`, `stage`, `code` (the leak test, `admin-routes.test.ts` near `:2500`, allows only `installId`, `reason`, `stage`, `code`). New codes: `icon-not-base64`, `icon-too-large`, `icon-not-png`, `icon-bad-size`. No icon byte or base64 in any log line, error or response.
- The pasted access token goes only to slack.com as `Authorization: Bearer`, through `slack-api.ts`. For multipart, never set `content-type` by hand (fetch writes the boundary).
- Fake tokens come from `fake-slack-tokens.ts` helpers. Before each commit: `git diff --cached | grep -nE 'xox[bpe]-[0-9]{10,13}-'` prints nothing. No literal invisible characters in `packages/channel-slack/src` (`source-hygiene.test.ts`).
- No new dependency. `playwright` and `typescript` are already channel-web devDependencies; `FormData`/`Blob` are Node 24 globals.
- No UI change, so no shadcn work. The canvas `#ffffff` is image content, not a UI colour (say so in a comment). No "AX" in any UI sentence (none is added).
- `--filter` goes before the script. Package `tsc` excludes tests everywhere except channel-web: also run `pnpm --filter @ax/channel-slack build`, `pnpm --filter @ax/channel-web build`, `pnpm --filter @ax/preset-k8s build`.
- Docker-backed tests (`presets/k8s` composition, channel-slack `plugin.test.ts`, `store.test.ts`) need `DOCKER_HOST` per CLAUDE.md. On a loaded host: `--workspace-concurrency=1` and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` (`.claude/memory/mistakes/2026-11-13-TASK-1094.md`).
- After Task 3 and after Task 6: `pnpm -r --no-bail --filter "...@ax/channel-slack" --filter "...@ax/channel-web" run test`. Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Mutation-resistant negatives: each refused fixture must be valid on every OTHER rule (`.claude/memory/mistakes/2026-11-13-TASK-1093.md`, the timestamp row).
- Memory: new rows only in shards for TASK-1133. Never edit a root archive or delete a memory line. GitHub text: `@ax` only inside backticks.

## Review Focus

1. **Prod's logo shape: a wide SVG wordmark served with branding's headers** (`image/svg+xml`, `nosniff`, `default-src 'none'; style-src 'unsafe-inline'; sandbox`) → a 512×512 opaque PNG with the wordmark centred, and the canvas not tainted. Pinned: Task 5 test 1.
2. **An SVG logo with only a `viewBox`** (no width/height; common from design tools) → letterboxed, not stretched to a square. Pinned: Task 5 test 2.
3. **No logo:** unset name → the AX mark; custom name → nothing sent, Connect unaffected, no log line. Pinned: Task 4 tests 2–4; Task 2 test c(ii).
4. **Rendering fails or hangs** (branding read fails or never answers, logo 404, decode error, no canvas) → Connect still goes ahead without a picture, within 5 s. Pinned: Task 4 tests 5–8; Task 6 test 2; Task 5 test 4.
5. **A malformed or oversized `iconPng`** (not a string, URL-safe base64, JPEG bytes, 511/2001 px, not square, over 1 MiB) → never reaches Slack, Connect 200, one warn naming the reason; a maximum-size icon is NOT refused by the old 16 KiB backstop. Pinned: Task 1; Task 2 tests c(iii) and e.

---

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/limits.ts` | icon constants; `ADMIN_CONNECT_BODY_MAX_BYTES`; `ADMIN_BODY_MAX_BYTES` comment `:25` | 1 |
| `packages/channel-slack/src/icon.ts` | new: `parseIconPng` | 1 |
| `packages/channel-slack/src/__tests__/fake-png.ts` | new: PNG header fixtures | 1 |
| `packages/channel-slack/src/__tests__/icon.test.ts` | new | 1 |
| `packages/channel-slack/src/slack-api.ts` | header `:20-32`; `setAppIcon` `:167`, `:510-512`; `Body` `:254-256`; `call()` `:382-393` | 2 |
| `packages/channel-slack/src/admin-routes.ts` | header `:28`, `:42-58`; deps `:124-125`; `setIcon` `:376-388`; `createInstall` `:439-475`; `connect` `:663-684`; `route()` `:834-866`; routes `:870` | 2 |
| `packages/channel-slack/src/plugin.ts` | drop `iconUrl` `:150-151`, `:340` | 2 |
| `presets/k8s/src/index.ts` | comment `:1528-1531`; drop `iconUrl` `:1539` | 2 |
| `packages/channel-slack/src/__tests__/slack-api.test.ts` | `everyMethod` `:143-147`; `FORM_METHODS` `:190-201`; headers test `:230-258`; `:647-660` | 2 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | `ICON_URL` `:31`; `CONNECT_BODY` `:74`; fake `:327`, `:392-394`; `world` `:432`, `:519-527`; tests `:643-646`, `:880-897`, `:1004-1011`, `:1109-1135`, `:1708-1714` | 2 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | fake fetch `:282-291`; connect step `:796-799` | 3 |
| `packages/channel-web/src/lib/slack-avatar-draw.ts` | new, import-free | 4 |
| `packages/channel-web/src/lib/slack-avatar.ts` | new | 4 |
| `packages/channel-web/src/lib/__tests__/slack-avatar.test.ts` | new | 4 |
| `packages/channel-web/src/__tests__/slack-avatar.browser.test.ts` | new, real Chromium | 5 |
| `.github/workflows/ci.yml` | comment `:197-206` only | 5 |
| `packages/channel-web/src/lib/slack-admin.ts` | header `:1-27`; `ConnectSlackInput` `:58-62`; `connectSlack` `:232-241` | 6 |
| `packages/channel-web/src/components/admin/SlackTab.tsx` | `ConnectForm.submit` `:354-375` | 6 |
| `packages/channel-web/src/__tests__/admin-slack.test.tsx` | near `:193-205` | 6 |
| `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx` | mock `:22-31`; Connect tests `:376-385` | 6 |
| `docs/plans/2026-11-09-channel-slack-design.md` | `:250-255`, `:864` | 7 |
| `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:65`, `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:42` | "Found later" notes | 7 |
| `.changeset/slack-bot-picture.md` | new | 7 |
| `.claude/memory/context/2026-11-18-TASK-1133.md` | new shard (CORRECTS rows) | 7 |

---

### Task 1: channel-slack checks an icon before anything sends it `[tier: sensitive]`

Security-checklist scope (run in Task 2, covering this module): this is the trust check on admin-supplied bytes.

**Files:**
- Modify: `packages/channel-slack/src/limits.ts`
- Create: `packages/channel-slack/src/icon.ts`
- Create: `packages/channel-slack/src/__tests__/fake-png.ts`
- Test: `packages/channel-slack/src/__tests__/icon.test.ts`

**Interfaces:**
- Produces (limits.ts): `SLACK_ICON_MAX_BYTES = 1_048_576`, `SLACK_ICON_MIN_PX = 512`, `SLACK_ICON_MAX_PX = 2000`, `ADMIN_CONNECT_BODY_MAX_BYTES = ADMIN_BODY_MAX_BYTES + Math.ceil(SLACK_ICON_MAX_BYTES / 3) * 4` (= 1_414_488).
- Produces (icon.ts):
  ```ts
  export type IconRefusal = 'icon-not-base64' | 'icon-too-large' | 'icon-not-png' | 'icon-bad-size';
  export type ParsedIcon = { ok: true; png: Buffer } | { ok: false; code: IconRefusal };
  export function parseIconPng(value: unknown): ParsedIcon;
  ```
- Produces (fake-png.ts, tests only): `pngHeader(width: number, height: number, totalBytes?: number): Buffer` — the 8-byte PNG signature, an IHDR chunk (length 13, type `IHDR`, width and height big-endian, depth 8, colour type 6, then 0, 0, 0, and a CRC from `zlib.crc32`), an empty IEND chunk, then zero bytes up to `totalBytes`; and `pngBase64(width, height, totalBytes?) = pngHeader(...).toString('base64')`.

- [ ] **Step 1: Write the failing tests** in `icon.test.ts`, `describe('parseIconPng')`:
  1. `'a square PNG 512 to 2000 px a side, up to SLACK_ICON_MAX_BYTES, is accepted with its exact bytes'`: `pngBase64(512, 512)`, `pngBase64(2000, 2000)`, and `pngBase64(512, 512, SLACK_ICON_MAX_BYTES)` each → `{ ok: true }` with `png.equals(pngHeader(...))`.
  2. `'anything but standard padded base64 is icon-not-base64'`: `42`, `null`, `{}`, `''`, and three variants of `pngBase64(512, 512)` (60 characters, no padding: the default header is 45 bytes) that each break ONE rule: its last character dropped (length not a multiple of 4), its first character replaced by `-` (URL-safe alphabet), and one middle character replaced by a newline.
  3. `'more than SLACK_ICON_MAX_BYTES decoded is icon-too-large'`: `pngBase64(512, 512, SLACK_ICON_MAX_BYTES + 1)` (valid base64, a valid 512 header).
  4. `'bytes that are not a PNG are icon-not-png'`, each 64 bytes and valid base64: JPEG magic `ff d8 ff e0` then zeros; the 512 header with type `IHDX`; the 512 header with chunk length 12; the first 23 bytes of the 512 header.
  5. `'a PNG outside 512 to 2000 px, or not square, is icon-bad-size'`: 511×511, 2001×2001, 512×513, 0×0.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test src/__tests__/icon.test.ts`. Expected: FAIL (`icon.ts` missing).
- [ ] **Step 3: Implement `parseIconPng`** in `icon.ts`, checks in this order (each refusal reachable; no separate pre-decode length check, since the route's body cap already bounds the string): not a string, empty, length not a multiple of 4, or not `/^[A-Za-z0-9+/]+={0,2}$/` → `icon-not-base64`; `Buffer.from(value, 'base64')` longer than `SLACK_ICON_MAX_BYTES` → `icon-too-large`; shorter than 24 bytes, not starting with the 8 signature bytes `89 50 4e 47 0d 0a 1a 0a`, `readUInt32BE(8) !== 13`, or bytes 12–15 not `IHDR` → `icon-not-png`; width (`readUInt32BE(16)`) not equal to height (`readUInt32BE(20)`), or outside `SLACK_ICON_MIN_PX..SLACK_ICON_MAX_PX` → `icon-bad-size`. A header comment says: the bytes are only ever forwarded to Slack, never decoded past the IHDR, stored or logged; Slack does the full image check. Add the four constants to `limits.ts` and change the `ADMIN_BODY_MAX_BYTES` comment (`:25`) to say Connect has its own cap, `ADMIN_CONNECT_BODY_MAX_BYTES`, because its body can carry the bot's picture.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 5: Prove the tests bite.** With a clean tree: (1) change the decoded-size comparison from `>` to `>=` → test 1's exactly-the-cap case FAILS; (2) drop the width-equals-height check → test 5's 512×513 case FAILS; (3) drop the `IHDR` type check → test 4's `IHDX` case FAILS. Restore each with `git checkout -- packages/channel-slack/src/icon.ts`.
- [ ] **Step 6: Commit.** Message: `[TASK-1133] channel-slack: check a bot picture before anything sends it`.

---

### Task 2: Connect uploads the checked PNG to Slack; the URL path goes `[tier: sensitive]`

Invoke the `security-checklist` skill for this task (admin-supplied bytes cross into the host; the connect route's body cap grows; the egress body changes). Append its outcome as one row to `.claude/memory/decisions/2026-11-18-TASK-1133.md`.

**Files:**
- Modify: `packages/channel-slack/src/slack-api.ts`, `packages/channel-slack/src/admin-routes.ts`, `packages/channel-slack/src/plugin.ts`, `presets/k8s/src/index.ts`
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts`, `packages/channel-slack/src/__tests__/admin-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseIconPng`, `ParsedIcon`, `ADMIN_CONNECT_BODY_MAX_BYTES`, `SLACK_ICON_MAX_BYTES`; `pngHeader`/`pngBase64`.
- Produces: `SlackApi.setAppIcon(configToken: string, appId: string, png: Uint8Array): Promise<void>`; `POST /admin/slack/connect` body `{ accessToken, refreshToken, botName?, iconPng? }` → `{ installUrl, iconSet }` (unchanged answer); `ChannelSlackConfig` and `AdminRoutesDeps` without `iconUrl`.

- [ ] **Step 1: Write the failing slack-api tests.**
  - `everyMethod` (`:143-147`): `api.setAppIcon(CFG, 'A0APP', PNG)` with `const PNG = pngHeader(512, 512)`.
  - Move `'apps.icon.set'` out of `FORM_METHODS` into `const MULTIPART_METHODS = ['apps.icon.set']`. In `'every method POSTs to …'` (`:230-258`): for a multipart method, `req.init.body` is a `FormData`, there is NO `content-type` header, and the header keys are exactly `['authorization']`.
  - Replace `'deleteApp and setAppIcon send form fields with the config token'` (`:647-660`) with two tests: `'deleteApp sends a form field with the config token'` (its half, unchanged), and `'setAppIcon uploads the PNG as multipart "file" beside "app_id", with the config token and no hand-set content type'`: the form's keys sorted are `['app_id', 'file']`; `form.get('app_id') === 'A0APP'`; the `file` entry is a `File` named `icon.png`, type `image/png`, whose `arrayBuffer()` equals `PNG`; `authorization` is `Bearer ${CFG}`.
- [ ] **Step 2: Write the failing admin-routes tests.**
  - Fixtures: delete `ICON_URL` (`:31`); `const ICON = pngHeader(512, 512)`; `CONNECT_BODY` (`:74`) gains `iconPng: ICON.toString('base64')`, so the existing order assertions (`createApp`, then `setAppIcon`) keep holding. The fake's `setAppIcon` (`:327`, `:392-394`) takes `png: Uint8Array`. `world()` loses its `iconUrl` option (`:432`, `:519-527`).
  - a. `'creates the app with the pasted access token…'` (`:880-897`): the `setAppIcon` call's args are `ACCESS`, `APP.appId`, and bytes equal to `ICON`.
  - b. Route caps (`:643-646`): `POST /admin/slack/connect` has `maxBodyBytes === ADMIN_CONNECT_BODY_MAX_BYTES`; every other POST keeps `ADMIN_BODY_MAX_BYTES`.
  - c. Replace `'icon_not_accessible → iconSet false and no log; …'` (`:1109-1135`) with `'the picture is best-effort: Slack refusing it, none sent, or an unusable one never fails Connect'`, each case → 200, `iconSet: false`, row `pending`:
    - (i) Slack throws `SlackApiError('apps.icon.set', 'error_bad_format')` → `lines` equals exactly one `{ level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'icon', code: 'error_bad_format' } }`;
    - (ii) a body without `iconPng` → `slackMethods(w)` is `['createApp']` and `lines` is `[]`;
    - (iii) `iconPng: pngBase64(511, 511)` → no `setAppIcon` call, one warn with `code: 'icon-bad-size'`; `iconPng: 42` → one warn with `code: 'icon-not-base64'`.
  - d. A success answers `iconSet: true` (existing `:930-934` keeps passing with the new default body).
  - e. `'a body that is not a JSON object → 400 invalid-body; one over the cap → 413'` (`:1004-1011`): the pad becomes `'x'.repeat(ADMIN_CONNECT_BODY_MAX_BYTES)`. New test `'a picture of exactly SLACK_ICON_MAX_BYTES gets through the body check and reaches Slack whole'`: `iconPng: pngBase64(512, 512, SLACK_ICON_MAX_BYTES)` → 200, `iconSet: true`, the `setAppIcon` bytes have length `SLACK_ICON_MAX_BYTES`.
  - The leftover-pass test's pasted-token sequence (`:1708-1714`) is unchanged (the default body still carries an icon).
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack test src/__tests__/slack-api.test.ts src/__tests__/admin-routes.test.ts`. Expected: FAIL (signature, multipart, caps, codes).
- [ ] **Step 4: Implement slack-api.** Add `| { kind: 'multipart'; fields: Record<string, string>; file: { name: string; filename: string; type: string; bytes: Uint8Array } }` to `Body`. In `call()`, set `content-type` only for `form` and `json`; for `multipart` build a `FormData` (each field appended, then `new Blob([bytes], { type })` under `name` with `filename`). `setAppIcon` sends `{ app_id }` plus file `{ name: 'file', filename: 'icon.png', type: 'image/png' }`. Rewrite the header's encoding paragraph (`:20-32`): `apps.icon.set` uploads its image as `multipart/form-data` (`file`, read on docs.slack.dev 2026-11-18; the `url` argument made Slack fetch an image it then refused, TASK-1133); the other `apps.*` calls stay forms. (If `tsc` objects to `Buffer` as a `BlobPart`, pass `new Uint8Array(bytes)`.)
- [ ] **Step 5: Implement admin-routes, plugin and preset.**
  - `connect()`: the backstop (`:665`) compares against `ADMIN_CONNECT_BODY_MAX_BYTES`; after the bot-name check, `const icon = body['iconPng'] === undefined ? null : parseIconPng(body['iconPng'])` (never a 400); pass it through `createInstall(actor, accessToken, refreshToken, name.name, icon)` to `setIcon(accessToken, app.appId, installId, icon: ParsedIcon | null): Promise<boolean>`: `null` → `false`, silent; refused → `log('warn', 'slack_admin_failed', { installId, stage: 'icon', code: icon.code })`, `false`; else upload, any throw → `failed('icon', err, installId)`, `false`.
  - `route()` takes `o: { browser?: true; maxBodyBytes?: number }`, default `ADMIN_BODY_MAX_BYTES`; the connect route passes `ADMIN_CONNECT_BODY_MAX_BYTES`.
  - Remove `iconUrl` from `AdminRoutesDeps` (`:124-125`), `ChannelSlackConfig` (`plugin.ts:150-151`) and its pass-through (`plugin.ts:340`), and from the preset (`index.ts:1539`).
  - Header (`:28`): `{ accessToken, refreshToken, botName?, iconPng? } → { installUrl, iconSet }`. Add one paragraph after the Secrets list: the bot's picture is drawn by the admin's browser and arrives as `iconPng`, a base64 PNG (icon.ts checks it); it is uploaded to Slack as is and never stored, logged or decoded past its header; a missing or unusable one leaves Slack's default picture and never fails a Connect. Replace `setIcon`'s doc (`:376`) to match the new cases.
  - Preset comment (`:1528-1531`) becomes: `// The public origin comes from here, because the preset is the layer allowed to know` / `// two plugins' surfaces: the same one @ax/mcp-oauth gets. The bot's picture isn't configured` / `// here: the admin's browser draws it and Connect uploads it (TASK-1133).`
- [ ] **Step 6: Run** the Step 3 command, then `pnpm --filter @ax/channel-slack test` and `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/preset-k8s build`. Expected: PASS, and `git grep -n "iconUrl\|icon_not_accessible" -- packages presets` finds nothing.
- [ ] **Step 7: Prove the tests bite.** With a clean tree: (1) restore the backstop to `ADMIN_BODY_MAX_BYTES` → test e's maximum-size case FAILS with 413; (2) set a manual `content-type: multipart/form-data` for multipart → the slack-api header test FAILS. Restore each with `git checkout -- <file>`.
- [ ] **Step 8: Security checklist** (skill), its row appended to the decisions shard. **Commit.** Message: `[TASK-1133] channel-slack: Connect uploads the bot's picture as a PNG; the URL Slack couldn't use goes`.

---

### Task 3: The real preset uploads the picture through the real client `[tier: integration]`

**Files:**
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`

**Interfaces:**
- Consumes: Task 2 through the composed preset (`callRoute`, `jsonBody`, `slackCalls`, `APP_ID`, `CONFIG_ACCESS_TOKEN` exist in the file).

- [ ] **Step 1: Teach the fake Slack multipart** (`:282-291`): when `init.body instanceof FormData`, record `body = Object.fromEntries(init.body)` (the `file` entry stays a `File`); string bodies parse as today.
- [ ] **Step 2: Extend the connect step** (`:796-799`): the body gains `iconPng` = the base64 of a 512×512 PNG header built inline (signature + IHDR length 13 + `IHDR` + 512, 512 big-endian + `08 06 00 00 00` + a CRC from `zlib.crc32` + IEND; no cross-package test import). Assert `connect.body` has `iconSet: true`, and one recorded `apps.icon.set` call has `auth === \`Bearer ${CONFIG_ACCESS_TOKEN}\``, `body['app_id'] === APP_ID`, and a `file` whose bytes equal the fixture.
- [ ] **Step 3: Run** `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts` (Docker; see Global Constraints). Expected: PASS.
- [ ] **Step 4: Prove it can fail.** With a clean tree, make `setIcon` return `false` before uploading in `admin-routes.ts` → the test FAILS on `iconSet`. Restore with `git checkout -- packages/channel-slack/src/admin-routes.ts`.
- [ ] **Step 5: Run dependents** `pnpm -r --no-bail --filter "...@ax/channel-slack" run test`. **Commit.** Message: `[TASK-1133] preset-k8s: the composed Connect uploads the bot's picture`.

---

### Task 4: The admin's browser draws the bot's picture `[tier: integration]`

**Files:**
- Create: `packages/channel-web/src/lib/slack-avatar-draw.ts` (import-free: Task 5 loads it into Chromium as transpiled JS, as `visual-hostile.browser.test.ts:84-92` does with `visual-doc.ts`)
- Create: `packages/channel-web/src/lib/slack-avatar.ts`
- Test: `packages/channel-web/src/lib/__tests__/slack-avatar.test.ts`

**Interfaces:**
- Produces (`slack-avatar-draw.ts`):
  ```ts
  export const SLACK_AVATAR_PX = 512;
  export const SLACK_AVATAR_INSET_PX = 64;
  /** Mirrors @ax/channel-slack's SLACK_ICON_MAX_BYTES (limits.ts). */
  export const SLACK_AVATAR_MAX_BYTES = 1_048_576;
  export function loadAvatarImage(url: string, timeoutMs: number): Promise<HTMLImageElement>; // rejects on error or timeout
  export function drawSlackAvatar(image: HTMLImageElement): string | null; // base64 PNG, no `data:` prefix
  ```
- Produces (`slack-avatar.ts`):
  ```ts
  export const SLACK_AVATAR_TIMEOUT_MS = 5_000;
  export function slackAvatarSource(branding: Branding): string | null;
  export function renderSlackAvatar(): Promise<string | null>; // never rejects
  ```

- [ ] **Step 1: Write the failing tests** in `slack-avatar.test.ts`. Mock `../slack-avatar-draw` (keep the constants via the original; `loadAvatarImage` and `drawSlackAvatar` become `vi.fn()`), and stub global `fetch` for `/api/branding`:
  1. `'a light logo is the picture, loaded from its versioned URL'`: branding `{ name: 'Canopy AI', logoType: 'full', light: true, dark: true, version: 'v7' }` → `loadAvatarImage` called with `logoUrl('light', 'v7')` and `5_000`; `drawSlackAvatar` gets the loaded image; the result is what it returned (`'B64'`).
  2. `'no logo and no product name: the AX mark'`: `{ name: '', light: false, … }` → `loadAvatarImage` called with the URL `import markLight from '@/assets/design/ax-mark-light.svg'` gives.
  3. `'no logo and the name "ax": the AX mark too'` (BrandMark's own rule).
  4. `'no logo under a custom name: no picture, nothing loaded'`: `{ name: 'Acme', light: false }` → `null`, `loadAvatarImage` not called. Also `slackAvatarSource` returns `null` for it.
  5. `'a branding read that fails: no picture'`: fetch rejects; fetch answers 500 → `null`, nothing loaded.
  6. `'a logo that will not load: no picture'`: `loadAvatarImage` rejects → `null`.
  7. `'a drawing that fails: no picture'`: `drawSlackAvatar` returns `null` → `null`.
  8. `'a branding read that never answers gives up after SLACK_AVATAR_TIMEOUT_MS'` (fake timers): fetch never settles; advance 5_000 ms → resolves `null`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/slack-avatar.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `slack-avatar-draw.ts`.** `loadAvatarImage`: `new Image()`, resolve on `load`, reject on `error` or after `timeoutMs` (clear the timer either way). `drawSlackAvatar`: a `SLACK_AVATAR_PX` square canvas; `getContext('2d')` null → `null`; fill `#ffffff` over the whole square (comment: image content, not UI; the light logo variant is made for light backgrounds and Slack shows one picture in both themes); contain the image in the `SLACK_AVATAR_PX - 2 * SLACK_AVATAR_INSET_PX` box, centred in the whole square, sizes and offsets `Math.round`ed as `favicon.ts`'s contain block does, a zero natural width or height read as the box (an SVG with only a viewBox; its own `preserveAspectRatio` letterboxes it); `drawImage` or `toDataURL('image/png')` throwing → `null`; a result not starting with `data:image/png;base64,` → `null`; decoded size `Math.floor(b64.length * 3 / 4)` over `SLACK_AVATAR_MAX_BYTES` → `null`. No imports.
- [ ] **Step 4: Implement `slack-avatar.ts`.** `slackAvatarSource`: `branding.light` → `logoUrl('light', branding.version)`; else `(branding.name.length > 0 ? branding.name : 'ax') === 'ax'` → the imported AX mark URL; else `null`. `renderSlackAvatar`: `fetchBranding()` → source → `loadAvatarImage(source, SLACK_AVATAR_TIMEOUT_MS)` → `drawSlackAvatar`, the whole chain raced against one `SLACK_AVATAR_TIMEOUT_MS` timer (cleared when the chain wins). The chain catches its own errors (→ `null`) BEFORE the race, so a failure that lands after the timer won is never an unhandled rejection. Header comment: why the browser draws it (no server image library; favicon.ts does the same), why branding is read fresh, and the white-label rule.
- [ ] **Step 5: Run** the Step 2 command, then `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `[TASK-1133] channel-web: draw the Slack bot's picture from the branding logo`.

---

### Task 5: A real browser proves the picture is a square PNG Slack can take `[tier: integration]`

This is the Bug-Fix-Policy test: a prod-shaped logo fed through the real drawing code, in Chromium.

**Files:**
- Create: `packages/channel-web/src/__tests__/slack-avatar.browser.test.ts`
- Modify: `.github/workflows/ci.yml:197-206` (comment only)

**Interfaces:**
- Consumes: Task 4's `slack-avatar-draw.ts` (transpiled, served as `/slack-avatar-draw.js`) and its constants (imported directly in node).

- [ ] **Step 1: Build the harness** on `visual-hostile.browser.test.ts`'s pattern: `// @vitest-environment node`; `describe.skipIf(CHROMIUM_MISSING && !IN_CI)`; in `beforeAll` throw when Chromium is missing (CI must run it); transpile with `ts.transpileModule` and throw if the output has an `import`. One local server (same origin for the page, the module and every image, so the canvas isn't tainted) serving: `/` a blank HTML page; `/slack-avatar-draw.js` (`text/javascript`); `/logo/wide.svg` = `<svg xmlns="http://www.w3.org/2000/svg" width="517" height="123" viewBox="0 0 517 123"><rect width="517" height="123" fill="#123456"/></svg>`; `/logo/viewbox.svg` = the same rect at `viewBox="0 0 400 100"` with no width or height; `/logo/ax-mark.svg` = the real `src/assets/design/ax-mark-light.svg` bytes. All three SVGs answer with branding's logo headers: `content-type: image/svg+xml`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `cache-control: public, max-age=31536000, immutable` (copied from `packages/branding/src/routes.ts`, say so in a comment). `/logo/missing.svg` → 404 `{"error":"not-found"}` as branding answers.
- [ ] **Step 2: Write the tests.** Each runs in the page: `import('/slack-avatar-draw.js')`, `loadAvatarImage(url, 5000)`, `drawSlackAvatar(img)`, then loads `data:image/png;base64,<result>` into an image, draws it on a 512 canvas and returns `getImageData` RGBA at the named points. In node, the base64 decodes to a PNG signature, IHDR width 512 and height 512, at most `SLACK_AVATAR_MAX_BYTES` bytes.
  1. `'a wide SVG wordmark served like the branding logo becomes a 512 px opaque square, centred'`: the band is x 64–448, y 211–302. `(256,256)`, `(70,256)`, `(440,256)` are `#123456` (each channel within ±8); `(256,190)`, `(256,320)`, `(32,256)`, `(480,256)` and the four corners `(2,2)`, `(509,2)`, `(2,509)`, `(509,509)` are `(255,255,255,255)`.
  2. `'an SVG with only a viewBox is letterboxed, not stretched'`: `(256,256)` is `#123456`; `(256,190)` and `(256,320)` are white (a 4:1 band in the 384 box spans y 208–304).
  3. `'the AX mark fills the box and leaves white corners'`: corners white and opaque; `(141,256)` is not white (the outer stroke's left point, 64 + 5.4 × 384/27 ≈ 141).
  4. `'a logo that 404s rejects'`: `loadAvatarImage('/logo/missing.svg', 5000)` rejects.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/slack-avatar.browser.test.ts`. Expected: PASS (it RUNS locally if Chromium is installed; check the output says 4 passed, not skipped).
- [ ] **Step 4: Prove it bites.** With a clean tree: drop the white `fillRect` → test 1's corner probe FAILS (alpha 0); change `SLACK_AVATAR_INSET_PX` to 0 → test 1's `(32,256)` probe FAILS. Restore with `git checkout -- packages/channel-web/src/lib/slack-avatar-draw.ts`.
- [ ] **Step 5: CI comment** (`ci.yml:197`): "Two hostile-content suites drive a real Chromium:" becomes "Three suites drive a real Chromium:" and gains a third bullet: `packages/channel-web/src/__tests__/slack-avatar.browser.test.ts` (the Slack bot's picture: a prod-shaped SVG logo becomes a 512 px PNG Slack accepts; TASK-1133). No step changes.
- [ ] **Step 6: Commit.** Message: `[TASK-1133] channel-web: prove in Chromium that a wide SVG logo becomes a 512 px PNG`.

---

### Task 6: Connect sends the picture `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/lib/slack-admin.ts`, `packages/channel-web/src/components/admin/SlackTab.tsx`
- Test: `packages/channel-web/src/__tests__/admin-slack.test.tsx`, `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx`

**Interfaces:**
- Consumes: Task 4's `renderSlackAvatar(): Promise<string | null>`; Task 2's `iconPng` body field.
- Produces: `ConnectSlackInput { accessToken: string; refreshToken: string; botName: string; iconPng?: string }`.

- [ ] **Step 1: Write the failing tests.**
  - `admin-slack.test.tsx`: `'connectSlack sends the picture when it has one'` → the POST body equals `{ accessToken, refreshToken, botName, iconPng: 'QUJD' }`. The existing "exactly the three fields" test (`:193-205`) stays as is (no `iconPng` given → no key).
  - `SlackTab.test.tsx`: `vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }))`, default `mockResolvedValue('AVATARB64')` in `beforeEach`. (1) `'posts the pasted tokens (trimmed) and the name, then hands the page to Slack'` (`:376-385`) now expects `{ accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot', iconPng: 'AVATARB64' }`. (2) New `'with no picture to send, Connect still goes, without iconPng'`: `renderSlackAvatar` resolves `null` → `Object.keys(connect.mock.calls[0]![0]).sort()` is `['accessToken', 'botName', 'refreshToken']` and the page goes to Slack.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/__tests__/admin-slack.test.tsx src/components/admin/__tests__/SlackTab.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `connectSlack` adds `iconPng` to the body only when defined. `ConnectForm.submit` (`:354-375`): after the inputs are cleared and `setBusy(true)`, `const iconPng = await renderSlackAvatar();` then `connectSlack({ accessToken, refreshToken, botName, ...(iconPng !== null ? { iconPng } : {}) })`. Header (`slack-admin.ts:7`): `{ accessToken, refreshToken, botName, iconPng? } → { installUrl }`, plus one sentence: the bot's picture, drawn by `lib/slack-avatar.ts`, rides in the same body; the tokens still go nowhere else.
- [ ] **Step 4: Run** the Step 2 command, `pnpm --filter @ax/channel-web test`, `pnpm --filter @ax/channel-web build`, then `pnpm -r --no-bail --filter "...@ax/channel-slack" --filter "...@ax/channel-web" run test`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `[TASK-1133] channel-web: Connect sends the bot's picture`.

---

### Task 7: Fix the lines that made the failure look benign; the changeset; memory `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:250-255`, `:864`
- Modify: `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:65`, `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:42`
- Create: `.changeset/slack-bot-picture.md`, `.claude/memory/context/2026-11-18-TASK-1133.md` (path from `scripts/memory-write-target.sh --shard context TASK-1133`; `mkdir -p` its directory first)

- [ ] **Step 1: Design §3 step 3** (`:250-255`): replace "and sets the avatar (the branding logo) with `apps.icon.set`." with "and uploads the bot's picture with `apps.icon.set`: the admin's browser draws the branding logo (with no logo and no product name, the AX mark) centred on a white 512 px square, and Connect sends that PNG (TASK-1133). Under a custom name with no logo the bot keeps Slack's default picture." Keep the rest of the step.
- [ ] **Step 2: Design §7 row 2** (`:864`): append to the Answer cell: "Only as an uploaded PNG (`file`). Until TASK-1133 Connect passed a `url` to the branding logo instead. On every kind walk (no logo, so the URL 404'd) Slack answered `error_bad_format`, and prod's logo, a 517×123 SVG wordmark, is outside the documented 512–2000 px."
- [ ] **Step 3: Walk reports.** Append to each line, as TASK-1130 and TASK-1132 did: "*Found later (TASK-1133): there was no upload. Connect gave Slack a URL to the branding logo, which 404s with no logo uploaded (Slack then says `error_bad_format`) and is an SVG wordmark on prod. The admin's browser now draws a 512 px PNG and Connect uploads it.*"
- [ ] **Step 4: The changeset** `.changeset/slack-bot-picture.md`:
  ```
  ---
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  '@ax/preset-k8s': patch
  ---

  The Slack bot gets a real picture when you connect a workspace. Before, we pointed Slack at our logo's web address, and Slack turned it down every time (it needs an image file at least 512 pixels on each side, and a missing logo or a wide SVG wordmark isn't one), so every new bot wore Slack's default face. Now your browser draws the bot's picture from your logo, centred on a white square, and Connect uploads it. A server with no logo and no product name gets the default mark; one with a product name but no logo keeps Slack's default picture. A bot connected before this update keeps its current picture until it's connected again.
  ```
- [ ] **Step 5: Memory context shard**, rows dated 2026-11-18:
  - "CORRECTS `decisions/2026-11-13-TASK-1093.md`, row 'Avatar: `apps.icon.set` with `url` …': the URL path never set a picture. A 404 gets `error_bad_format`, not `icon_not_accessible`, and prod's logo is a 517×123 SVG. Since TASK-1133 the admin's browser draws a 512 px PNG (light logo; AX mark when no logo and no name; none under a custom name) and Connect uploads it as multipart `file`; `iconUrl` is gone."
  - "CORRECTS the same file's row 'Early DM walk on kind', finding (3): `iconSet:false` was the bug, not a correct outcome."
  - "CORRECTS the same file's row 'Measured Slack facts …': docs.slack.dev lists `apps.icon.set` as Tier 2 (read 2026-11-18), not Tier 1."
  - "channel-web already rasterizes the branding logo client-side (`lib/favicon.ts`); `lib/slack-avatar-draw.ts` does it at 512 px. A real-Chromium test (`slack-avatar.browser.test.ts`) is the only place SVG-to-PNG drawing is proven; jsdom has no canvas."
- [ ] **Step 6: Check and commit.** `pnpm test:scripts` passes; `git diff --stat -- .claude/memory` shows only the new shard. Message: `[TASK-1133] docs: the bot's picture is uploaded, not fetched from a URL`.

---

## Ship-time steps (the builder; not implementer tasks)

1. **PR** (squash title `[TASK-1133] Slack: Connect uploads a bot picture Slack accepts`). Body: the premise section above (no upload existed; why the URL failed in both environments); the design bullets; `## Security review` from Task 2's shard row; boundary review: N/A, no hook, IPC action or manifest change, and the connect body is an HTTP admin route mirrored by shape; "Not measurable in CI": that real Slack takes our 512 px PNG.
2. **Handoff `learnings:`**
   - **The acceptance needs a real-Slack walk** (Vinay makes the configuration tokens): on kind (no logo, no name) Connect → the bot wears the AX mark, the host logs no `slack_admin_failed {stage:'icon'}`, and the Connect answer says `iconSet: true`. Then upload a wide SVG logo in Admin > Branding, Disconnect, Connect → the bot wears the logo on white.
   - **Suggested follow-up card:** set the picture on an existing install (prod's bot keeps Slack's default until reconnected, and reconnecting drops channel connections). Rename already mints an access token, so it could carry `iconPng` too.
   - **TASK-1139** (success log lines): a set picture logs nothing; only failures do.
