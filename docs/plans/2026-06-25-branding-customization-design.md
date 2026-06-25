# Branding customization — design

**Date:** 2026-06-25
**Status:** Approved (design); implementation plan to follow.

## Problem

The product name and logo are hardcoded to `"ax"` (a blue dot + the wordmark
`ax`, rendered by the `BrandMark` component in four places: chat sidebar, admin
sidebar, login page, setup wizard). The browser tab shows a static title
(`ax channel-web`) and there is no favicon.

Operators deploying AX want to brand it as their own — e.g. "Canopy AI" with a
custom logo. We need an admin surface to set **the product name and the logo**,
the logo must be **auto-converted to a favicon**, and the whole thing must look
right in **both light and dark mode**.

## Goals

- An admin-only "Branding" tab that sets the product **name** and uploads a
  **logo**.
- The logo is **automatically wired as the browser-tab favicon** (no separate
  favicon upload, no server-side image library).
- Branding renders correctly in **light and dark mode**.
- Branding is visible **before authentication** (login page, setup wizard) and
  **before bootstrap completes** — so reads must be public.

## Non-goals (v1)

Per-team or per-agent branding; theme/color customization; branding for email or
other (non-web) channels; animated logos.

## Decisions (resolved during brainstorming)

1. **Light/dark:** two logos (light + dark). If only the light logo is provided,
   dark mode **CSS-inverts** it. Dark logo is optional.
2. **Favicon:** **auto-generated from the logo**, client-side, by square-padding
   into a 64×64 canvas. No image library, no extra upload.
3. **Header layout:** admin chooses per-upload via a **logo-type toggle** —
   `full` (the logo carries its own wordmark → show the logo alone) or `icon`
   (the logo is a symbol → show it next to the editable name text).
4. **SVG allowed** (PNG/WebP/JPEG/SVG), with SVG served under hardened headers.
5. Spec lives in `docs/plans/` (repo convention), not the brainstorming default.

---

## Architecture

A new **`@ax/branding`** route plugin — same family as
`@ax/credentials-admin-routes` and `@ax/routines-admin-routes`. It owns both the
**public** read/serve surface and the **admin** write surface for the single
"branding" concept.

It stores through the kernel surfaces only — **no new DB, no new storage
backend**:

- `storage:get` / `storage:set` for the branding config record.
- `blob:put` / `blob:get` / `blob:delete` for the logo bytes.

Both `storage:*` and `blob:*` are already registered in the k8s preset
(`@ax/database-postgres` / `@ax/blob-store-fs|s3`).

