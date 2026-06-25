# Branding Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Invoke `ax-conventions` (new plugin), `security-checklist` (Task 2), and `shadcn` (Task 7) at the marked tasks.

**Goal:** Add an admin-configurable product **name** + **logo** (light/dark) that renders in the header (chat, admin, login, setup), auto-generates the browser-tab favicon, works in light/dark mode, and is readable pre-auth/pre-bootstrap.

**Architecture:** A new `@ax/branding` HTTP route-plugin (sibling of `@ax/admin-settings-routes`) owns a public read/serve surface (`GET /api/branding`, `GET /api/branding/logo/:variant`) and an admin write surface (`PUT /admin/branding`). It persists a JSON pointer record via `storage:get/set` (key `settings:branding`) and the logo bytes via `blob:put/get/delete`. The SPA fetches branding once at app load (`BrandingProvider`), the existing `BrandMark` component (the single header source of truth) is reworked to consume it, and a favicon/title effect runs app-wide.

**Tech Stack:** TypeScript, pnpm workspace, `@ax/core` HookBus, `@ax/http-server` route hook, zod, React 18 + shadcn (channel-web), vitest.

## Global Constraints (verbatim from spec + invariants)

- **No new DB / no new storage backend.** Only `storage:get`/`storage:set` (`{ key: string, value: Uint8Array }`) and `blob:put`/`blob:get`/`blob:delete` (`{ bytes }→{ sha256,size }`, `{ sha256 }→{ bytes }|{ found:false }`, `{ sha256 }→{}`).
- **No new service hooks.** `@ax/branding` only mounts HTTP routes via `http:register-route` and *calls* existing kernel hooks. No backend vocabulary in any payload.
- **No cross-plugin imports.** Duck-type the http req/res in the plugin's own `shared.ts`; copy the auth/body helpers from siblings (do NOT import them).
- **No half-wired plugins.** Same PR wires `@ax/branding` into `presets/k8s`, updates the four preset test assertions, and wires the SPA end-to-end.
- **One UI design language.** All new UI uses channel-web's shadcn primitives + semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`, …). No raw colors, no hand-rolled forms. Invoke the `shadcn` skill for Task 7.
- **Storage key:** `settings:branding`. **Content-type allowlist:** `image/png`, `image/webp`, `image/jpeg`, `image/svg+xml`. **PUT body cap:** 3 MiB (`maxBodyBytes`). **Per-logo decoded cap:** 1 MiB. **Favicon canvas:** 64×64.
- **CSRF:** `PUT /admin/branding` is auto-CSRF-gated by http-server (state-changing). SPA writes send header `x-requested-with: ax-admin` + `credentials: 'include'`. GETs are exempt.
- **Voice & Tone** applies to all user-facing copy (admin tab labels, hints, errors).

---

## File Structure

**New package `packages/branding/`:**
- `package.json`, `tsconfig.json`
- `src/index.ts` — barrel (exports `createBrandingPlugin`, wire types)
- `src/shared.ts` — duck-typed `RouteRequest`/`RouteResponse`, `AuthedUser`, `requireAdmin`, body-parse helper (copied from siblings)
- `src/record.ts` — `BrandingRecord` (stored shape), `WireBranding` (public GET shape), `serializeRecord`/`parseRecord`, defaults
- `src/image-validation.ts` — content-type allowlist, magic-byte sniff, size caps; `validateLogoUpload`
- `src/routes.ts` — handlers (`getBranding`, `getLogo`, `putBranding`) + `registerBrandingRoutes`
- `src/plugin.ts` — `createBrandingPlugin(): Plugin`
- `src/__tests__/record.test.ts`, `image-validation.test.ts`, `routes.test.ts`

**Preset wiring:**
- `presets/k8s/package.json` (+dep), `presets/k8s/tsconfig.json` (+ref), `presets/k8s/src/index.ts` (+import +push)
- `tsconfig.json` (root, +ref), `pnpm-lock.yaml`
- `presets/k8s/src/__tests__/{preset,acceptance,multi-tenant-acceptance}.test.ts`

