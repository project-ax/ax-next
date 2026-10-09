---
name: AX
description: Figma-derived workspace system implemented with shared shadcn primitives.
colors:
  light-canvas: "hsl(216.00 17.24% 94.31%)"
  light-panel: "hsl(220.00 42.86% 98.63%)"
  light-card: "hsl(0.00 0.00% 100.00%)"
  light-foreground: "hsl(201.82 8.27% 26.08%)"
  light-muted-foreground: "hsl(201.18 8% 41%)"
  light-primary: "hsl(242.71 63.03% 58.63%)"
  light-primary-soft: "hsl(243.75 100.00% 96.86%)"
  light-action: "hsl(200.00 11.54% 10.20%)"
  light-action-foreground: "hsl(0.00 0.00% 100.00%)"
  light-brand: "hsl(244.09 57.14% 30.20%)"
  light-input: "hsl(245.14 100.00% 93.14%)"
  light-send: "hsl(242.71 63.03% 58.63%)"
  dark-canvas: "hsl(230.00 15.00% 7.84%)"
  dark-panel: "hsl(226.67 15.25% 11.57%)"
  dark-card: "hsl(226.15 14.94% 17.06%)"
  dark-foreground: "hsl(220.00 13.04% 90.98%)"
  dark-muted-foreground: "hsl(219.00 11.90% 67.06%)"
  dark-primary: "hsl(245.33 100.00% 82.35%)"
  dark-primary-soft: "hsl(246.92 25.49% 20.00%)"
  dark-action: "hsl(228.00 17.24% 94.31%)"
  dark-action-foreground: "hsl(200.00 11.54% 10.20%)"
  dark-brand: "hsl(248.11 100.00% 92.75%)"
  dark-input: "hsl(250.00 18.99% 30.98%)"
  dark-send: "hsl(250.86 50.00% 54.51%)"
typography:
  welcome:
    fontFamily: "Inter, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: "41px"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  navigation:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  control: "9px"
  panel: "16px"
  composer-well: "22px"
spacing:
  canvas-inset: "18px"
  panel-gap: "16px"
  sidebar-inset: "20px"
  composer-inset: "10px"
components:
  button-primary:
    backgroundColor: "{colors.light-action}"
    textColor: "{colors.light-action-foreground}"
    rounded: "{rounded.control}"
    height: "40px"
  navigation-active:
    backgroundColor: "{colors.light-primary-soft}"
    textColor: "{colors.light-primary}"
    rounded: "{rounded.control}"
  panel:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.panel}"
---
# Design System: AX

## Overview

