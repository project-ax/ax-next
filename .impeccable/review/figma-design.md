# Figma design application — October 8, 2026

Reference: AX Figma page `24:20`, light frame `24:36`, dark frame `31:9`. The extracted system is in the root `DESIGN.md`; runtime tokens are in `packages/channel-web/src/index.css`.

Applied through the existing shadcn installation: floating workspace/settings panels, Inter typography, semantic light/dark colors, monochrome primary actions, violet Send/selection, raised secondary controls, and the original AX SVG artwork. Login/setup use the same shared card and field system. Existing product actions, routes, state guards, and custom operator branding are preserved.

Validation:

- `pnpm --filter @ax/channel-web build`: passed (TypeScript and Vite). Vite still reports the existing large application-chunk warning.
- Frontend Vitest suite (`src/components`, `src/lib`, `src/__tests__`, excluding server tests): 232 files, 3,459 tests passed.
- ESLint on components, libraries, affected integration tests, and Tailwind configuration: passed.
- Extended contrast coverage includes canvas, primary-action, Send, and the actual Settings panel surface. Light secondary text and operational error colors were adjusted to pass the existing AA gates.
- Local Playwright checked 1440 × 960 light/dark and 390 × 844 mobile: no horizontal document overflow or uncaught page errors. Draft entry enables Send; Settings opens/closes, collapsed navigation fits, and the account menu switches themes correctly.

Browser checks use temporary API response fixtures against the actual SPA. They verify presentation and UI interaction, not live authentication or backend execution. Screenshots are local artifacts under `.playwright-mcp/figma-design/` (ignored by git). No preview fixtures were added to production code.

The Figma provides desktop studies. Mobile panel edges, composer sizing, and existing navigation sheets are AX adaptations. The small light-text contrast change is documented alongside the original source color in `DESIGN.md`.