**SPA (`packages/channel-web/`):**
- `src/lib/branding.ts` — wire types + client (`fetchBranding`, `putBranding`, `logoUrl`)
- `src/lib/branding-context.tsx` — `BrandingProvider`, `useBranding`
- `src/lib/favicon.ts` — `regenerateFavicon`
- `src/lib/theme.ts` — add `useResolvedTheme()`
- `src/main.tsx` — wrap `<App/>` in `<BrandingProvider>`
- `src/components/BrandMark.tsx` — reworked to consume branding
- `src/components/{Sidebar,admin/AdminSidebar,LoginPage,setup/SetupShell}.tsx` — call-site updates
- `src/components/admin/{AdminSidebar,AdminShell}.tsx` — new `branding` tab
- `src/components/admin/BrandingTab.tsx` — admin UI
- `index.html` — neutral `<title>ax</title>`
- `mock/api/branding.ts` (+ wire into `mock/server.ts`) — dev-mode default
- tests colocated under `src/**/__tests__` / `*.test.tsx`

---

## Task 1: `@ax/branding` package scaffold + pure logic (record + image validation)

**Files:**
- Create: `packages/branding/package.json`, `packages/branding/tsconfig.json`, `packages/branding/src/index.ts`, `packages/branding/src/record.ts`, `packages/branding/src/image-validation.ts`
- Modify: root `tsconfig.json` (add `{ "path": "packages/branding" }` to references)
- Test: `packages/branding/src/__tests__/record.test.ts`, `packages/branding/src/__tests__/image-validation.test.ts`

**Interfaces (Produces):**
```ts
// record.ts
export interface LogoPointer { sha256: string; contentType: AllowedContentType; }
export interface BrandingRecord {
  name: string;            // "" allowed
  logoType: 'full' | 'icon';
  light: LogoPointer | null;
  dark: LogoPointer | null;
  version: string;         // ISO updatedAt; cache-buster
}
export interface WireBranding {  // public GET shape
  name: string; logoType: 'full' | 'icon'; light: boolean; dark: boolean; version: string;
}
export const DEFAULT_RECORD: BrandingRecord; // { name:'', logoType:'full', light:null, dark:null, version:'' }
export function serializeRecord(r: BrandingRecord): Uint8Array;     // JSON → utf8 bytes
export function parseRecord(bytes: Uint8Array | undefined): BrandingRecord; // tolerant; bad/empty → DEFAULT_RECORD
export function toWire(r: BrandingRecord): WireBranding;

// image-validation.ts
export type AllowedContentType = 'image/png'|'image/webp'|'image/jpeg'|'image/svg+xml';
export const ALLOWED_CONTENT_TYPES: readonly AllowedContentType[];
export const MAX_LOGO_BYTES = 1 * 1024 * 1024;
export type ValidateResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };
// Decodes base64, enforces MAX_LOGO_BYTES, asserts magic bytes match declared contentType.
export function validateLogoUpload(contentType: string, dataBase64: string): ValidateResult;
```

- [ ] **Step 1: Write package.json** (mirror `packages/admin-settings-routes/package.json`)