**Alternative considered — fold into `@ax/admin-settings-routes`:** rejected.
That plugin is deliberately admin-only and string-only ("a free-form KV admin
surface would be a footgun"); branding needs public reads + binary storage and is
its own concept. Reusing it would split branding across two homes and violate the
*one source of truth* invariant.

**Alternative considered — fold into channel-web's `server/plugin.ts`:**
rejected. Branding is a distinct concept with both admin and public surfaces; the
dedicated route-plugin family is the established pattern.

### Boundary review (new hooks)

`@ax/branding` registers **no new service hooks** — it only mounts HTTP routes
(via `http:register-route`) and *calls* existing kernel hooks (`storage:*`,
`blob:*`, `auth:require-user`). So there is no new hook surface to leak backend
vocabulary. The HTTP wire schema lives in this plugin's directory.

---

## Data model

One JSON record at storage key `settings:branding`:

```jsonc
{
  "name": "Canopy AI",            // "" → SPA falls back to the default "ax"
  "logoType": "full" | "icon",    // full = logo includes wordmark; icon = show name beside it
  "light": { "blobId": "...", "contentType": "image/png" } | null,
  "dark":  { "blobId": "...", "contentType": "image/png" } | null,
  "version": "<ISO updatedAt>"    // cache-buster for logo URLs
}
```

- Logo **bytes** live in the blob store; this record holds only the pointer
  (`blobId` + `contentType`).
- Replacing or clearing a logo `blob:delete`s the previously-referenced blob so
  we don't leak orphaned blobs.
- `version` changes on every write so the SPA's `?v=` cache-buster fetches fresh
  logo bytes without us having to send no-cache headers.

---

## Wire surface

### `GET /api/branding` — public

```
200 → { name: string, logoType: 'full'|'icon', light: boolean, dark: boolean, version: string }
```

Returns defaults when nothing is stored (`name: ""`/treated as `ax`, `logoType:
'full'`, `light:false`, `dark:false`). Must succeed pre-auth and pre-bootstrap —
the login page and setup wizard read it. The SPA derives logo URLs as
`/api/branding/logo/light?v=<version>` etc.

### `GET /api/branding/logo/:variant` — public

`variant ∈ { light, dark }`. Streams the blob bytes with:

- `Content-Type` from the stored pointer.
- `Cache-Control: public, max-age=...` (safe because the URL is version-busted).
- Hardened headers for SVG (see Security).

`dark` returns **404** when no dark logo is stored — the SPA treats that as "no
dark variant" and applies the CSS-invert fallback.

### `PUT /admin/branding` — admin only

JSON body (admin auth via `auth:require-user` + `isAdmin`, plus the
`x-requested-with: ax-admin` CSRF posture matching the other admin routes):

```jsonc
{
  "name": "Canopy AI",                                   // optional
  "logoType": "full",                                    // optional
  "light": { "contentType": "image/png", "dataBase64": "..." } | null,  // null = clear
  "dark":  { "contentType": "image/svg+xml", "dataBase64": "..." } | null
}
```

- Body cap ~3 MB (covers two logos + name, base64-inflated).
- Per-logo decoded cap ~1 MB.
- Omitted fields are left unchanged; explicit `null` clears that logo.
- Validation: content-type allowlist, size cap, base64 decodes, **magic-byte
  sniff** confirming the bytes match the declared content-type.

Returns `204` on success.

---

## SPA rendering

### Branding context

`lib/branding.ts` (wire client + types) and a `BrandingProvider` React context,
fetched **once at app load**. While loading, `BrandMark` renders nothing (or a
neutral placeholder) to avoid flashing the default `ax` and then swapping.

### `BrandMark` rework (one source of truth)

`BrandMark` is already the single component used by all four sites. It is
reworked to consume the branding context:

- **No logo** → today's behavior: the dot + `name` (default `ax`).
- **Logo + `full`** → `<img>` only (theme variant; see Light/dark).
- **Logo + `icon`** → small square `<img>` + `name` text beside it.

The existing `size` prop (`md` sidebar / `xl` login) still controls scale; the
`<img>` is sized to match the wordmark height.

### Title + favicon

- `document.title` is set to `name` (default `ax`).
- **Favicon auto-generated client-side:** draw the current-theme logo `<img>`
  into a 64×64 square `<canvas>` (object-fit *contain* + transparent padding),
  `toDataURL('image/png')`, and set/replace `<link rel="icon">`. Regenerated when
  the theme changes (so the inverted/dark variant is reflected). Same-origin
  image ⇒ no canvas taint. When no logo is set, the favicon is left as the
  browser default (unchanged from today).

---

## Light/dark behavior

Theme is driven by `<html data-theme>` (existing `lib/theme.ts`, tri-state
`auto` / `light` / `dark`). The header reads the resolved theme:

- **Both logos set** → render the variant matching the active theme.
- **Only light set** → in dark mode, the header `<img>` is CSS-inverted
  (`filter: invert(1) hue-rotate(180deg)`); the favicon canvas applies the same
  inversion before export. Ideal for monochrome marks; multi-color logos should
  supply an explicit dark variant.

---

## Admin "Branding" tab

A new **admin-only** tab in `AdminSidebar` (`ADMIN_NAV`) + `AdminShell`, built
with shadcn primitives (via the `shadcn` skill). Contents:

- **Name** — text input.
- **Logo type** — radio: *Full logo (includes name)* vs *Icon only (show name
  beside)*.
- **Light logo** — file upload + preview on a light background.
- **Dark logo** — optional file upload + preview on a dark background, with the
  hint "leave empty to auto-invert the light logo."
- **Live preview** — the rendered header on both light and dark backgrounds, so
  the admin sees the result before saving.
- **Save** / **Clear** actions, with the existing save-state affordances
  (saving / ✓ Saved / error) used by `ModelConfigTab`.

The tab is gated on `isAdmin` both in the nav and in `AdminShell` (matching the
existing admin tabs — the server route is the real boundary, the nav gate is a
UX nicety).

---

## Security

New public routes + admin upload of untrusted image bytes. The
`security-checklist` skill is invoked during implementation; the known surface:

- **Upload validation (`PUT /admin/branding`):** content-type allowlist
  (`image/png`, `image/webp`, `image/jpeg`, `image/svg+xml`), per-logo size cap,
  base64-decode success, and a **magic-byte sniff** asserting the bytes match the
  declared type (so a script can't be stored as an "image").
- **SVG is the sharp edge.** Stored SVG is served from a same-origin URL, so a
  user navigating directly to `/api/branding/logo/light` would otherwise execute
  any embedded `<script>`. Mitigations: serve SVG with a locked-down
  `Content-Security-Policy` (e.g. `default-src 'none'; style-src 'unsafe-inline'`)
  + `X-Content-Type-Options: nosniff`, and render the logo **only via `<img>`**
  in the SPA (image context does not execute SVG scripts). The exact header set
  is finalized by the security-checklist pass.
- **Admin-only writes** behind `auth:require-user` + `isAdmin` + the
  `x-requested-with: ax-admin` CSRF posture used by the sibling admin routes.
- **Public reads** expose only branding (name + logo) — intended to be public.
  Responses are cacheable and version-busted.

---

## Wiring & the half-wired window

Per invariant #3 (no half-wired plugins), the **same PR**:

1. Adds `@ax/branding` to `presets/k8s/src/index.ts` (after a blob store + a
   storage plugin + the auth plugin + http-server in the topo order).
2. Updates the four preset plugin-list assertions:
   `presets/k8s/src/__tests__/{preset,acceptance,prod-bootstrap,multi-tenant-acceptance}.test.ts`.
3. Wires the SPA end-to-end: `BrandingProvider`, reworked `BrandMark`, title +
   favicon effects, and the admin Branding tab — reachable and tested.

No "wire it later" code merges.

## Testing

- **`@ax/branding` plugin:** unit tests for the route handlers — public GET
  defaults + populated, logo serve (content-type, 404 dark fallback, SVG
  hardened headers), admin PUT (auth gate, validation/magic-byte rejection, set /
  replace-deletes-old-blob / clear), body-size caps.
- **Preset:** the updated plugin-list assertions (the canary).
- **SPA:** `BrandMark` rendering across the matrix (no-logo / full / icon ×
  light / dark / dark-invert-fallback); favicon generation (canvas → link swap);
  branding fetch + provider; admin Branding tab (upload, preview, save, clear,
  validation surfacing).
- A canary path exercising the public `GET /api/branding` end-to-end so the
  plugin is reachable from the acceptance test (per invariant #3).

## Open implementation details (decided at plan time, not blocking)

- Exact favicon canvas size (64 vs 32/48 multi-size) and whether to also set
  `apple-touch-icon`.
- Whether to debounce favicon regeneration on theme flips.
- Precise SVG CSP header string (security-checklist output).