The visual reference is [AX — A different kind of workspace](https://www.figma.com/design/yDka46zOpwgipUxTBWiXuo/?node-id=24-20), page `24:20`: light frame `24:36`, dark frame `31:9`, and the accompanying material notes. Extracted on October 8, 2026. The study uses quiet floating panels, a cool neutral canvas, restrained violet emphasis, and subtly raised controls.

The implementation lives in `packages/channel-web`. CSS custom properties in `src/index.css` are the runtime source of truth; `tailwind.config.ts` exposes them as semantic utilities. Frontmatter records the effective implementation values, including the accessibility adaptations below. All surfaces compose the existing shadcn primitives. The design reference supplies visual treatment; AX retains its current routes, permissions, conversation behavior, and operator branding.

Key characteristics:

- Cool layered surfaces in both light and dark themes.
- Inter typography, soft corners, and quiet shadows.
- Violet selection and Send; monochrome primary actions.
- Original AX mark and pearl orb exported from Figma.

## Colors

These are the reference values, mapped to AX's semantic roles:

| Role / CSS token | Figma light | Figma dark |
|---|---|---|
| Outer canvas / `--canvas` | `#EEF0F3` | `#111217` |
| Floating panel / `--background`, `--panel` | `#FAFBFD` | `#191B22` |
| Raised surface / `--card`, `--popover` | `#FFFFFF` | `#252832` |
| Main text / `--foreground` | `#3D4448` | `#E5E7EB` |
| Secondary text / `--muted-foreground` | `#657076` | `#A1A8B5` |
| Violet emphasis / `--primary` | `#5953D8` | `#ADA5FF` |
| Selected wash / `--primary-soft` | `#F0EFFF` | `#292640` |
| Primary action / `--action` | `#171B1D` | `#EEEFF3` |
| Action text / `--action-foreground` | `#FFFFFF` | `#171B1D` |
| Wordmark / `--brand` | `#272179` | `#DFDAFF` |
| Composer edge / `--input` | `#DFDCFF` | `#45405E` |

The implementation darkens light secondary text to `hsl(201.18 8% 41%)` so small text clears 4.5:1 on muted and canvas surfaces. Error and warning colors are AX extensions because the reference does not specify operational states. Error red is `hsl(0 60% 49%)` in light and `hsl(4 86% 66%)` in dark; both normal and hover treatments are covered by the contrast tests.

The dark Send fill uses `#6651C5` with white text, rather than the pale emphasis token. Keep `--send` separate from `--primary`; their foreground requirements differ. Primary-action buttons use `--action`, not the selection color. Hover, border, rule, message-bubble, and popover tokens are implementation extensions in `index.css`. Automatic theme and explicit light/dark overrides share the same values.

## Typography

Inter is the display, navigation, and body family, self-hosted in regular, medium, and semibold weights under `public/fonts`. The font license is included. IBM Plex Mono remains the existing code/technical-data font.

- Welcome title: 30px / 41px, semibold.
- Workspace wordmark: 29px, semibold; compact settings and authentication marks retain their existing size variants.
- Body: 15px, regular, 1.5 line-height.
- Navigation: 14px, regular; selected rows use medium weight.
- Section labels: 12px, regular, normal tracking and case.

Use the shared label and brand components so scale changes remain consistent. Operational tables may retain their existing compact text sizes.

## Layout

The reference desktop is 1440 × 960. AX uses 18px outer padding, a 16px panel gap, a 258px expanded sidebar, and 16px panel corners. Workspace and Settings share this frame. The collapsed sidebar and the agent details rail retain their existing behavior.

The reference composer is 820 × 220 inside an 840 × 240 well. AX uses a responsive, centered content column capped at 900px including its gutters; the inner composer has a 220px minimum height only for a confirmed empty, editable conversation. Active conversations and Today keep the compact composer. Approval, streaming, error, and past-conversation states retain their existing guards.

Below 768px, outer padding and panel gaps disappear, panels become full-screen, and navigation/details remain in their existing sheets. The welcome composer has a 164px minimum height and a 6px well inset. Interactive mobile controls retain at least 44px targets. These responsive choices adapt the desktop-only reference to AX's current mobile flows.

On tablets below 1024px, agent details use the existing sheet while the navigation sidebar stays inline. This leaves room for the conversation and its composer when both desktop side columns would squeeze them. Agent settings keep their existing 768px breakpoint. The welcome group centers only when it fits; shorter windows keep its beginning reachable through normal scrolling.

## Elevation & Depth

Depth combines tonal layering and diffuse shadows. Panels float slightly above the canvas; small action controls have a raised upper edge and short lower shadow. The composer has its own low-contrast violet well. Shadows are semantic tokens, with separate light/dark values.

- Panel: light `0 7px 18px hsl(222 18% 72% / 0.08)`; dark `0 7px 18px hsl(0 0% 0% / 0.22)`.
- Raised key: light `0 -1px 2px hsl(0 0% 100% / 0.85), 0 3px 7px hsl(220 18% 59% / 0.14)`; dark `0 -1px 1px hsl(0 0% 100% / 0.06), 0 3px 8px hsl(0 0% 0% / 0.42)`.
- Primary action, composer, and popover shadows extend this vocabulary through `--shadow-action`, `--shadow-composer`, and `--shadow-popover`.

## Shapes

Use 9px control corners, 16px panel/composer corners, and 22px well corners. The standard Tailwind `rounded-sm` and `rounded-lg` remain derived variants for existing compact and large controls. Borders use semantic `border-border` or `border-input`; the main floating panels rely on tone and shadow.

## Components

**Buttons.** The shared `Button` default variant uses monochrome action tokens. `secondary` and `outline` are subtly raised. `send` uses the dedicated violet fill. `navigation` provides the selected wash through `data-active`. Preserve visible focus rings and disabled behavior.

**Cards and fields.** `Card` uses the raised surface with panel corners and shadow. `Input` and `Textarea` use the card surface and input edge. Compose forms with existing shadcn field primitives.

**Navigation.** Workspace rows use the shared navigation variant. Settings rows use the same selected wash and emphasis through `SidebarRow`. Sidebar section labels are quiet and readable. Existing unread/status marks keep their semantics.

**Composer.** `ChatComposer` composes `InputGroup`, `InputGroupInput`, `InputGroupAddon`, and `Button`. The soft gradient well wraps a bordered surface with the small AX mark, attachment action, optional agent selector, and Send/Stop. Draft ownership, Enter submission, file selection, and Stop behavior stay with their existing callers.

**Brand and welcome artwork.** `AxDesignMark` chooses the original light/dark Figma SVG. `BrandMark` continues honoring operator-provided icon or full logos. The pearl orb is decorative and appears only in the confirmed empty conversation. SVG assets are in `src/assets/design`; asset provenance is recorded there.

**Motion.** Keep existing brief interaction transitions. Global reduced-motion preferences shorten transitions and animations and disable smooth scrolling.

## Do's and Don'ts

- Do compose the shared shadcn components in `packages/channel-web`.
- Do use semantic tokens for every surface, state, and foreground.
- Do keep canvas, panel, and raised surfaces distinct.
- Do preserve authentication, approval, error, focus-restoration, and streaming behavior when changing presentation.
- Don't replace operational state colors with brand colors.
- Don't add reference-only navigation or mock product behavior to the application.
- Don't load Inter remotely or reconstruct the exported mark/orb with approximate artwork.