```json
{
  "name": "@ax/branding",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc --build", "test": "vitest run", "test:watch": "vitest" },
  "dependencies": { "@ax/core": "workspace:*", "zod": "^3.23.8" },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@ax/storage-sqlite": "workspace:*",
    "@ax/blob-store-fs": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Write tsconfig.json** (mirror sibling)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 3: Add root tsconfig reference.** In `tsconfig.json` references array add `{ "path": "packages/branding" }` (keep alphabetical-ish grouping near other packages). Run `pnpm install` so the workspace links `@ax/branding`.

- [ ] **Step 4: Write the failing tests** — `record.test.ts`: empty/undefined bytes → `DEFAULT_RECORD`; round-trip a populated record; `toWire` maps pointers→booleans; malformed JSON → `DEFAULT_RECORD`. `image-validation.test.ts`: a real 1×1 PNG/JPEG/WebP byte fixture + a minimal `<svg>` accept; declared png but jpeg bytes → reject (magic mismatch); disallowed `text/plain` → reject; oversized (> MAX_LOGO_BYTES) → reject; non-base64 → reject; svg whose text doesn't start with `<svg`/`<?xml` → reject. Run: `pnpm -F @ax/branding test` → FAIL (modules missing).

- [ ] **Step 5: Implement `record.ts`.** `parseRecord` decodes utf8 → `JSON.parse` in try/catch, validates with a zod schema, and falls back to `DEFAULT_RECORD` on any failure. `serializeRecord` = `new TextEncoder().encode(JSON.stringify(r))`.

- [ ] **Step 6: Implement `image-validation.ts`.** Magic bytes: PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; WebP `52 49 46 46 .. .. .. .. 57 45 42 50` (RIFF + WEBP at offset 8); SVG = decode utf8 (lenient), strip BOM + leading whitespace + optional `<?xml…?>` + optional comments/DOCTYPE, then assert next non-space starts `<svg`. Decode base64 with `Buffer.from(b, 'base64')` and re-encode-compare or length-check to reject non-base64.

- [ ] **Step 7: Write `src/index.ts` barrel** exporting record + validation types (plugin export added in Task 2).

- [ ] **Step 8: Run tests → PASS.** Run `pnpm -F @ax/branding build` to confirm tsc is clean.

- [ ] **Step 9: Commit.** `feat(branding): @ax/branding package scaffold + record model + image validation`

---

## Task 2: Route handlers + plugin (init wires routes) — **invoke `security-checklist` + `ax-conventions`**

**Files:**
- Create: `packages/branding/src/shared.ts`, `packages/branding/src/routes.ts`, `packages/branding/src/plugin.ts`
- Modify: `packages/branding/src/index.ts` (export `createBrandingPlugin` + wire types)
- Test: `packages/branding/src/__tests__/routes.test.ts`

**Interfaces (Consumes from Task 1):** `BrandingRecord`, `DEFAULT_RECORD`, `serializeRecord`, `parseRecord`, `toWire`, `validateLogoUpload`, `AllowedContentType`.
**Interfaces (Produces):**
```ts
export function createBrandingPlugin(): Plugin;
// PUT body (zod):
interface PutBody {
  name?: string;
  logoType?: 'full' | 'icon';
  light?: { contentType: string; dataBase64: string } | null; // null = clear
  dark?:  { contentType: string; dataBase64: string } | null;
}
```

Manifest:
```ts
manifest: {
  name: '@ax/branding', version: '0.0.0', registers: [],
  calls: ['http:register-route','auth:require-user','storage:get','storage:set','blob:put','blob:get','blob:delete'],
  subscribes: [],
}
```

Routes registered in `init()` (atomic unwind on failure, drop in `shutdown()`):
1. `GET /api/branding` — read record (`storage:get` `settings:branding`), `res.status(200).json(toWire(record))`. No auth.
2. `GET /api/branding/logo/:variant` — `variant ∈ {light,dark}` else 400; pointer null → 404; `blob:get` by sha → `{found:false}` → 404; set headers then `res.body(buf)`:
   - `content-type` = pointer.contentType
   - `cache-control: public, max-age=31536000, immutable`
   - `x-content-type-options: nosniff`
   - if `image/svg+xml`: also `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
3. `PUT /admin/branding` — `requireAdmin` (401/403); parse JSON body (400 on bad); zod-validate `PutBody`; for each present `light`/`dark`: `null`→clear (mark old sha for delete), object→`validateLogoUpload` (422 on reject) then `blob:put`→new pointer; compute next record (omitted fields unchanged; `version = ` ISO timestamp passed in via handler clock — use `new Date().toISOString()` inside handler, NOT in plan code); `storage:set`; then **delete orphaned blobs**: for each old sha being replaced/cleared, delete it ONLY if it's not still referenced by the surviving `light`/`dark` pointer (content-addressed store may share a sha). `res.status(204).end()`.
   - Register with `maxBodyBytes: 3 * 1024 * 1024`.

`shared.ts`: duck-type `RouteRequest` (`headers, body:Buffer, cookies, query, params, signedCookie`) and `RouteResponse` (`status, header, json, text, body, end`) — copy the subset from `@ax/http-server`'s `HttpResponse`/`HttpRequest` but define locally (I2). Copy `requireAuthenticated`/`requireAdmin` + `AuthedUser` + `parseRequestBody` from `packages/credentials-admin-routes/src/shared.ts` (copy, not import).

- [ ] **Step 1: Invoke `security-checklist` skill** (untrusted image upload + new public routes + SVG serve). Produce the structured PR security note covering: content-type allowlist, magic-byte sniff, decoded size cap, body cap, SVG CSP/nosniff, `<img>`-only render, admin-gate + CSRF, public-read scope.
- [ ] **Step 2: Write `shared.ts`** (duck types + copied auth/body helpers).
- [ ] **Step 3: Write the failing `routes.test.ts`.** In-process `HookBus`; register stub services: `auth:require-user` (admin / non-admin / throwing variants), an in-memory `storage:get`/`storage:set` Map, an in-memory content-addressed `blob:put`/`blob:get`/`blob:delete` (sha256 of bytes). Capture routes via a fake `http:register-route` that stores `{method,path,handler,maxBodyBytes}`; call `createBrandingPlugin().init({bus})`; drive handlers with `mkReq`/`mkRes`. Cases:
  - GET `/api/branding` empty → `{name:'',logoType:'full',light:false,dark:false,version:''}`.
  - PUT as admin with a light PNG → 204; GET reflects `light:true` + new `version`; GET logo/light → 200, `content-type image/png`, cache + nosniff headers; GET logo/dark → 404.
  - PUT SVG dark → GET logo/dark 200 with CSP + nosniff headers.
  - PUT replacing light logo deletes the previous blob (assert `blob:delete` called with old sha, not the surviving one).
  - PUT `light:null` clears + deletes blob; GET `light:false`.
  - PUT non-admin → 403; unauthenticated → 401.
  - PUT declared `image/png` with JPEG bytes → 422; disallowed content-type → 422/400; oversized → 422.
  - Assert PUT route registered with `maxBodyBytes === 3*1024*1024`.
  Run → FAIL.
- [ ] **Step 4: Implement `routes.ts` + `plugin.ts`** (mirror `admin-settings-routes` plugin structure: `initCtx = makeAgentContext({sessionId:'init',agentId:'@ax/branding',userId:'system'})`, atomic route registration).
- [ ] **Step 5: Export `createBrandingPlugin` + wire types from `index.ts`.**
- [ ] **Step 6: Run `pnpm -F @ax/branding test` → PASS; `pnpm -F @ax/branding build` clean.**
- [ ] **Step 7: Commit.** `feat(branding): public read/serve + admin PUT routes with upload validation`

---

## Task 3: Wire `@ax/branding` into the k8s preset + update preset tests

**Files:**
- Modify: `presets/k8s/package.json` (add `"@ax/branding": "workspace:*"`), `presets/k8s/tsconfig.json` (add `{ "path": "../../packages/branding" }`), `presets/k8s/src/index.ts` (import + push), `pnpm-lock.yaml` (via `pnpm install`)
- Modify tests: `presets/k8s/src/__tests__/preset.test.ts`, `acceptance.test.ts`, `multi-tenant-acceptance.test.ts`

- [ ] **Step 1:** Add dep + tsconfig ref; run `pnpm install` to splice the lockfile importer block.
- [ ] **Step 2:** In `presets/k8s/src/index.ts`: `import { createBrandingPlugin } from '@ax/branding';` near the other admin-route imports; push it right after `plugins.push(createRoutinesAdminRoutesPlugin());` (line ~760) with a comment noting it owns public `/api/branding*` + admin `PUT /admin/branding`, persisting via `storage:*` + `blob:*` (both already pushed; http-server/auth resolved by topo-sort).
- [ ] **Step 3: Update `preset.test.ts`** — add `'@ax/branding'` to the sorted expected plugin-name list (the canary that proves reachability per invariant #3).
- [ ] **Step 4: Update `acceptance.test.ts`** — add `'@ax/branding'` to `PLUGINS_TO_DROP` with a comment: it `calls` http:register-route + auth:require-user (both dropped); static wiring pinned in preset.test.ts; drop here so the chat-path canaries don't need the control plane.
- [ ] **Step 5: Update `multi-tenant-acceptance.test.ts`** — same `PLUGINS_TO_DROP` addition.
- [ ] **Step 6:** Check `prod-bootstrap.test.ts` for any exact plugin-count/list assertion; it boots the real set so branding auto-loads — only adjust if a count assertion now drifts.
- [ ] **Step 7: Run `pnpm -F @ax/presets-k8s test` → PASS; `pnpm -F @ax/presets-k8s build` clean.**
- [ ] **Step 8: Commit.** `feat(branding): wire @ax/branding into k8s preset + update preset canaries`

---

## Task 4: SPA branding lib + provider (app-wide, default-on-error) + dev mock

**Files:**
- Create: `packages/channel-web/src/lib/branding.ts`, `packages/channel-web/src/lib/branding-context.tsx`
- Modify: `packages/channel-web/src/main.tsx` (wrap `<App/>`)
- Create: `packages/channel-web/mock/api/branding.ts` + wire into `mock/server.ts`
- Test: `packages/channel-web/src/lib/__tests__/branding-context.test.tsx`

**Interfaces (Produces):**
```ts
// branding.ts
export interface Branding { name: string; logoType: 'full'|'icon'; light: boolean; dark: boolean; version: string; }
export const DEFAULT_BRANDING: Branding; // { name:'', logoType:'full', light:false, dark:false, version:'' }
export async function fetchBranding(): Promise<Branding>; // GET /api/branding; throws on !ok
export function logoUrl(variant: 'light'|'dark', version: string): string; // `/api/branding/logo/${variant}?v=${encodeURIComponent(version)}`
export interface PutBrandingInput {
  name?: string; logoType?: 'full'|'icon';
  light?: { contentType: string; dataBase64: string } | null;
  dark?:  { contentType: string; dataBase64: string } | null;
}
export async function putBranding(input: PutBrandingInput): Promise<void>; // PUT /admin/branding, writeHeaders + credentials:'include'
// branding-context.tsx
export function BrandingProvider(props: { children: ReactNode }): JSX.Element;
export function useBranding(): { branding: Branding; loaded: boolean; refresh: () => void };
```

- [ ] **Step 1: Write failing `branding-context.test.tsx`** — mock `fetch`: returns populated wire → provider exposes it + `loaded:true`; fetch rejects → provider exposes `DEFAULT_BRANDING` + `loaded:true` (graceful default, no throw). Run → FAIL.
- [ ] **Step 2: Implement `branding.ts`** (mirror `lib/admin-settings.ts` `writeHeaders` + `credentials:'include'`).
- [ ] **Step 3: Implement `branding-context.tsx`** — `useState(DEFAULT_BRANDING)` + `loaded`, fetch-once `useEffect` (cancel-guarded), on error set `DEFAULT_BRANDING` + `loaded:true`. `refresh()` re-fetches (used by the admin tab after save). The "render nothing while loading to avoid flash" behavior is implemented in `BrandMark` (Task 5) by gating on `loaded`, not by blocking the whole tree.
- [ ] **Step 4: Wrap in `main.tsx`:** `createRoot(...).render(<BrandingProvider><App /></BrandingProvider>)`.
- [ ] **Step 5: Add dev mock** `mock/api/branding.ts` returning `DEFAULT_BRANDING` for `GET /api/branding`; wire its dispatch into `mock/server.ts` (mirror existing mock handlers). 404 for logo routes.
- [ ] **Step 6: Run `pnpm -F @ax/channel-web test` (branding-context) → PASS.**
- [ ] **Step 7: Commit.** `feat(branding): SPA branding client + app-wide provider`

---

## Task 5: Resolved-theme hook + `BrandMark` rework + four call sites

**Files:**
- Modify: `packages/channel-web/src/lib/theme.ts` (add `useResolvedTheme`)
- Modify: `packages/channel-web/src/components/BrandMark.tsx`
- Modify: `Sidebar.tsx`, `components/admin/AdminSidebar.tsx`, `components/LoginPage.tsx`, `components/setup/SetupShell.tsx`
- Test: `packages/channel-web/src/components/__tests__/BrandMark.test.tsx`

**Interfaces (Produces):** `export function useResolvedTheme(): 'light' | 'dark';` — combines `useTheme()` (`auto`/`light`/`dark`) with a `matchMedia('(prefers-color-scheme: dark)')` subscription so `auto` resolves to the OS preference.

**BrandMark behavior (consumes `useBranding()` + `useResolvedTheme()`):**
- `!loaded` → render an invisible spacer sized like the wordmark (avoid layout shift + flashing `ax`).
- No logo (`!light`) → today's dot + `name || 'ax'` (unchanged visuals).
- Logo + `logoType==='full'` → `<img>` only. Variant: dark logo exists & resolved dark → `logoUrl('dark',version)`; else `logoUrl('light',version)`. If only light exists and resolved dark → add class applying `filter: invert(1) hue-rotate(180deg)`.
- Logo + `logoType==='icon'` → small square `<img>` (height = wordmark height) + `name || 'ax'` text beside it; same variant/invert logic.
- Keep the `size` prop (`md`/`xl`) controlling scale; `<img>` height tracks the wordmark line-height. Keep `className` passthrough. Drop the required `word` prop (name now comes from context); keep an optional override if trivial, else remove and update call sites.

- [ ] **Step 1: Write failing `BrandMark.test.tsx`** rendering matrix with a `BrandingContext` test wrapper + a mocked `useResolvedTheme`: no-logo→dot+name; full→single `<img>` with `src` containing `/api/branding/logo/light?v=`; full+dark-theme+dark-logo→`logo/dark`; full+dark-theme+only-light→`logo/light` + invert class; icon→`<img>`+name text; `!loaded`→no `ax` text rendered. Run → FAIL.
- [ ] **Step 2: Implement `useResolvedTheme` in `theme.ts`** (reuse the `useSyncExternalStore` pattern; subscribe to both the theme store and `matchMedia` change).
- [ ] **Step 3: Rework `BrandMark.tsx`.**
- [ ] **Step 4: Update call sites** — `Sidebar.tsx:41` `<BrandMark className="[body.sidebar-collapsed_&]:hidden" />`; `AdminSidebar.tsx:99` `<BrandMark />`; `LoginPage.tsx:20` `<BrandMark size="xl" />`; `SetupShell.tsx:22` `<BrandMark size="xl" />` (remove `word="ax"`).
- [ ] **Step 5: Run `pnpm -F @ax/channel-web test` (BrandMark) → PASS.**
- [ ] **Step 6: Commit.** `feat(branding): BrandMark consumes branding context (logo/name, light/dark)`

---

## Task 6: Title + favicon (auto-generated from logo, theme-aware)

**Files:**
- Create: `packages/channel-web/src/lib/favicon.ts`
- Modify: `packages/channel-web/src/lib/branding-context.tsx` (title + favicon effect)
- Modify: `packages/channel-web/index.html` (`<title>ax</title>`)
- Test: `packages/channel-web/src/lib/__tests__/favicon.test.ts`

**Interfaces (Produces):**
```ts
// favicon.ts
// Draws an <img> (already loaded, same-origin) into a 64×64 transparent canvas
// (object-fit contain), optionally inverting, exports PNG dataURL, sets/replaces <link rel="icon">.
export function applyFaviconFromImage(img: HTMLImageElement, opts: { invert: boolean }): void;
export function resetFaviconToDefault(): void; // remove our injected <link rel="icon">
```

- [ ] **Step 1: Write failing `favicon.test.ts`** (jsdom): stub `HTMLCanvasElement.getContext` + `toDataURL`; `applyFaviconFromImage` creates/updates a single `<link rel="icon">` with the data URL; `resetFaviconToDefault` removes it. Run → FAIL.
- [ ] **Step 2: Implement `favicon.ts`** (idempotent link element keyed by `id="ax-favicon"`; when `invert`, apply `ctx.filter='invert(1) hue-rotate(180deg)'` before draw — guarded since jsdom may not support `filter`).
- [ ] **Step 3: Add the effect to `BrandingProvider`** (runs app-wide): set `document.title = branding.name || 'ax'`; when a logo exists, load the current-variant logo via a same-origin `new Image()` (`src = logoUrl(variant,version)`), and on `onload` call `applyFaviconFromImage` with `invert = (resolvedDark && !branding.dark)`; when no logo, `resetFaviconToDefault`. Re-run on `[branding, resolvedTheme]`.
- [ ] **Step 4: Set `index.html` title to `ax`** (neutral default; effect overrides with the configured name).
- [ ] **Step 5: Run `pnpm -F @ax/channel-web test` (favicon) → PASS.**
- [ ] **Step 6: Commit.** `feat(branding): document title + auto-generated favicon from logo`

---

## Task 7: Admin "Branding" tab — **invoke `shadcn` skill**

**Files:**
- Create: `packages/channel-web/src/components/admin/BrandingTab.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx` (`AdminTabId` + `ADMIN_NAV`)
- Modify: `packages/channel-web/src/components/admin/AdminShell.tsx` (`TAB_META` + render switch)
- Test: `packages/channel-web/src/components/admin/__tests__/BrandingTab.test.tsx`

**Tab contents (shadcn primitives + semantic tokens):**
- **Name** — `Input`.
- **Logo type** — `RadioGroup`: *Full logo (includes the name)* vs *Icon only (show the name beside it)*.
- **Light logo** — file input (`accept` the allowlist) + preview on a light surface.
- **Dark logo** — optional file input + preview on a dark surface, hint: "Leave empty and we'll auto-invert the light logo for dark mode."
- **Live preview** — the rendered header on light + dark backgrounds (reuse `BrandMark` or a preview that mirrors its logic) using the in-progress (unsaved) selections.
- **Save / Clear** — mirror `ModelConfigTab` save-state (`Saving…` / `✓ Saved` (2s) / error `Alert`). Save reads files → base64 (`FileReader`), validates content-type against the allowlist client-side (early friendly error), calls `putBranding`, then `useBranding().refresh()`. Clear calls `putBranding({ name:'', logoType:'full', light:null, dark:null })` then `refresh()`.

- [ ] **Step 1: Invoke `shadcn` skill** (loads installed-component list + the `-c packages/channel-web` workspace flag). Add `RadioGroup` via the CLI if not installed: `pnpm dlx shadcn@latest add radio-group -c packages/channel-web`.
- [ ] **Step 2: Add `'branding'` to `AdminTabId`** + an `ADMIN_NAV` entry `{ id:'branding', label:'Branding', icon: <a lucide icon e.g. Palette> }`.
- [ ] **Step 3: Add `branding` to `TAB_META`** (`{ eyebrow:'Admin', title:'Branding' }`) + `{activeTab === 'branding' && <BrandingTab />}` in `AdminShell`.
- [ ] **Step 4: Write failing `BrandingTab.test.tsx`** — renders fields; typing a name + clicking Save calls `putBranding` with the name; selecting a fake file populates a logo + Save sends `dataBase64`; Clear calls `putBranding` with nulls; a disallowed file type surfaces a friendly error and does NOT call `putBranding`. Mock `putBranding`/`useBranding`. Run → FAIL.
- [ ] **Step 5: Implement `BrandingTab.tsx`.**
- [ ] **Step 6: Run `pnpm -F @ax/channel-web build` (type-checks `__tests__`) + the tab test → PASS.**
- [ ] **Step 7: Commit.** `feat(branding): admin Branding tab (name, logo upload, live preview)`

---

## Task 8: Whole-branch verification + memory

- [ ] **Step 1:** `pnpm build` (whole repo) → clean.
- [ ] **Step 2:** `pnpm test` (whole repo) → green. (Or at minimum `@ax/branding`, `@ax/presets-k8s`, `@ax/channel-web`.)
- [ ] **Step 3:** `pnpm lint` scoped to changed files → clean (stale `.worktrees/` noise excluded).
- [ ] **Step 4:** Update `.claude/memory/patterns.md` with a dated entry: `@ax/branding` plugin shape, storage key `settings:branding`, blob-pointer record, SVG hardened-serve headers, the favicon-from-`<img>`-canvas approach, and the preset drop-list addition. Commit memory with the work (branch-local).
- [ ] **Step 5: Commit.** `chore(branding): branch verification + memory note`
- [ ] **Step 6:** Report results; offer to open the PR (do not push without the user's go-ahead). Manual-acceptance walk against kind is a follow-up.

---

## Self-Review (against the design doc)

- **Goals — admin name+logo / favicon / light-dark / pre-auth public reads:** Tasks 7, 6, 5/6, 1-4 respectively. ✓
- **Decision 1 (two logos, dark optional, CSS-invert fallback):** Task 5 variant + invert; Task 6 favicon invert. ✓
- **Decision 2 (client-side 64×64 favicon, no image lib):** Task 6. ✓
- **Decision 3 (logoType full/icon toggle):** record (T1), handler (T2), BrandMark (T5), tab radio (T7). ✓
- **Decision 4 (SVG allowed, hardened headers):** validation (T1), serve CSP+nosniff (T2). ✓
- **Decision 5 (spec in docs/plans):** this file. ✓
- **Architecture (new route plugin, storage+blob only, no new hooks):** T1-T2 manifest `calls` only. ✓
- **Data model (settings:branding pointer + version + orphan-blob delete):** T1 record, T2 delete-orphan logic. ✓
- **Wire surface (GET defaults/populated, logo 404-dark, PUT caps/validation/204):** T2 + tests. ✓
- **SPA (context, BrandMark, title+favicon):** T4, T5, T6. ✓
- **Admin tab (fields, live preview, save/clear states):** T7. ✓
- **Security (allowlist, magic-byte, caps, SVG CSP, img-only, admin+CSRF, public reads):** T1, T2 (+security-checklist). ✓
- **Half-wired window (same PR: preset + 4 test files + SPA e2e):** T3 (preset + 3 test files; prod-bootstrap auto) + T4-T7. ✓
- **Testing (plugin units, preset canary, SPA matrix, public GET canary):** per-task tests + T2 routes canary + T3 preset.test canary. ✓
- **Open details:** favicon 64×64 (chosen); apple-touch-icon skipped (v1); no debounce (v1); SVG CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox` (security-checklist may refine). ✓
