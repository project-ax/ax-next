/**
 * Every accent pair in both themes, measured against the WCAG AA floor.
 *
 * A browser walk found two buttons below it: "Just this once" on the permission
 * card at 3.75:1 and "Turn it off anyway" on the sign-in lockout dialog at
 * 3.40:1 — the two most consequential buttons in the product. Both were white
 * text on an accent that dark mode deliberately LIGHTENS (primary 42% -> 56%,
 * destructive 50% -> 62%), which moves the accent toward white and squeezes
 * the text on top of it. (Those are today's values. When the bug was found
 * they read 44% -> 52% and 55% -> 62%; #537 darkened light-mode destructive
 * and TASK-425 moved primary. The direction of travel is what matters here,
 * and it has not changed.)
 *
 * A screenshot will not tell you that, and neither will a reviewer — 3.4:1 red
 * with white text looks fine until you measure it. So this measures, the same
 * way the walk did.
 *
 * Two directions matter and they pull against each other, which is the whole
 * reason the bug was subtle:
 *
 *   - `bg-primary` / `bg-destructive` with their `*-foreground` on top. Wants a
 *     DARK accent (or a dark foreground).
 *   - `text-primary` / `text-destructive` on the page background, which is how
 *     `--destructive` is used 37 times. Wants a BRIGHT accent in dark mode.
 *
 * Satisfying one by moving the accent breaks the other. Hence the split fix:
 * dark mode pairs its bright accents with a near-black foreground (which
 * `--warning-foreground` had been doing all along), and light mode darkens
 * `--destructive` because there that single move lifts both roles at once.
 *
 * This test reads the real stylesheet rather than a copy of the numbers, so it
 * fails on any future token edit that drops a pair below the floor.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** WCAG 2.1 AA for normal-sized text. Every string measured here is body copy or a button label. */
const AA_NORMAL = 4.5;

/**
 * Pull one `{ ... }` block's custom properties, starting from a selector.
 * Brace-matched rather than regex'd to the closing brace, because the dark
 * block nests an `@media` inside it.
 */
function tokensAfter(selector: string): Map<string, string> {
  const at = CSS.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in index.css: ${selector}`);
  let i = CSS.indexOf('{', at);
  let depth = 0;
  const start = i;
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) break;
  }
  const body = CSS.slice(start, i);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** A colour resolved to sRGB 0-255. */
type Rgb = [number, number, number];

/**
 * Either a raw token value (`"211 100% 52%"`) or a colour already resolved to
 * sRGB — which is what an alpha-composited surface is, since no token holds it.
 */
type Colour = string | Rgb;

/** `"211 100% 52%"` (the bare triple Tailwind wraps in `hsl()`) -> sRGB 0-255. */
function hslTripleToRgb(triple: string): Rgb {
  const m = triple.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`not an hsl triple: ${triple}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const mm = l - c / 2;
  return [
    Math.round((r1 + mm) * 255),
    Math.round((g1 + mm) * 255),
    Math.round((b1 + mm) * 255),
  ];
}

function rgbOf(c: Colour): Rgb {
  return typeof c === 'string' ? hslTripleToRgb(c) : c;
}

/**
 * `fg` painted at `alpha` over the opaque `under` — what the browser actually
 * puts on screen for a Tailwind `bg-<token>/<pct>` class.
 *
 * Rounded to whole channels for the same reason `hslTripleToRgb` is: these
 * measurements are meant to agree with a browser probe, and a browser hands
 * `getComputedStyle` 8-bit channels. The rounding is worth at most 0.02 on a
 * ratio, which is why the numbers written down here read 5.03 where an
 * unrounded pass reads 5.05.
 *
 * `under` must be OPAQUE — one fractional layer over a solid one. That is a
 * limit of this helper, NOT a claim about the tree, and the difference matters
 * because the tree does stack: `ApprovalCard`'s action preview is
 * `bg-background/70` painted directly on the card's own `bg-warning-soft/40`,
 * with `text-muted-foreground` on top of it.
 *
 * That stack gets no row, and the reason is a margin rather than an absence —
 * but NOT because the layers agree. They pull opposite ways, and getting that
 * backwards is how someone talks themselves into trusting the wrong one.
 * Measured for `--muted-foreground` at each layer, bare -> tinted -> preview:
 *
 *   light                5.20 -> 5.03 -> 5.15
 *   dark on --background 6.14 -> 5.51 -> 5.95
 *   dark on --card       5.03 -> 4.66 -> 5.78
 *
 * The TINT LOWERS contrast every time — it drags the surface toward mid-grey,
 * which is the entire reason this section exists. What rescues the preview is
 * the layer on top of it: `bg-background/70` pulls 70% of the way back to the
 * page, an extreme, and overshoots past where the tint alone sat. So the
 * single-layer rows below are the tighter bound and the stack rides on their
 * margin. A stacked surface whose top layer is NOT an extreme could land the
 * other way and would need its own row — `composite()` already accepts a
 * resolved `Rgb` as `under`, so measuring one is a call, not a rewrite.
 */
function composite(fg: Colour, alpha: number, under: Colour): Rgb {
  const f = rgbOf(fg);
  const b = rgbOf(under);
  return [0, 1, 2].map((i) => Math.round(f[i]! * alpha + b[i]! * (1 - alpha))) as Rgb;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Colour, b: Colour): number {
  const la = luminance(rgbOf(a));
  const lb = luminance(rgbOf(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: ReadonlyArray<readonly [string, string]> = [
  ['light', ':root {'],
  // Both dark blocks must agree; they are the system fallback and the explicit
  // toggle. Checking each separately also catches the two drifting apart.
  ['dark (system fallback)', ":root[data-theme='dark'],"],
  ['dark (explicit toggle)', ":root[data-theme='dark'] {"],
];

/** Accent backgrounds and the foreground each one is always paired with. */
const ACCENT_PAIRS = [
  ['--primary', '--primary-foreground'],
  ['--destructive', '--destructive-foreground'],
  ['--warning', '--warning-foreground'],
  // The Download button on the Files tab is `variant="secondary"` (TASK-355),
  // which puts `--secondary-foreground` on `--secondary` as a real text pair.
  ['--secondary', '--secondary-foreground'],
] as const;

/** Accents that are ALSO used as text directly on a plain surface. */
const ACCENTS_USED_AS_TEXT = ['--primary', '--destructive', '--warning'] as const;

/**
 * An accent painted as text on its OWN tinted surface — `text-primary` on
 * `bg-primary-soft`, `text-destructive` on `bg-destructive-soft`.
 *
 * This is a THIRD direction, and nothing above measured it. `ACCENT_PAIRS`
 * measures the accent as a background under its `*-foreground`;
 * `ACCENTS_USED_AS_TEXT` measures it as text on a plain page or card. Neither
 * covers the accent as text on the *tint derived from itself*, which is the
 * lowest-contrast combination of the three by construction — both sides are the
 * same hue, so only the lightness gap does any work.
 *
 * TASK-425 is what surfaced it: `text-primary` on `bg-primary-soft` measured
 * **4.35:1 light / 4.28:1 dark**, under the floor, at four render sites — the
 * selected row in `WorkspaceSidebar`, `AgentFiles` and `AgentRail`, plus the
 * added-line row in `BundleDiffView`.
 *
 * Those two are this file's own formula. A browser probe read the light one as
 * 4.36; the gap is rounding, not disagreement, and it is worth keeping straight
 * about which number came from where.
 *
 * The fix was to move `--primary` (see the note in `index.css`), NOT
 * `--primary-soft`. That asymmetry is the part worth writing down, because the
 * soft token looks like the tempting thing to move and is the one that breaks:
 *
 *   - `--primary-soft`'s job is to be a VISIBLE selection tint, distinguishable
 *     from `--card` (the resting row) and `--muted` (the hover row). To fix the
 *     contrast from that side, light mode would need it at ~96.5% — LIGHTER
 *     than `--muted` at 96%, so the selected row would read as less emphasised
 *     than the merely-hovered one. Dark mode would need ~12%, within a point of
 *     `--card` at 11%, so the selected row would all but vanish on a card.
 *   - `--primary` has the opposite property: every one of its roles sits on the
 *     far side of it, so moving it AWAY from the surfaces lifts them all at
 *     once. Measured, 44% -> 42% light and 52% -> 56% dark: the defect pair
 *     4.35 -> 4.65 and 4.28 -> 4.73, and the three pairs that already passed
 *     improved too (`--primary-foreground` on `bg-primary` 4.97 -> 5.31 light
 *     and 4.72 -> 5.23 dark; `text-primary` on `--card` 4.97 -> 5.31 and
 *     4.58 -> 5.07). No role was traded away, so no role had to be split off.
 *
 * That is the opposite outcome to `--ink-ghost` below, where the roles pulled
 * against each other and the resolution WAS to split them. Which way a token
 * goes is a question to be measured, not assumed.
 *
 * `--warning` was withheld from this list by TASK-425 with its measurement
 * recorded here, and TASK-445 is the card that paid it off. It measured
 * **4.45:1 light** — this file's formula and the browser walk's probe agreeing
 * to three digits for once — on the `WorkspaceSidebar` count badge and the
 * `bits.tsx` "Waiting on you" badge.
 *
 * Both of those paint the tint SOLID, with no alpha, and that is the whole
 * reason this card survived contact and TASK-428's did not. TASK-428 reported
 * the same kind of number for the same token family, but the class it described
 * was `bg-warning-soft/40`; composited against what is behind it, that one was
 * already clear. A token reading is only the pixel when the paint is opaque.
 * Check which you have before believing the number.
 *
 * The fix was again to move the ACCENT, and the tint side was even less
 * available here than for `--primary`: darkening `--warning-soft` moves it
 * toward the accent and makes the text ratio WORSE (4.45 -> 4.08 at 85%), so
 * the only helpful direction is lighter, and by the time it clears with any
 * headroom (~97%) the held tint measures 1.04:1 against the white page — an
 * invisible badge in exchange for a readable one. `--warning` 36% -> 35% takes
 * the defect pair to **4.66:1 light**, and white on `bg-warning` and
 * `text-warning` on the page both go 4.84 -> 5.07 along with it. Dark measured
 * 8.47 throughout and did not move.
 */
const ACCENT_SOFT_PAIRS = [
  ['--primary', '--primary-soft'],
  ['--destructive', '--destructive-soft'],
  ['--warning', '--warning-soft'],
] as const;

/**
 * The plain surfaces those accents land on. `--card` is a SECOND surface, not
 * a synonym for `--background`: in light mode they happen to be the same white,
 * but dark mode lifts the card to `240 3% 11%` off a pure-black page. Anything
 * measured only against `--background` is therefore unmeasured on every card,
 * panel and chip in dark mode — which is most of the product.
 *
 * TASK-353 is what surfaced the gap: the workspace composer's attachment chip
 * puts `text-destructive` and `text-muted-foreground` on `bg-card`, and neither
 * pair was covered here. Currently: destructive 5.14 light / 5.06 dark,
 * muted-foreground 5.20 / 5.03, primary 4.97 / 4.58, warning 4.84 / 10.38. All
 * clear, and now they stay that way by test rather than by luck. (Light
 * muted-foreground read 4.83 when this note was written; TASK-380 darkened the
 * token to 44% and lifted it, which is the whole point of measuring here.)
 */
const PLAIN_SURFACES = ['--background', '--card'] as const;

/**
 * Body copy that is deliberately quiet. It is still text a person has to read
 * — "Ready to send" on an upload chip, every timestamp, every hint line — so
 * it answers to the same AA floor as anything else, and it is the token most
 * likely to be nudged lighter by someone chasing a calmer look.
 */
const QUIET_TEXT = '--muted-foreground';

/**
 * The opaque surfaces the quiet text is painted on — a SUPERSET of
 * `PLAIN_SURFACES`, and the two lists must NOT be collapsed into one.
 * `PLAIN_SURFACES` is the list the ACCENTS land on, and it stops at the page
 * and the card because that is where `text-primary` / `text-destructive` /
 * `text-warning` are actually used. `--muted-foreground` goes further: it is
 * also the text on a FILLED chip. Merging the lists would start asserting
 * `--warning` on `--muted` — a pairing that exists nowhere in the tree and
 * that measures 4.40:1, so the merge fails the suite on a fiction.
 *
 * `--muted` is what TASK-380 was: `text-muted-foreground` on `bg-muted`
 * measured 4.40:1 in light mode in a real browser — under the floor, and
 * unmeasured here because `--muted` was in neither list. It is not a rare
 * pairing, and it is not decorative: five sites render it as text a person
 * has to read — the Steps trigger in `AgentConversation`, every INACTIVE
 * `TabsTrigger` (`TabsList` sets the pair and only `data-[state=active]`
 * overrides it, so this is every tab strip in the product), the Routines
 * `TriggerChip`, the Thread search-results banner, and the admin `RoleCard`
 * pill. (`StatusChip` and the attachment/artifact icon tiles also carry the
 * pair, but they render a glyph — an em dash, an icon — and answer to the 3:1
 * non-text floor instead.)
 *
 * `--popover` carries `CommandGroup`'s `[cmdk-group-heading]` rule and
 * `CommandShortcut`, both inside `Command`'s `bg-popover` root. It holds the
 * same value as `--card` in both themes today; it is a separate token that can
 * drift, which is the same argument that put `--card` here.
 *
 * Deliberately NOT here, so the next person does not have to re-grep:
 *
 *   - `--secondary` — no `text-muted-foreground` pairing exists in the tree.
 *   - `--accent` — the one that does is `DialogClose`, whose only visible child
 *     is an `X` glyph (the label beside it is `sr-only`), so it answers to the
 *     3:1 non-text floor.
 *
 * Both currently hold the SAME value as `--muted` in either theme, so the
 * `--muted` row is already measuring their numbers. If either is ever given a
 * value of its own AND picks up readable quiet text, it needs its own row —
 * that divergence is exactly what caught `--card` out in TASK-353.
 *
 * Fractional variants (`bg-muted/60`, `bg-muted/30`, …) get no row of their
 * own: alpha-blending puts the effective surface strictly between `--muted`
 * and whatever is behind it, so the solid row bounds one end of every one of
 * them. If a fractional muted is ever layered over a surface that is NOT in
 * this list, that surface needs its own row.
 *
 * That argument covers fractional MUTED only, so one case sits outside every
 * list here: `ApprovalCard`'s `bg-warning-soft/40` holds `text-muted-foreground`.
 * It passes — and it now has rows of its own at the foot of this file rather
 * than a paragraph saying so, because "measured once, written down, enforced by
 * nobody" is how the number goes stale. See `ApprovalCard's tinted surface`.
 *
 * It passes only BECAUSE it is fractional, which is the part worth writing
 * down: quiet text on a SOLID `bg-warning-soft` measures **4.10:1** in dark
 * mode, under the floor. Nothing renders that today — the solid `-soft`
 * surfaces carry their own accent text, not the quiet token. But a `-soft`
 * surface is the likeliest next place this defect appears, which is why the
 * section below reads the alpha out of the component instead of trusting it.
 * (For the record, solid light: warning-soft 4.78, destructive-soft 4.63,
 * primary-soft 4.54. Dark: 4.10 / 4.61 / 4.69. Those are this file's own
 * formula; the slightly higher figures this note used to carry came from an
 * unrounded pass.)
 */
const QUIET_TEXT_SURFACES = ['--background', '--card', '--popover', '--muted'] as const;

/**
 * One entry per `it` the quiet-text loop registers, appended at COLLECTION
 * time. Read by the dropped-loop guard at the bottom of the file — see the
 * comment there for why a constant-only check is not enough.
 */
const quietTextCasesRegistered: string[] = [];

describe('theme contrast', () => {
  for (const [name, selector] of THEMES) {
    describe(name, () => {
      const tokens = tokensAfter(selector);

      for (const [bg, fg] of ACCENT_PAIRS) {
        it(`${fg} on ${bg} clears AA`, () => {
          const bgv = tokens.get(bg);
          const fgv = tokens.get(fg);
          expect(bgv, `${bg} missing from ${selector}`).toBeDefined();
          expect(fgv, `${fg} missing from ${selector}`).toBeDefined();
          expect(contrast(bgv!, fgv!)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }

      for (const [accent, soft] of ACCENT_SOFT_PAIRS) {
        it(`${accent} as text on ${soft} clears AA`, () => {
          const accentV = tokens.get(accent);
          const softV = tokens.get(soft);
          expect(accentV, `${accent} missing from ${selector}`).toBeDefined();
          expect(softV, `${soft} missing from ${selector}`).toBeDefined();
          expect(contrast(accentV!, softV!)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }

      for (const surface of PLAIN_SURFACES) {
        for (const accent of ACCENTS_USED_AS_TEXT) {
          it(`${accent} as text on ${surface} clears AA`, () => {
            const accentV = tokens.get(accent);
            const bgV = tokens.get(surface);
            expect(accentV, `${accent} missing from ${selector}`).toBeDefined();
            expect(bgV, `${surface} missing from ${selector}`).toBeDefined();
            expect(contrast(accentV!, bgV!)).toBeGreaterThanOrEqual(AA_NORMAL);
          });
        }
      }

      for (const surface of QUIET_TEXT_SURFACES) {
        quietTextCasesRegistered.push(`${name}:${surface}`);
        it(`${QUIET_TEXT} as text on ${surface} clears AA`, () => {
          const quietV = tokens.get(QUIET_TEXT);
          const bgV = tokens.get(surface);
          expect(quietV, `${QUIET_TEXT} missing from ${selector}`).toBeDefined();
          expect(bgV, `${surface} missing from ${selector}`).toBeDefined();
          expect(contrast(quietV!, bgV!)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    });
  }

  /**
   * Guards the conversion itself. If `hslTripleToRgb` ever went wrong, every
   * assertion above could pass on nonsense, so pin two known values: white on
   * black is the theoretical maximum, and a colour against itself is 1:1.
   */
  it('measures known values correctly', () => {
    expect(contrast('0 0% 100%', '0 0% 0%')).toBeCloseTo(21, 1);
    expect(contrast('211 100% 52%', '211 100% 52%')).toBeCloseTo(1, 5);
  });

  /**
   * `QUIET_TEXT_SURFACES`'s comment calls it a superset of `PLAIN_SURFACES`.
   * That sentence is the kind of thing nothing checks, so check it: a surface
   * added to `PLAIN_SURFACES` alone would leave the quiet text unmeasured on
   * it, which is TASK-380 happening again one token over.
   *
   * Note what this does NOT cover, because the two constants are all it reads:
   * a merge that reverts the quiet-text loop to `PLAIN_SURFACES` and leaves
   * `QUIET_TEXT_SURFACES` defined-but-unused passes this cleanly. That is the
   * dropped-loop hazard, and the case below is the one that catches it.
   */
  it('measures the quiet text on every surface the accents are measured on', () => {
    for (const surface of PLAIN_SURFACES) {
      expect(QUIET_TEXT_SURFACES, `${surface} is measured for the accents but not for ${QUIET_TEXT}`)
        .toContain(surface);
    }
  });

  /**
   * The dropped-loop guard. This file is a known auto-merge collision point,
   * and a clean merge here has already once kept both constant lists while
   * silently dropping a loop — which reads as green because the assertions
   * that vanished leave no trace.
   *
   * So assert what the loop actually REGISTERED, not what the constants say.
   * `quietTextCasesRegistered` is appended to at collection time, one entry
   * per `it` the quiet-text loop creates, so this fails if that loop is
   * removed, duplicated, or pointed at the wrong list — each of which silently
   * un-measures a surface today.
   */
  it('registers one quiet-text case per theme per surface', () => {
    const expected = THEMES.flatMap(([name]) =>
      QUIET_TEXT_SURFACES.map((surface) => `${name}:${surface}`),
    );
    expect(quietTextCasesRegistered).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * `--ink-ghost` — a fill, never ink.
 * ------------------------------------------------------------------------- */

/**
 * The one palette token that does not clear the text floor, and must not try.
 *
 * Four independent browser probes measured it as text: 1.72:1 in light, 2.04:1
 * in dark — roughly a THIRD of the AA floor, on copy people are meant to read.
 * Against the surfaces the page actually paints it on it is worse still: 1.57:1
 * on light `--muted`, 1.67:1 on dark `--card`. Those two never showed up in a
 * probe because the probes measured the page background.
 *
 * The obvious fix does not work, and it is worth writing down why so nobody
 * spends another afternoon on it. To clear 4.5:1 on every surface it lands on,
 * `--ink-ghost` would have to become ~46% lightness in light mode and ~53% in
 * dark. `--muted-foreground` is already 44% and 56%. Two tokens, two or three
 * percentage points apart, one colour — which is invariant 4 with a paint
 * swatch on it.
 *
 * And it would break the token's OTHER job. `--ink-ghost` is also a fill:
 *
 *   - `Composer.tsx` — the send circle's INACTIVE state. A `:has()` rule flips
 *     it to `bg-primary` the moment the field has content, so the faintness is
 *     the affordance: it is how the button says "nothing to send yet".
 *
 * That is now the ONLY thing it fills. It used to fill the state dots too —
 * `bits.tsx` `StateDot`'s `resting`, and `StatusDot.tsx`'s admin `empty` and
 * `pending` — and TASK-450 moved those to `--state-quiet`, because a dot that
 * carries information owes 3:1 and an inactive control does not. See the
 * non-text section at the foot of this file.
 *
 * A mid-grey send circle reads as enabled. Moving the value satisfies the text
 * role by destroying the fill role.
 *
 * That tension is not new here — it is the same one this file already documents
 * for `--primary` and `--destructive`, where an accent is also a foreground and
 * moving it fixes one role and breaks the other. The resolution there was to
 * split the roles rather than average them, and it is the resolution here:
 * `--ink-ghost` keeps its value and becomes background-only. Quiet text is
 * `--muted-foreground`, which is measured above and clears AA everywhere.
 *
 * `AgentMenu.tsx` had already reached this conclusion for one component, with a
 * comment saying so. This generalises it, and enforces it, because Tailwind
 * generates `text-ink-ghost` from the same colour entry as `bg-ink-ghost` and
 * there is no way to publish one without the other.
 *
 * The fill sites used to be out of scope here, and are not any more. A dot's fill
 * carries its state (alongside its shape, since TASK-485), which makes the
 * `resting` dot an information-bearing non-text element owing 3:1 under WCAG 1.4.11 — and on this token it
 * measured 1.72:1 light / 1.67:1 dark on the page and a card (1.50 / 1.56 on
 * the selected row's `--primary-soft`), so it did not clear that either. That
 * was TASK-450, and the fix was the same split one level down: the dots took a
 * new token and the send circle kept this one. The 3:1 floor now has its own
 * section at the foot of this file; everything in THIS block still bounds the
 * 4.5:1 TEXT floor, which is a different number for a different reason.
 */
const INK_GHOST = '--ink-ghost';

/** The Tailwind class the token publishes as text. */
const INK_GHOST_TEXT_CLASS = 'text-ink-ghost';

const SRC_ROOT = join(__dirname, '..');

/**
 * Comments are not rendered classes. `AgentMenu.tsx` names `text-ink-ghost` in
 * prose precisely to explain why it does not use it, and that sentence is worth
 * more than the false positive it would otherwise cost.
 *
 * A block comment is recognised ONLY where one opens a line (after optional
 * whitespace and a JSX `{`). That restriction is the entire point of this
 * function, so do not "simplify" it back to a file-wide
 * `src.replace(/\/\*[\s\S]*?\*\//g, '')`:
 *
 * **A bare `/` followed by `*` occurs in ordinary code in this tree.** Route
 * paths like `'/api/workspace/agents/:agentId/files/*'` contain one, and
 * `routines/*.md` is rendered as JSX text. A file-wide strip pairs that
 * accidental opener with the next real `*​/` anywhere below it and deletes
 * everything in between — including a real `text-ink-ghost` — leaving the guard
 * silently green. That is not hypothetical: it was caught in review, with a
 * working repro, on the first version of this file.
 *
 * Anchoring to the line start cannot see those, so the only way this errs now
 * is by KEEPING comment text, which trips the guard loudly instead of
 * silencing it. Wrong in the safe direction, on purpose.
 *
 * Residual gap, stated rather than hidden, and wider than the obvious one.
 * This is line-oriented, so it cannot tell that a line is inside a multi-line
 * STRING. Any line whose first non-whitespace is `/`+`*`, `*`, or `//` is
 * treated as comment syntax even when it is string content — all three were
 * demonstrated in review, and all three hide a usage rather than surfacing it.
 * Nothing in the tree has that shape, and `mentions every file that names the
 * class` below is the backstop that would catch it anyway.
 */
function stripComments(src: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      inBlock = false;
      kept.push(line.slice(close + 2)); // keep real code trailing the close
      continue;
    }
    const opener = line.match(/^\s*\{?\s*\/\*/);
    if (opener !== null) {
      const rest = line.slice(opener[0].length);
      const close = rest.indexOf('*/');
      if (close === -1) {
        inBlock = true;
        continue;
      }
      kept.push(rest.slice(close + 2));
      continue;
    }
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Does this source file paint `cls`, ignoring anything said about it in prose? */
function paints(src: string, cls: string): boolean {
  return new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(stripComments(src));
}

/**
 * Every file Tailwind compiles classes out of. `tailwind.config.ts` globs
 * `['./index.html', './src/**\/*.{ts,tsx}']`, so `index.html` is a real usage
 * site and is scanned too — a class parked there would be live and invisible to
 * a scan that stopped at `src/`. CSS is included as well, since a token can be
 * applied through an `@apply` rule rather than a className.
 *
 * Tests are excluded on purpose: `AgentMenu.test.tsx` asserts the class is
 * ABSENT, so scanning it would make the guard trip on its own enforcement.
 * Nothing under `__tests__` renders production UI.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function sourceFiles(): string[] {
  return [...walk(SRC_ROOT), join(SRC_ROOT, '..', 'index.html')];
}

/** Relative paths of every shipped file painting `cls`, sorted. */
function filesPainting(cls: string): string[] {
  return sourceFiles()
    .filter((path) => paints(readFileSync(path, 'utf8'), cls))
    .map((path) => relative(SRC_ROOT, path))
    .sort();
}

/** Same walk, but on the RAW text — comments included. See the backstop below. */
function filesMentioning(cls: string): string[] {
  const re = new RegExp(`(?<![\\w-])${cls}(?![\\w-])`);
  return sourceFiles()
    .filter((path) => re.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC_ROOT, path))
    .sort();
}

const INK_GHOST_TEXT_SITES = filesPainting(INK_GHOST_TEXT_CLASS);

describe('--ink-ghost is a fill, never ink', () => {
  for (const [name, selector] of THEMES) {
    it(`${name}: measures under the text floor, so nothing may paint it as text`, () => {
      const tokens = tokensAfter(selector);
      const ghost = tokens.get(INK_GHOST);
      expect(ghost, `${INK_GHOST} missing from ${selector}`).toBeDefined();

      const measured = QUIET_TEXT_SURFACES.map((surface) => {
        const bg = tokens.get(surface);
        expect(bg, `${surface} missing from ${selector}`).toBeDefined();
        return [surface, contrast(ghost!, bg!)] as const;
      });
      const readout = measured.map(([s, c]) => `${s} ${c.toFixed(2)}:1`).join(', ');
      const worst = Math.min(...measured.map(([, c]) => c));

      // Pins the premise. If someone later lifts `--ink-ghost` to AA, this trips
      // and they have to come back and re-read the fill-vs-ink argument above —
      // rather than inherit a usage ban whose entire justification has quietly
      // evaporated underneath it.
      expect(
        worst,
        `${INK_GHOST} now clears AA in ${name} (${readout}) — re-read the fill-vs-ink note above before relaxing anything`,
      ).toBeLessThan(AA_NORMAL);

      expect(
        INK_GHOST_TEXT_SITES,
        `${INK_GHOST} is ${readout} in ${name} — AA needs ${AA_NORMAL}:1. ` +
          `Use \`text-muted-foreground\` for quiet copy. These files paint it as text:\n  ` +
          INK_GHOST_TEXT_SITES.join('\n  '),
      ).toEqual([]);
    });
  }

  /**
   * Anti-vacuity, part one. The assertion above is `toEqual([])`, which is also
   * exactly what a scanner that walked the wrong directory, matched nothing, or
   * stripped the whole file would produce. An empty result is the SAME shape as
   * a clean result, so prove the scanner can see real classes in the real tree
   * before believing it about the absent one.
   */
  it('the source scan can see the tree it is asserting about', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('index.css'))).toBe(true);

    // The replacement token, in the same `text-*` shape the guard looks for.
    // If the matcher or the walk is broken, this reads 0 and fails here rather
    // than passing silently one assertion up.
    expect(filesPainting('text-muted-foreground').length).toBeGreaterThan(10);

    // And the fill site is still there — the guard bans the token as TEXT, not
    // as a background. A sweep that deleted `--ink-ghost` outright would
    // satisfy the ban and lose the affordance; this notices.
    //
    // Pinned as a SET rather than a count, and the set is now exactly one file.
    // Before TASK-450 this was `>= 3` and the other two were the state dots; a
    // count would have gone on passing while they drifted back, which is the
    // regression this list exists to make loud. `Composer.tsx` is the send
    // circle, an inactive control — the one role that is meant to keep a token
    // this faint. Anything else appearing here is a dot that skipped the 3:1
    // floor, and belongs on `--state-quiet` instead.
    expect(filesPainting('bg-ink-ghost')).toEqual(['components/Composer.tsx']);
  });

  /**
   * Anti-vacuity, part two: pin `paints` on a fixture, both directions. The
   * comment-stripping is the part that can only ever hide a real usage, so a
   * silent over-strip would make the guard permanently green. Assert it keeps
   * code AND drops prose — and that it does not match a longer class that
   * merely starts the same way.
   */
  it('reads code and ignores comments', () => {
    expect(paints('<span className="text-ink-ghost" />', INK_GHOST_TEXT_CLASS)).toBe(true);
    expect(paints("  'uppercase text-ink-ghost mt-1.5';", INK_GHOST_TEXT_CLASS)).toBe(true);
    expect(paints('{/* not `text-ink-ghost`, which is too faint */}', INK_GHOST_TEXT_CLASS)).toBe(
      false,
    );
    expect(paints('// avoid text-ink-ghost here', INK_GHOST_TEXT_CLASS)).toBe(false);
    expect(paints(' * uses text-ink-ghost for the label', INK_GHOST_TEXT_CLASS)).toBe(false);
    expect(paints('<span className="bg-ink-ghost" />', INK_GHOST_TEXT_CLASS)).toBe(false);
    expect(paints('<span className="text-ink-ghostly" />', INK_GHOST_TEXT_CLASS)).toBe(false);

    // A multi-line block comment is still stripped, and real code on the
    // closing line survives it.
    const block = [
      '  /**',
      '   * `text-ink-ghost` is too faint to read.',
      '   */',
      '  const x = 1;',
    ].join('\n');
    expect(paints(block, INK_GHOST_TEXT_CLASS)).toBe(false);
    expect(paints(['  /* note */ <b className="text-ink-ghost" />'].join('\n'), INK_GHOST_TEXT_CLASS)).toBe(
      true,
    );
  });

  /**
   * The regression that review caught, kept as a fixture because the bug is
   * invisible: it made the guard PASS.
   *
   * The first version of `stripComments` did a file-wide
   * `replace(/\/\*[\s\S]*?\*\//g, '')`. A bare `/` + `*` in ordinary code —
   * a route path like `'…/files/*'`, or `routines/*.md` rendered as JSX text,
   * both of which are live in this tree — was read as an opening delimiter and
   * paired with the next real close far below, deleting a real class in
   * between. Green suite, unguarded token.
   *
   * These are the reviewer's exact repro shapes. Case C is the control: if it
   * ever goes false, the scanner is broken in the loud direction instead.
   */
  it('does not let a stray slash-star in code swallow a real usage', () => {
    const caseA = [
      '      <code>.ax/routines/*.md</code>',
      '      <span className="text-ink-ghost">{row.source}</span>',
      '      {/* a later block comment, whose close pairs with the text above */}',
    ].join('\n');
    expect(paints(caseA, INK_GHOST_TEXT_CLASS)).toBe(true);

    const caseB = [
      "      const rx = /\\/api\\/workspace\\/agents\\/:id\\/files\\/*/;",
      '      <span className="text-ink-ghost" />',
      '      {/* trailing comment */}',
    ].join('\n');
    expect(paints(caseB, INK_GHOST_TEXT_CLASS)).toBe(true);

    const caseC = '<span className="text-ink-ghost" />';
    expect(paints(caseC, INK_GHOST_TEXT_CLASS)).toBe(true);
  });

  /**
   * The backstop that makes a silent hide impossible.
   *
   * `filesPainting` strips comments, and stripping is the one operation that
   * can only ever LOSE a usage. So also scan the RAW text and pin the complete
   * set of files that so much as name the class. The two checks cover each
   * other: if stripping ever hides a real usage, the file still shows up here
   * and is not on the list; if someone adds a real class to a file that is on
   * the list, `filesPainting` catches it, because a className is not inside a
   * line-opening block comment.
   *
   * Both entries below are prose EXPLAINING why the class is not used — the
   * `AgentMenu` note that reached this conclusion first, and the token's own
   * comment in the stylesheet. If you are adding to this list, you are almost
   * certainly meant to be deleting a usage instead.
   *
   * The mutual coverage has one bounded blind spot, named here so it is not
   * mistaken for total: a usage that is BOTH hidden by one of `stripComments`'
   * residual gaps AND located in one of the two allow-listed files would
   * escape both checks — stripped out of the first, and forgiven by the second
   * because the file is expected. It needs a multi-line string of exactly the
   * wrong shape inside `AgentMenu.tsx` or `index.css`; neither has one. Every
   * other file in the tree is covered by one check or the other.
   *
   * Note the scope this trades against: `walk()` matches only `ts`/`tsx`/`css`
   * plus `index.html`, so design docs and `.md` files are exempt and do not
   * trip this. Inside those file types a future prose mention WILL fail the
   * suite. That friction is deliberate for a hard-banned token — it forces the
   * mention to be a decision rather than a drive-by.
   */
  it('mentions every file that names the class, prose included', () => {
    expect(filesMentioning(INK_GHOST_TEXT_CLASS)).toEqual([
      'components/AgentMenu.tsx',
      'index.css',
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * `--state-quiet` — also a fill, never ink (TASK-484).
 * ------------------------------------------------------------------------- */

/**
 * The same ban as `--ink-ghost` above, for the token TASK-450 split off it.
 *
 * `--state-quiet` was tuned to clear the 3:1 NON-text floor for the state dots
 * (see the non-text section at the foot of this file), and it does — but 3:1 is
 * not the text floor. As text it measures 3.66:1 on the light page and 3.33:1 on
 * light `--muted`, 3.41:1 on a dark card: every surface, both themes, under 4.5.
 * And Tailwind publishes `text-state-quiet` from the same colour entry as
 * `bg-state-quiet`, exactly as it does for `text-ink-ghost`. Symmetric risk; so,
 * symmetric guard.
 *
 * There was no violation when this was written. It is here so the first one
 * fails a test instead of shipping — a dot token looks like a reasonable colour
 * for a quiet label, which is precisely the mistake the `--ink-ghost` section
 * exists to stop one token over.
 *
 * It reuses that section's scanner (`filesPainting`, `filesMentioning`,
 * `stripComments`), so the anti-vacuity work there — the stray-slash-star
 * fixtures, the tree-visibility check — covers this too. What it adds is what is
 * specific to THIS class: the premise pin, the usage ban, the matcher pinned on
 * this class's own spelling, and the raw-mention backstop.
 */
const STATE_QUIET = '--state-quiet';

/** The Tailwind class the token publishes as text. */
const STATE_QUIET_TEXT_CLASS = 'text-state-quiet';

const STATE_QUIET_TEXT_SITES = filesPainting(STATE_QUIET_TEXT_CLASS);

describe('--state-quiet is a fill, never ink', () => {
  for (const [name, selector] of THEMES) {
    it(`${name}: measures under the text floor, so nothing may paint it as text`, () => {
      const tokens = tokensAfter(selector);
      const quiet = tokens.get(STATE_QUIET);
      expect(quiet, `${STATE_QUIET} missing from ${selector}`).toBeDefined();

      const measured = QUIET_TEXT_SURFACES.map((surface) => {
        const bg = tokens.get(surface);
        expect(bg, `${surface} missing from ${selector}`).toBeDefined();
        return [surface, contrast(quiet!, bg!)] as const;
      });
      const readout = measured.map(([s, c]) => `${s} ${c.toFixed(2)}:1`).join(', ');
      const worst = Math.min(...measured.map(([, c]) => c));

      // Pins the premise, as the `--ink-ghost` block does. If `--state-quiet`
      // is ever lifted to AA this trips, and whoever did it re-reads why the
      // dot token sits BELOW `--muted-foreground` on purpose (the "quieter than
      // the quiet text" ordering at the foot of this file) before relaxing a ban
      // whose reason has gone.
      expect(
        worst,
        `${STATE_QUIET} now clears AA in ${name} (${readout}) — re-read the note above before relaxing anything`,
      ).toBeLessThan(AA_NORMAL);

      expect(
        STATE_QUIET_TEXT_SITES,
        `${STATE_QUIET} is ${readout} in ${name} — AA needs ${AA_NORMAL}:1, and 3:1 is the ` +
          `floor for dots, not words. Use \`text-muted-foreground\` for quiet copy. ` +
          `These files paint it as text:\n  ` +
          STATE_QUIET_TEXT_SITES.join('\n  '),
      ).toEqual([]);
    });
  }

  /**
   * Anti-vacuity for this class's spelling. The shared scanner is proven in the
   * `--ink-ghost` block; what is not proven there is that the matcher sees
   * `text-state-quiet` in the shapes it would really arrive in — a variant
   * prefix, an opacity suffix — and does not confuse it with the fill.
   */
  it('reads this class in code, and not the fill or a longer name', () => {
    expect(paints('<span className="text-state-quiet" />', STATE_QUIET_TEXT_CLASS)).toBe(true);
    expect(paints("  'text-xs hover:text-state-quiet',", STATE_QUIET_TEXT_CLASS)).toBe(true);
    expect(paints('<i className="text-state-quiet/80" />', STATE_QUIET_TEXT_CLASS)).toBe(true);
    expect(paints('<span className="bg-state-quiet" />', STATE_QUIET_TEXT_CLASS)).toBe(false);
    expect(paints('<span className="text-state-quieter" />', STATE_QUIET_TEXT_CLASS)).toBe(false);
    expect(paints('// never text-state-quiet', STATE_QUIET_TEXT_CLASS)).toBe(false);

    // And the fill is really in the tree, so the empty result above is a scan
    // that looked at live users of this token and found no text among them —
    // not a scan of a token nobody uses.
    expect(filesPainting('bg-state-quiet')).toEqual(
      expect.arrayContaining(['components/admin/StatusDot.tsx', 'components/workspace/bits.tsx']),
    );
  });

  /**
   * The raw-text backstop, for the same reason as the `--ink-ghost` one: comment
   * stripping can only ever LOSE a usage, so pin every file that so much as names
   * the class. The one entry is the token's own note in the stylesheet saying
   * not to use it.
   */
  it('mentions every file that names the class, prose included', () => {
    expect(filesMentioning(STATE_QUIET_TEXT_CLASS)).toEqual(['index.css']);
  });
});

/* ------------------------------------------------------------------------- *
 * Is `ACCENT_SOFT_PAIRS` complete? — the question that cost TASK-445.
 * ------------------------------------------------------------------------- */

/**
 * `ACCENT_SOFT_PAIRS` is a hand-maintained list, and a hand-maintained list of
 * things-to-check fails in one direction: silently, by omission. That is not a
 * hypothetical here. `--warning` was missing from it for the entire life of the
 * list, the pairing it describes rendered at two sites the whole time, and it
 * measured 4.45:1. The list did not go wrong — it was never asked whether it
 * was finished.
 *
 * So ask. Derive the accent families from `tailwind.config.ts` (whatever
 * publishes a `hsl(var(--<family>-soft))`), scan the shipped tree for files
 * that paint `bg-<family>-soft` alongside `text-<family>`, and require the pair
 * to be measured above.
 *
 * **Which direction does this fail in?** Closed, deliberately, at three points:
 *
 *   - It is FILE-level, not element-level. A file painting the tint on one
 *     element and the accent text on another is flagged even if the two never
 *     meet. Within a file that is a superset of the real pairings, so it cannot
 *     miss one, and the cost of a false flag is a measurement someone takes
 *     once and a row that then passes forever. An element-level parse would be
 *     the tighter answer and the one that can be wrong quietly; this is the
 *     other trade.
 *
 *     State the residual gap rather than hide it, the way the rest of this file
 *     does: the guarantee is co-location, NOT existence. A pairing assembled
 *     across two files — a parent painting `bg-<f>-soft` and a child painting
 *     `text-<f>`, meeting only in the DOM — co-locates nowhere and is exempted
 *     by the zero-sites case below. Tailwind forces each class to appear
 *     literally somewhere, which is what makes the scan possible at all, but it
 *     does not force them to appear TOGETHER. Every pairing in the tree today
 *     co-locates, and the two anchors pin the one this card is about; a split
 *     pairing is the shape to watch for, and the honest answer if one appears
 *     is to widen the scan, not to trust this sentence.
 *
 *     The same coarseness bites the other way: a file using the tint and the
 *     accent text on unrelated elements is forced to add a row for a pairing
 *     that never renders. Adding a PASSING row costs nothing. If such a
 *     fictional row ever FAILS, the fix is to confirm it is fiction and narrow
 *     the scan — not to bolt on an exemption, which is how the list got a hole
 *     in the first place.
 *   - There is NO alpha exemption. `paints` matches `bg-warning-soft/40` as
 *     readily as the solid class, so a fractional tint still demands its row.
 *     The temptation is to skip fractional paints on the grounds that the solid
 *     number does not describe them — true, and exactly backwards as a rule:
 *     the exemption would be keyed on a SHAPE, and every future unmeasured
 *     pairing could wear that shape. `ApprovalCard` is the precedent for what
 *     to do instead — measure the composited pixel, in its own block below.
 *   - The one exemption that does exist — a family no file paints as text —
 *     is the case where there is genuinely nothing to measure, and it is the
 *     one an empty scan would forge. So the scan is anchored: the family this
 *     card is about has its sites pinned by name, and a scan that stopped
 *     seeing the tree fails there instead of quietly exempting everything.
 */
const TAILWIND_CONFIG = readFileSync(join(SRC_ROOT, '..', 'tailwind.config.ts'), 'utf8');

/** Accent families tailwind publishes a `-soft` tint for, e.g. `warning`. */
const SOFT_FAMILIES = [
  ...new Set(
    [...TAILWIND_CONFIG.matchAll(/hsl\(var\(--([\w-]+)-soft\)\)/g)].map((m) => m[1]!),
  ),
].sort();

/** Shipped files painting both `bg-<family>-soft` and `text-<family>`. */
function softTextSites(family: string): string[] {
  return sourceFiles()
    .filter((path) => {
      const src = readFileSync(path, 'utf8');
      return paints(src, `bg-${family}-soft`) && paints(src, `text-${family}`);
    })
    .map((path) => relative(SRC_ROOT, path))
    .sort();
}

/** One entry per family the per-family loop below actually registers a case for. */
const softPairCasesRegistered: string[] = [];

describe('ACCENT_SOFT_PAIRS covers every soft tint the tree paints as text', () => {
  /**
   * The parse anchor. If this regex ever stopped matching, `SOFT_FAMILIES`
   * would be empty, every case below would loop zero times, and the whole
   * describe would go green on nothing — the precise failure it exists to
   * prevent.
   *
   * Pinned exactly rather than loosely, so a FIFTH soft tint lands here as a
   * red test rather than as silence. Satisfying it is one line plus a
   * measurement, which is the point: a new tinted accent should cost a thought.
   *
   * `rule` is here and is not an accent — `rule-soft` is the hairline behind
   * `.ax-md`'s blockquote bar, table cells and `hr`, and there is no `--rule`
   * token for anything to paint as text. It stays in the list anyway. Trimming
   * it would mean filtering families by whether a matching accent token exists,
   * and that filter is a shape a genuinely unmeasured family could wear. A
   * family nothing paints as text costs nothing here; it simply finds no sites.
   */
  it('reads the soft tints tailwind publishes', () => {
    expect(SOFT_FAMILIES).toEqual(['destructive', 'primary', 'rule', 'warning']);
  });

  /**
   * The scan anchor, pinned on this card's own family because it is two files
   * and it is the pairing the defect lived in. A rename, a move or a third
   * badge shows up here as a red test naming the file, which is the cheapest
   * possible way to be told.
   */
  it('finds the warning tint exactly where TASK-445 measured it', () => {
    expect(softTextSites('warning')).toEqual([
      'components/workspace/WorkspaceSidebar.tsx',
      'components/workspace/bits.tsx',
    ]);
  });

  /**
   * The dropped-loop guard, the third in this file after
   * `quietTextCasesRegistered` and `tintCasesRegistered`. The loop below is the
   * newest auto-merge collision surface here, and it fails the same way they
   * did: a clean merge that keeps `SOFT_FAMILIES` and the two anchors but drops
   * the `for` stays entirely GREEN, because neither anchor depends on the loop
   * running. The per-family enforcement would just quietly stop existing — this
   * block's own hazard, one level up.
   *
   * So count the registrations at collection time and compare them to the
   * families. Note this reads what was REGISTERED, not what passed: a dropped
   * loop registers nothing and fails here loudly.
   */
  it('registers one measured-pair case per soft family', () => {
    expect(softPairCasesRegistered).toEqual([...SOFT_FAMILIES]);
  });

  for (const family of SOFT_FAMILIES) {
    softPairCasesRegistered.push(family);
    it(`--${family}-soft painted with text-${family} is a measured pair`, () => {
      const sites = softTextSites(family);
      if (sites.length === 0) return; // nothing paints it; nothing to measure
      const measured = ACCENT_SOFT_PAIRS.some(
        ([accent, soft]) => accent === `--${family}` && soft === `--${family}-soft`,
      );
      expect(
        measured,
        `${sites.join(', ')} paint bg-${family}-soft with text-${family}, but ` +
          `['--${family}', '--${family}-soft'] is not in ACCENT_SOFT_PAIRS, so ` +
          `no theme measures it. Add the row.`,
      ).toBe(true);
    });
  }
});

/* ------------------------------------------------------------------------- *
 * `ApprovalCard`'s tinted surface — the one the token pairs above cannot see.
 * ------------------------------------------------------------------------- */

/**
 * A FRACTIONAL surface, which is a shape every list above is blind to.
 *
 * Everything before this measures one token against another. `ApprovalCard`
 * paints `bg-warning-soft/40`, and 40%-of-a-token-over-something-else is not a
 * token, so no pair in this file describes the pixels a reader is actually
 * looking at. That gap is not academic — it is how TASK-428 was written.
 *
 * TASK-428 REPORTED 4.10:1 FOR THIS CARD'S BODY COPY IN DARK MODE, AND IT DOES
 * NOT REPRODUCE. 4.10:1 is this file's own figure for quiet text on a SOLID
 * `bg-warning-soft` — the number the note on `QUIET_TEXT_SURFACES` records
 * precisely because nothing renders it. The probe read the declared token and
 * not the composited pixel. A re-walk of the same surface got 5.03 light /
 * 5.50 dark against this section's 5.03 / 5.51 — inside the ±0.02
 * browser-versus-formula gap this file budgets elsewhere, so the instrument
 * agrees once it composites.
 *
 * What ships here is therefore not a fix. It is the measurement, enforced:
 *
 *   `--muted-foreground`  5.03 light, 5.51 dark on `--background`, 4.66 dark on `--card`
 *   `--destructive`       4.97 light, 5.55 dark on `--background`, 4.69 dark on `--card`
 *
 * Both clear AA on every backdrop. Light mode shows one number because
 * `--card` and `--background` are the same white there.
 *
 * TWO BACKDROPS, because the card does not carry one. The approval stack in
 * `Composer.tsx` and the thread row in `AgentConversation.tsx` both paint no
 * background of their own, so today the card sits on the page (`--background`).
 * `--card` is measured as well: it is the darker of the two in dark mode and
 * therefore the tighter bound, and re-parenting this card onto a panel is a
 * layout change nobody would think to re-measure.
 *
 * `--destructive` is here because it is the same surface, not a second topic:
 * the stale-guard line and the failed-resolve notice are `text-destructive` on
 * this exact tint, and they are the two sentences a reader most needs when
 * something has gone wrong.
 *
 * NO TOKEN VALUE MOVES. `--warning` and `--warning-soft` are left exactly as
 * they are, deliberately — `text-warning` on solid `bg-warning-soft` IS under
 * the floor at 4.45:1 light, and that pair is TASK-445's card. Fixing it from
 * here would move a token under two cards at once.
 *
 * THE ALPHA IS READ OUT OF THE COMPONENT, NOT WRITTEN DOWN HERE. That is the
 * load-bearing choice. Every number above depends on the `/40`: the same quiet
 * text on the solid tint is the 4.10:1 the card reported, so a future edit that
 * drops the alpha reintroduces a real defect that a hard-coded `0.4` here would
 * cheerfully keep measuring as fine. Reading it back means the rows re-measure
 * whatever ships — a change to `/60` simply gets checked, and a change to solid
 * fails with the true ratio rather than tripping a "do not touch this class"
 * guard nobody can act on.
 */
const APPROVAL_CARD = 'components/workspace/ApprovalCard.tsx';

/** The tint `ApprovalCard` actually paints, parsed from its source. */
interface Tint {
  /** The custom property behind the Tailwind class, e.g. `--warning-soft`. */
  token: string;
  /** `0`-`1`. A bare class with no `/pct` suffix is fully opaque. */
  alpha: number;
  /** The class as written, for failure messages. */
  cls: string;
}

/**
 * Comments are stripped first (`stripComments`, with its own fixtures above),
 * because this file's block comments discuss `bg-warning-soft` in prose and a
 * raw scan would count those as paint.
 *
 * A VARIANT PREFIX IS MATCHED AND THEN REJECTED, rather than not matched. That
 * looks like a long way round to the same place and it is not: a regex that
 * simply could not see `dark:bg-warning-soft/60` would keep measuring the
 * unprefixed class and apply its alpha to the dark rows, which is a silent
 * wrong answer in exactly the theme this whole section is about. Matching the
 * prefix and throwing turns a conditional surface into a loud "give this its
 * own rows" instead. Every other mutation already fails loud: two classes hit
 * the count check, an interpolated class or an arbitrary `/[0.4]` opacity
 * yields no percentage and trips the fractional assertion.
 *
 * The prefix class is deliberately wider than `dark:`/`light:`. A first pass
 * matched `[a-z-]+`, which reads as "a variant" and is not — `2xl:` and
 * `data-[state=open]:` both start with something else, so they slipped through
 * as UNCONDITIONAL tints, which is the silent case again one character over.
 * Residual gap, named rather than implied: a prefix built by interpolation
 * (`` `${v}:bg-warning-soft` ``) still reads as unprefixed. Nothing in this
 * tree builds a class that way, and the count check catches it the moment it
 * appears beside the plain one.
 */
function parseTint(source: string): Tint {
  const src = stripComments(source);
  const hits = [
    ...src.matchAll(
      /(?<![\w-])(?:([\w.:[\]=&>~*-]+):)?bg-(warning-soft)(?:\/(\d{1,3}))?(?![\w-])/g,
    ),
  ];
  if (hits.length !== 1) {
    const found = hits.length === 0 ? 'none' : hits.map((h) => h[0]).join(', ');
    throw new Error(
      `${APPROVAL_CARD} paints ${hits.length} warning-soft classes (${found}); ` +
        `this section measures exactly one. If the card's surface changed, re-read ` +
        `the note above and give the new surface its own rows — do not delete these.`,
    );
  }
  const [cls, variant, name, pct] = hits[0]!;
  if (variant !== undefined) {
    throw new Error(
      `${APPROVAL_CARD} paints \`${cls}\` — a variant-prefixed surface, so the card ` +
        `no longer has one tint for every theme. Measure each branch on its own rows ` +
        `rather than letting this one stand in for both.`,
    );
  }
  return { token: `--${name!}`, alpha: pct === undefined ? 1 : Number(pct) / 100, cls: cls! };
}

function approvalCardTint(): Tint {
  return parseTint(readFileSync(join(SRC_ROOT, APPROVAL_CARD), 'utf8'));
}

/**
 * The opaque surfaces the tinted card can sit on. See the two-backdrops note
 * above for why `--card` is here when nothing paints it behind the card today.
 */
const TINT_BACKDROPS = ['--background', '--card'] as const;

/** Every token the card paints as readable text on that tint. */
const TINTED_TEXT = ['--muted-foreground', '--destructive'] as const;

/**
 * Same dropped-loop hazard the quiet-text loop documents, same guard. This file
 * is a known auto-merge collision point and a clean merge has already once kept
 * the constants while losing a loop.
 */
const tintCasesRegistered: string[] = [];

describe("ApprovalCard's tinted surface", () => {
  it('paints exactly one warning-soft class, and it is fractional', () => {
    const tint = approvalCardTint();
    expect(tint.token).toBe('--warning-soft');
    expect(tint.alpha).toBeGreaterThan(0);
    // Not an aesthetic preference: at alpha 1 the quiet text is 4.10:1 in dark
    // mode. The rows below would catch that too — this just says so in one line.
    expect(tint.alpha, `${tint.cls} is opaque; see the note above`).toBeLessThan(1);
  });

  for (const [name, selector] of THEMES) {
    for (const under of TINT_BACKDROPS) {
      for (const text of TINTED_TEXT) {
        tintCasesRegistered.push(`${name}:${under}:${text}`);
        it(`${name}: ${text} on the card's warning tint over ${under} clears AA`, () => {
          const tokens = tokensAfter(selector);
          const tint = approvalCardTint();
          const tintV = tokens.get(tint.token);
          const underV = tokens.get(under);
          const textV = tokens.get(text);
          expect(tintV, `${tint.token} missing from ${selector}`).toBeDefined();
          expect(underV, `${under} missing from ${selector}`).toBeDefined();
          expect(textV, `${text} missing from ${selector}`).toBeDefined();

          const surface = composite(tintV!, tint.alpha, underV!);
          const ratio = contrast(textV!, surface);
          expect(
            ratio,
            `${text} on ${tint.cls} over ${under} is ${ratio.toFixed(2)}:1 in ${name} — ` +
              `AA needs ${AA_NORMAL}:1. This is ${APPROVAL_CARD}'s body copy.`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  }

  /**
   * Anti-vacuity. `composite` is the only new arithmetic in this file, and a
   * broken one fails SAFE — it would quietly hand every row a surface closer to
   * the backdrop, which in light mode is white and passes everything. So pin
   * both ends and the midpoint against values that need no formula.
   */
  it('composites alpha the way a browser does', () => {
    expect(composite('0 0% 100%', 1, '0 0% 0%')).toEqual([255, 255, 255]);
    expect(composite('0 0% 100%', 0, '0 0% 0%')).toEqual([0, 0, 0]);
    expect(composite('0 0% 100%', 0.5, '0 0% 0%')).toEqual([128, 128, 128]);

    // And a fully opaque composite is the solid pairing the rest of the file
    // already measures, so the two halves cannot drift apart.
    const dark = tokensAfter(":root[data-theme='dark'] {");
    const ws = dark.get('--warning-soft')!;
    const mf = dark.get('--muted-foreground')!;
    expect(contrast(mf, composite(ws, 1, '0 0% 100%'))).toBeCloseTo(contrast(mf, ws), 10);
  });

  /**
   * Anti-vacuity for the parser, which is the one piece here that can be wrong
   * QUIETLY. Everything else fails with a ratio; a parser that reads the wrong
   * alpha just measures a different surface and reports it as fine.
   *
   * The `dark:` case is the one review found. A regex that could not see a
   * variant prefix would keep reading the unprefixed class and apply its alpha
   * to the dark rows — a wrong answer in exactly the theme this section is
   * about, and a silent one. So it is matched and rejected, and that is pinned
   * here rather than left to the comment above.
   */
  it('reads the alpha off a class, and refuses the shapes it cannot stand in for', () => {
    expect(parseTint('<Card className="bg-warning-soft/40" />')).toMatchObject({
      token: '--warning-soft',
      alpha: 0.4,
      cls: 'bg-warning-soft/40',
    });
    // No percentage suffix is opaque, not "unknown".
    expect(parseTint('<Card className="bg-warning-soft" />').alpha).toBe(1);

    // A theme-conditional surface cannot be measured by one row per theme.
    expect(() => parseTint('<Card className="dark:bg-warning-soft/60" />')).toThrow(
      /variant-prefixed/,
    );
    // Not every variant starts with a letter, and one that slips through reads
    // as an UNCONDITIONAL tint — the silent case the prefix check exists for.
    expect(() => parseTint('<Card className="2xl:bg-warning-soft/40" />')).toThrow(
      /variant-prefixed/,
    );
    expect(() => parseTint('<Card className="data-[state=open]:bg-warning-soft/40" />')).toThrow(
      /variant-prefixed/,
    );
    expect(() => parseTint('<Card className="md:hover:bg-warning-soft/40" />')).toThrow(
      /variant-prefixed/,
    );

    // The lookbehind still protects both ends: neither of these is the class.
    expect(() => parseTint('<Card className="flex-bg-warning-soft" />')).toThrow(/paints 0/);
    expect(() => parseTint('<Card className="bg-warning-softer" />')).toThrow(/paints 0/);
    expect(() =>
      parseTint('<Card className="bg-warning-soft/40 dark:bg-warning-soft/60" />'),
    ).toThrow(/paints 2 warning-soft classes/);

    // Gone entirely, or hidden behind interpolation: loud, not green.
    expect(() => parseTint('<Card className="bg-card" />')).toThrow(/paints 0/);

    // Prose about the class is not paint — this file's own comments say
    // `bg-warning-soft` repeatedly, and so does the component's.
    expect(() => parseTint('  /* bg-warning-soft is the tint */')).toThrow(/paints 0/);
  });

  it('registers one case per theme per backdrop per text token', () => {
    const expected = THEMES.flatMap(([name]) =>
      TINT_BACKDROPS.flatMap((under) => TINTED_TEXT.map((text) => `${name}:${under}:${text}`)),
    );
    expect(tintCasesRegistered).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * The state dots — the 3:1 NON-TEXT floor (WCAG 1.4.11).
 * ------------------------------------------------------------------------- */

/**
 * Everything above this line measures TEXT against 4.5:1. This measures MARKS
 * against 3:1, and the two floors are not a strict-vs-lenient pair — they are
 * different criteria answering different questions, which is why folding a dot
 * into a text table would be wrong in both directions.
 *
 * A `StateDot` is "visual information required to identify ... a state": WCAG
 * 2.1 SC 1.4.11 Non-text Contrast, 3:1. When TASK-450 wrote this section the
 * fill was the whole message — no glyph, no label, no shape difference. Since
 * TASK-485 each state also has its own shape (`STATE_SHAPE` in `bits.tsx`), so
 * colour is no longer the ONLY channel — but a shape nobody can see against
 * the row carries nothing either, so the 3:1 floor on the fill still holds.
 *
 * TASK-450 found three fills under it, all of them `bg-ink-ghost`: `StateDot`'s
 * `resting`, and `StatusDot`'s `empty` and `pending`, at 1.72:1 light and
 * 1.67:1 dark on the page and a card — and 1.50:1 / 1.56:1 on
 * `--primary-soft`, the selected sidebar row and the worst surface they land
 * on. About half the floor. They paint `--state-quiet` now; `index.css` carries the numbers.
 *
 * THREE THINGS ABOUT THAT CARD DID NOT SURVIVE CONTACT, recorded here because
 * each one changes what this section is allowed to claim:
 *
 *   1. `StatusDot`'s dots are NOT the sole carrier of their state. All THREE
 *      live render sites put a plain-English label immediately beside the dot —
 *      `ConnectorsTab`'s `STATUS_COPY`, its `testLabel`, and "Awaiting your
 *      approval" — and the dot is `aria-hidden`. (`ProviderRow` pairs its dot
 *      with `DEFAULT_LABEL` the same way, and is worth naming precisely because
 *      it does NOT count: nothing in the running UI renders it, only its own
 *      unit test. It is listed here so the next reader does not re-grep it.)
 *      Where the information is duplicated in adjacent text, the mark is
 *      decorative and 1.4.11 does not reach it. They
 *      were raised anyway, because they shared a token with a dot that IS the
 *      sole carrier and splitting them apart would buy nothing but a third
 *      token. The rows below are therefore a floor these two do not strictly
 *      owe — a fine thing for a test to over-enforce, and a bad thing for a
 *      reader to mistake for a finding.
 *   2. `StateDot` in `WorkspaceSidebar` IS the sole carrier: that row is a dot
 *      plus the agent's name and nothing else. It is the site the card is
 *      really about, and it is the reason the floor is owed at all.
 *   3. The card offered "raise the ratio" OR "add a non-colour channel" and
 *      called the second better. It is better, and it is NOT what shipped,
 *      because the two are not alternatives for one defect. The dot being
 *      invisible (1.4.11) and the dot being colour-only (1.4.1, plus
 *      `aria-hidden` hiding it from screen readers altogether) are two bugs;
 *      this fixes the first. The second was a layout and copy change to the
 *      sidebar row, left as a follow-up rather than smuggled in here — and
 *      it shipped as TASK-485: a per-state shape, plus the state word as
 *      `sr-only` text in the roster row (`WorkspaceSidebarState.test.tsx`).
 *
 * WHY A SECOND TOKEN rather than moving `--ink-ghost`: the block above spells
 * out the tension and the precedent. `--ink-ghost` also fills the composer's
 * send circle while the field is empty, where the faintness IS the affordance
 * — and an inactive control is the one case SC 1.4.11 exempts by name, so that
 * role owes no ratio at all. Raising the shared token would have paid a bill
 * the send circle does not have. This file's answer to "one token, two roles
 * pulling apart" has now twice been to split rather than average.
 *
 * THE CLASSES ARE READ OUT OF THE COMPONENTS, not written down here — the same
 * load-bearing choice the `ApprovalCard` section makes about its alpha. A
 * revert of `bg-state-quiet` to `bg-ink-ghost` fails these rows with the true
 * 1.72:1, instead of passing because a constant in the test moved along with
 * the component. Mutation-verified in both directions when this was written.
 */
const AA_NON_TEXT = 3;

/**
 * A surface a dot is painted on: a token, optionally at `alpha` over another.
 *
 * SIX of them, because a dot moves around more than a paragraph does. The
 * sidebar row is the page by default, `bg-muted/60` on hover and
 * `bg-primary-soft` when selected; `StatusDot` lives inside `RoleCard`'s
 * `bg-card`; and `DecisionRow`'s STALE row tints itself `bg-destructive-soft/50`
 * over that card while still rendering a dot. `--primary-soft` is the tightest
 * of the six in BOTH themes, and it is the one nobody would think to check,
 * because "the selected row" reads as a state of the row rather than as a place
 * a dot lives.
 *
 * The stale row is here for the same reason, one card later: review found it
 * missing from a list whose own comment claimed "every surface a dot lands on",
 * which is this file's signature defect — a completeness claim nobody checked.
 * It measures clear today (the `stopped` dot that actually lands there is
 * 4.85:1 light / 4.90:1 dark), so it is a bound rather than a fix. Listing a
 * passing surface costs one line; NOT listing it is how the next defect hides.
 */
interface DotBackdrop {
  label: string;
  token: string;
  /** `0`-`1`; anything below 1 needs `over`. */
  alpha: number;
  over?: string;
}

const DOT_BACKDROPS: readonly DotBackdrop[] = [
  { label: '--background', token: '--background', alpha: 1 },
  { label: '--card', token: '--card', alpha: 1 },
  { label: '--muted', token: '--muted', alpha: 1 },
  { label: '--primary-soft (the selected sidebar row)', token: '--primary-soft', alpha: 1 },
  {
    label: 'bg-muted/60 over --background (the hover row)',
    token: '--muted',
    alpha: 0.6,
    over: '--background',
  },
  {
    label: 'bg-destructive-soft/50 over --card (the stale decision row)',
    token: '--destructive-soft',
    alpha: 0.5,
    over: '--card',
  },
];

function resolveBackdrop(tokens: Map<string, string>, b: DotBackdrop): Colour {
  const v = tokens.get(b.token);
  expect(v, `${b.token} missing`).toBeDefined();
  if (b.alpha === 1) return v!;
  const under = tokens.get(b.over!);
  expect(under, `${b.over} missing`).toBeDefined();
  return composite(v!, b.alpha, under!);
}

/**
 * The one `bg-*` class in a className string, as a token plus alpha.
 *
 * Throws on zero and on two rather than picking one. `StatusDot`'s `ok` variant
 * carries a `shadow-[…color-mix(…)]` alongside its fill and is the reason this
 * cannot just be "the first match": if that shadow ever became a second
 * background, the silent outcome would be measuring the wrong one.
 */
function bgFill(cls: string): { token: string; alpha: number; cls: string } {
  const hits = [...cls.matchAll(/(?<![\w-])bg-([a-z][\w-]*?)(?:\/(\d{1,3}))?(?![\w/-])/g)];
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one bg-* class, found ${hits.length} in "${cls}"` +
        (hits.length > 1 ? ` (${hits.map((h) => h[0]).join(', ')})` : ''),
    );
  }
  const [whole, name, pct] = hits[0]!;
  return { token: `--${name!}`, alpha: pct === undefined ? 1 : Number(pct) / 100, cls: whole! };
}

const STATE_DOT_FILE = 'components/workspace/bits.tsx';
const STATUS_DOT_FILE = 'components/admin/StatusDot.tsx';

/**
 * `StateDot`'s arms, read off its `cn()` call: `state === 'resting' && 'bg-…'`.
 *
 * Comments are stripped first, because that component's doc comment now
 * discusses `bg-ink-ghost` in prose and a raw scan would count it as paint —
 * the same trap `parseTint` documents one section up.
 *
 * The state name is `[\w-]+`, NOT `[a-z]+`, and the width is the whole point.
 * `AgentRunState` is all-lowercase today, so a narrower class would look
 * identical — right up until someone adds an `in-progress`, at which point the
 * arm simply would not match, `DOT_FILLS` would omit it, and the exact-list
 * anchor below would stay GREEN because its expectation would not mention the
 * variant either. An unmeasured dot with a clean suite. Matching wider means a
 * new state shows up as a red anchor asking for a measurement, which is the
 * failure direction this whole section is built around.
 */
function parseStateDotArms(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(source).matchAll(/state === '([\w-]+)' && '([^']+)'/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * `StatusDot`'s `VARIANT_CLASS` record, brace-matched and then read key by key.
 *
 * The key pattern allows hyphens and optional surrounding quotes for the reason
 * `parseStateDotArms` spells out: a `'needs-key'` variant is spelled with
 * quotes in a TS object literal, and a narrower pattern would skip it silently
 * rather than loudly. `StatusDotVariant` has no such member today; the point is
 * that it can grow one without this going quietly blind.
 */
function parseVariantClass(source: string): Map<string, string> {
  const src = stripComments(source);
  const at = src.indexOf('VARIANT_CLASS');
  if (at === -1) throw new Error('VARIANT_CLASS not found');
  let i = src.indexOf('{', at);
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const out = new Map<string, string>();
  for (const m of src.slice(start, i).matchAll(/'?([\w-]+)'?\s*:\s*'([^']+)'/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

function readSource(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8');
}

/**
 * Every dot fill in the tree, as `label -> class`. Derived, not listed: the
 * hand-maintained-list failure this file keeps paying for (`ACCENT_SOFT_PAIRS`
 * missing `--warning` for its entire life) is exactly what a sixth `StateDot`
 * state would reproduce here.
 *
 * So ALL variants are measured, not only the three the card named. The accent
 * fills pass comfortably — they are the same tokens the AA tables already bound
 * — and including them costs nothing while closing the omission hole.
 */
function dotFills(): Array<readonly [string, string]> {
  const arms = parseStateDotArms(readSource(STATE_DOT_FILE));
  const variants = parseVariantClass(readSource(STATUS_DOT_FILE));
  return [
    ...[...arms].map(([k, v]) => [`StateDot.${k}`, v] as const),
    ...[...variants].map(([k, v]) => [`StatusDot.${k}`, v] as const),
  ];
}

const DOT_FILLS = dotFills();

/** One entry per registered case — the dropped-loop guard, same as the three above. */
const dotCasesRegistered: string[] = [];

describe('state dots clear the 3:1 non-text floor', () => {
  /**
   * The parse anchor, and the reason the rows below cannot go green on nothing.
   * `dotFills()` returning nothing would loop zero times and prove nothing —
   * the same shape as a clean pass. Pinned EXACTLY, so a sixth state or a fifth
   * variant arrives as a red test plus a measurement rather than as silence.
   */
  it('reads every dot variant out of the two components', () => {
    expect(DOT_FILLS.map(([label]) => label)).toEqual([
      'StateDot.working',
      'StateDot.waiting',
      'StateDot.held',
      'StateDot.resting',
      'StateDot.stopped',
      'StatusDot.empty',
      'StatusDot.ok',
      'StatusDot.bad',
      'StatusDot.pending',
    ]);
  });

  /**
   * The split itself, asserted where it can be read in one line: the three dots
   * TASK-450 moved are off `--ink-ghost` and on `--state-quiet`. The ratio rows
   * below catch a revert too, but they report it as "3.20 became 1.50" and
   * leave the reader to work out which token that is.
   */
  it('keeps the moved dots on --state-quiet, not the send-circle token', () => {
    const fills = new Map(DOT_FILLS);
    for (const label of ['StateDot.resting', 'StatusDot.empty', 'StatusDot.pending']) {
      const cls = fills.get(label);
      expect(cls, `${label} missing`).toBeDefined();
      expect(bgFill(cls!).token, `${label} paints \`${cls}\``).toBe('--state-quiet');
    }
  });

  for (const [themeName, selector] of THEMES) {
    for (const [label, cls] of DOT_FILLS) {
      dotCasesRegistered.push(`${themeName}:${label}`);
      it(`${themeName}: ${label} clears 3:1 on every surface it lands on`, () => {
        const tokens = tokensAfter(selector);
        const fill = bgFill(cls);
        const fillV = tokens.get(fill.token);
        expect(fillV, `${fill.token} missing from ${selector}`).toBeDefined();

        for (const backdrop of DOT_BACKDROPS) {
          const under = resolveBackdrop(tokens, backdrop);
          const painted: Colour = fill.alpha === 1 ? fillV! : composite(fillV!, fill.alpha, under);
          const ratio = contrast(painted, under);
          expect(
            ratio,
            `${label} paints \`${fill.cls}\` (${fill.token}) and measures ` +
              `${ratio.toFixed(2)}:1 on ${backdrop.label} in ${themeName} — WCAG 1.4.11 ` +
              `needs ${AA_NON_TEXT}:1 for a mark that carries information. ` +
              `The fill still carries the state, and a shape nobody can see says nothing.`,
          ).toBeGreaterThanOrEqual(AA_NON_TEXT);
        }
      });
    }
  }

  /**
   * The judgement call, pinned so that it stops being one.
   *
   * The objection to raising these dots was that a darker `resting` dot "reads
   * as active" beside a `bg-primary` "working" one. The answer is an ordering,
   * not an opinion: the quiet dot must stay QUIETER than both the working dot
   * and the quiet text it sits beside, in every theme. It does, comfortably,
   * because what separates "working" from "resting" here is SATURATION — a
   * 100%-sat blue against a 4%-sat neutral — and not lightness.
   *
   * This is also what stops `--state-quiet` collapsing into
   * `--muted-foreground`, the objection that killed the idea of lifting
   * `--ink-ghost` to AA. Note the direction FLIPS between themes: 54% is
   * lighter than the 44% quiet text in light mode, 45% is darker than its 56%
   * in dark. Asserting "quieter" rather than "lighter" is what lets one
   * assertion cover both.
   */
  it('stays quieter than the working dot and the quiet text, in both themes', () => {
    for (const [themeName, selector] of THEMES) {
      const tokens = tokensAfter(selector);
      const page = tokens.get('--background')!;
      const quiet = contrast(tokens.get('--state-quiet')!, page);
      const working = contrast(tokens.get('--primary')!, page);
      const text = contrast(tokens.get('--muted-foreground')!, page);
      expect(
        quiet,
        `${themeName}: --state-quiet is ${quiet.toFixed(2)}:1 on the page and --primary is ` +
          `${working.toFixed(2)}:1 — the resting dot must not out-shout the working one`,
      ).toBeLessThan(working);
      expect(
        text,
        `${themeName}: --state-quiet is ${quiet.toFixed(2)}:1 and --muted-foreground is ` +
          `${text.toFixed(2)}:1 — a dot louder than the label beside it is a new bug, and ` +
          `two neutrals this close together are one token wearing two names`,
      ).toBeGreaterThan(quiet);
    }
  });

  /**
   * Anti-vacuity for the two parsers, the only pieces here that can be wrong
   * QUIETLY — everything else fails with a ratio. Both directions: they read
   * real code, they ignore prose, and they refuse the shapes they cannot stand
   * in for rather than guessing.
   */
  it('reads classes off code and not off comments', () => {
    const arms = parseStateDotArms(
      [
        "        state === 'working' && 'bg-primary',",
        "        // state === 'resting' && 'bg-ink-ghost',",
        " * the `resting` dot was state === 'resting' && 'bg-ink-ghost' once",
        "        state === 'resting' && 'bg-state-quiet',",
      ].join('\n'),
    );
    expect([...arms]).toEqual([
      ['working', 'bg-primary'],
      ['resting', 'bg-state-quiet'],
    ]);

    const variants = parseVariantClass(
      [
        '/** `empty` used to be bg-ink-ghost. */',
        'const VARIANT_CLASS: Record<V, string> = {',
        "  empty: 'bg-state-quiet',",
        "  ok: 'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]',",
        '  pending:',
        "    'bg-state-quiet animate-pulse',",
        '};',
        "const OTHER = { decoy: 'bg-destructive' };",
      ].join('\n'),
    );
    expect([...variants.keys()]).toEqual(['empty', 'ok', 'pending']);
    expect(variants.get('pending')).toBe('bg-state-quiet animate-pulse');

    expect(() => parseVariantClass('const NOPE = {};')).toThrow(/VARIANT_CLASS not found/);
  });

  /**
   * The hyphen case, which is the one that would have gone QUIETLY wrong: an
   * unmatched variant is simply absent from `DOT_FILLS`, and the exact-list
   * anchor would not miss it because the anchor would not name it either. Both
   * parsers are pinned on a hyphenated member so the width cannot be narrowed
   * back without a red test.
   */
  it('sees a hyphenated state or variant, quoted or not', () => {
    const arms = parseStateDotArms("state === 'in-progress' && 'bg-primary',");
    expect([...arms]).toEqual([['in-progress', 'bg-primary']]);

    const variants = parseVariantClass(
      [
        'const VARIANT_CLASS = {',
        "  'needs-key': 'bg-destructive',",
        "  ok: 'bg-primary',",
        '};',
      ].join('\n'),
    );
    expect([...variants.keys()]).toEqual(['needs-key', 'ok']);
  });

  /**
   * `bgFill` is what turns a class into a measured token, so pin it on the
   * shapes this tree actually contains — including the `ok` variant's
   * `shadow-[…color-mix(…)]`, the one string here that looks like it might
   * carry a second background and does not.
   */
  it('extracts exactly one background token per class', () => {
    expect(bgFill('bg-state-quiet')).toMatchObject({ token: '--state-quiet', alpha: 1 });
    expect(bgFill('bg-state-quiet animate-pulse')).toMatchObject({ token: '--state-quiet' });
    expect(
      bgFill(
        'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]',
      ),
    ).toMatchObject({ token: '--primary' });
    expect(bgFill('bg-warning-soft/40')).toMatchObject({ token: '--warning-soft', alpha: 0.4 });

    // Zero and two are both loud. A dot with no fill is a dot that vanished;
    // two fills means this helper would otherwise be picking one at random.
    expect(() => bgFill('animate-pulse')).toThrow(/found 0/);
    expect(() => bgFill('bg-primary bg-destructive')).toThrow(/found 2/);
    // The lookbehind protects both ends, exactly as it does for the tint parser.
    expect(() => bgFill('hover-bg-primary')).toThrow(/found 0/);
  });

  /**
   * The composited rows are the backdrops with arithmetic in them, and a broken
   * `composite` fails SAFE in light mode: everything drifts toward white and
   * passes. `composite` has its own fixtures above; this pins that the BACKDROP
   * LIST actually uses them, by checking each fractional row lands between the
   * two surfaces it blends.
   *
   * EVERY fractional row, not the first one. This was a `find()` when there was
   * one of them, which review flagged the moment a second arrived: `find()` does
   * not fail when the list grows, it just quietly stops covering the rest. The
   * count is asserted below for the same reason.
   */
  it('resolves every fractional backdrop between its two layers', () => {
    const fractional = DOT_BACKDROPS.filter((b) => b.alpha < 1);
    expect(fractional.length, 'no fractional backdrop left to check').toBe(2);
    for (const [, selector] of THEMES) {
      const tokens = tokensAfter(selector);
      for (const b of fractional) {
        const blended = luminance(rgbOf(resolveBackdrop(tokens, b)));
        const ends = [
          luminance(rgbOf(tokens.get(b.token)!)),
          luminance(rgbOf(tokens.get(b.over!)!)),
        ].sort((x, y) => x - y);
        expect(blended, `${b.label} in ${selector}`).toBeGreaterThanOrEqual(ends[0]!);
        expect(blended, `${b.label} in ${selector}`).toBeLessThanOrEqual(ends[1]!);
      }
    }
  });

  it('registers one case per theme per dot variant', () => {
    const expected = THEMES.flatMap(([name]) => DOT_FILLS.map(([label]) => `${name}:${label}`));
    expect(dotCasesRegistered).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * Hover fills on filled accent controls.
 * ------------------------------------------------------------------------- */

/**
 * A hover is a state a person sits in while they read the label and decide
 * whether to press — it answers to the same AA floor as the resting fill.
 *
 * TASK-511 is what surfaced the gap: a browser walk (TASK-358) measured the
 * primary consent button at 4.47:1 on hover in BOTH themes, while every resting
 * pair above passed. The cause was shadcn's stock `hover:bg-primary/90`: 10% of
 * the surface behind the button bleeds through, and in both themes that surface
 * sits on the same side of the accent as the foreground (white page under white
 * text in light, black page under near-black text in dark). So the hover drifts
 * TOWARD the text. This file's formula: primary 4.48 light / 4.32 dark on the
 * page, destructive 4.46 / 4.30 — the destructive variant had the same defect
 * and nothing had measured it either. `Badge` carried the same treatment at
 * `/80` and was worse: 3.75 / 3.53 primary, 3.79 / 3.53 destructive.
 *
 * Nothing above could see it, because every row measures a TOKEN and a hover
 * class is not one — `bg-primary/90` is a composite of a token and whatever the
 * control happens to sit on. So, as in the `ApprovalCard` and state-dot
 * sections, THE CLASS IS READ OUT OF THE COMPONENT, alpha included, and
 * composited over every opaque surface a button can sit on. Reverting either
 * component to `/90` fails these rows with the true number rather than passing
 * because a constant here moved with it.
 *
 * `secondary` is deliberately NOT a row: its hover is `bg-secondary/80` with a
 * foreground at ~16:1, and a fractional variant of a near-surface fill only
 * moves further from its text. `outline` and `ghost` hover to `--accent` with
 * `--accent-foreground`, a solid pair the same value as `--muted` under the
 * body text, 16:1+. If either ever carries a mid-tone fill, it needs a row.
 */
const HOVER_SITES = [
  ['components/ui/button.tsx', 'default'],
  ['components/ui/button.tsx', 'destructive'],
  ['components/ui/badge.tsx', 'default'],
  ['components/ui/badge.tsx', 'destructive'],
] as const;

/**
 * Opaque surfaces a filled control can sit on. Only matters for a fractional
 * hover — a solid one paints the same pixel everywhere — but it is listed in
 * full so a future `/90` is measured on the worst of them, not the first.
 * `--popover` is where dialog buttons live; `--muted` carries tab strips and
 * filled chips.
 */
const CONTROL_SURFACES = ['--background', '--card', '--popover', '--muted'] as const;

/**
 * One cva variant's class string, read out of the component's source.
 *
 * Scoped to the `variant: { … }` block, because `size` has a `default:` arm of
 * its own and "the first `default:`" would be a size string.
 */
function variantClasses(src: string, variant: string): string {
  const code = stripComments(src);
  const blocks = [...code.matchAll(/(?<![\w-])variant:\s*\{([^}]*)\}/g)];
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one "variant: { … }" block, found ${blocks.length}`);
  }
  const hits = [
    ...blocks[0]![1]!.matchAll(new RegExp(`(?<![\\w-])${variant}:\\s*"([^"]*)"`, 'g')),
  ];
  if (hits.length !== 1) {
    throw new Error(`expected exactly one "${variant}:" variant string, found ${hits.length}`);
  }
  return hits[0]![1]!;
}

/**
 * The resting fill, the hover fill and the text token of one variant string.
 *
 * Each must appear exactly once. A second `hover:bg-*` (say a `dark:hover:`
 * override added later) would mean the dark rows measure the wrong class, so
 * any variant-prefixed hover other than the bare `hover:` is refused rather
 * than silently skipped.
 */
function hoverPair(cls: string): {
  rest: { token: string; alpha: number };
  hover: { token: string; alpha: number; cls: string };
  text: string;
} {
  const tokens = cls.split(/\s+/).filter(Boolean);
  const unprefixed = tokens.filter((t) => !t.includes(':')).join(' ');
  const prefixedBg = tokens.filter((t) => /:bg-/.test(t));
  const hovers = prefixedBg.filter((t) => /^hover:bg-/.test(t));
  if (hovers.length !== 1 || prefixedBg.length !== 1) {
    throw new Error(
      `expected exactly one prefixed bg-* class and it bare "hover:", found ${prefixedBg.join(', ') || 'none'}`,
    );
  }
  const texts = tokens.filter((t) => /^text-[a-z][\w-]*-foreground$/.test(t));
  if (texts.length !== 1) {
    throw new Error(`expected exactly one text-*-foreground class, found ${texts.length} in "${cls}"`);
  }
  return {
    rest: bgFill(unprefixed),
    hover: bgFill(hovers[0]!.slice('hover:'.length)),
    text: `--${texts[0]!.slice('text-'.length)}`,
  };
}

/** Contrast of one hover fill with its text, over one surface, in one theme. */
function hoverContrast(
  tokens: Map<string, string>,
  pair: ReturnType<typeof hoverPair>,
  surface: string,
): number {
  const fill = tokens.get(pair.hover.token);
  const text = tokens.get(pair.text);
  const under = tokens.get(surface);
  expect(fill, `${pair.hover.token} missing`).toBeDefined();
  expect(text, `${pair.text} missing`).toBeDefined();
  expect(under, `${surface} missing`).toBeDefined();
  const painted: Colour = pair.hover.alpha === 1 ? fill! : composite(fill!, pair.hover.alpha, under!);
  return contrast(painted, text!);
}

const hoverCasesRegistered: string[] = [];

describe('filled accent controls clear AA on hover', () => {
  for (const [file, variant] of HOVER_SITES) {
    const pair = hoverPair(variantClasses(readFileSync(join(SRC_ROOT, file), 'utf8'), variant));
    for (const [themeName, selector] of THEMES) {
      hoverCasesRegistered.push(`${themeName}:${file}:${variant}`);
      it(`${themeName}: ${file} ${variant} (${pair.hover.cls}) keeps ${pair.text} above AA on every surface`, () => {
        const tokens = tokensAfter(selector);
        for (const surface of CONTROL_SURFACES) {
          expect(
            hoverContrast(tokens, pair, surface),
            `${pair.hover.cls} over ${surface} in ${selector}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        }
      });
    }
  }

  /**
   * The hover must be the SAME accent family as the resting fill. A variant
   * that hovered to an unrelated token would pass the floor while meaning
   * something else entirely — and, more to the point here, a hover token that
   * is not derived from the rest is the only way the rows above could measure
   * a pair that never renders.
   */
  it('hovers each variant within its own accent family', () => {
    for (const [file, variant] of HOVER_SITES) {
      const pair = hoverPair(variantClasses(readFileSync(join(SRC_ROOT, file), 'utf8'), variant));
      expect(pair.hover.token.startsWith(pair.rest.token), `${file} ${variant}`).toBe(true);
      expect(pair.text, `${file} ${variant}`).toBe(`${pair.rest.token}-foreground`);
    }
  });

  /**
   * Non-vacuity by construction. The stock shadcn class this section exists to
   * reject must measure UNDER the floor with this file's own arithmetic, in
   * both themes, for both accents — otherwise the rows above could be green
   * over a revert. If a future token move lifts the stock `/90` over the floor
   * this goes red, and that is the moment to decide on purpose whether the
   * per-theme hover token is still needed.
   */
  it('measures the stock `hover:bg-*/90` treatment under the floor', () => {
    for (const accent of ['primary', 'destructive']) {
      const stock = hoverPair(`bg-${accent} text-${accent}-foreground hover:bg-${accent}/90`);
      expect(stock.hover).toMatchObject({ token: `--${accent}`, alpha: 0.9 });
      for (const [, selector] of THEMES) {
        const tokens = tokensAfter(selector);
        expect(hoverContrast(tokens, stock, '--background'), `${accent} in ${selector}`).toBeLessThan(
          AA_NORMAL,
        );
      }
    }
  });

  it('reads the hover class off a variant string, and refuses shapes it cannot measure', () => {
    expect(hoverPair('bg-primary text-primary-foreground hover:bg-primary-hover')).toMatchObject({
      rest: { token: '--primary', alpha: 1 },
      hover: { token: '--primary-hover', alpha: 1 },
      text: '--primary-foreground',
    });
    expect(() => hoverPair('bg-primary text-primary-foreground')).toThrow(/prefixed bg/);
    expect(() =>
      hoverPair('bg-primary text-primary-foreground hover:bg-primary-hover dark:hover:bg-primary/90'),
    ).toThrow(/prefixed bg/);
    expect(() => hoverPair('bg-primary hover:bg-primary-hover')).toThrow(/text-\*-foreground/);
    const cva = (arms: string) => `variant: {\n${arms}\n},\nsize: {\n default: "h-10",\n}`;
    expect(variantClasses(cva(' default: "live",'), 'default')).toBe('live');
    expect(() => variantClasses(cva(' default: "a",\n default: "b",'), 'default')).toThrow(/found 2/);
    expect(variantClasses(cva(' // default: "stale"\n default: "live",'), 'default')).toBe('live');
    expect(() => variantClasses('size: {\n default: "h-10",\n}', 'default')).toThrow(/found 0/);
  });

  it('registers one case per theme per hover site', () => {
    const expected = HOVER_SITES.flatMap(([file, variant]) =>
      THEMES.map(([name]) => `${name}:${file}:${variant}`),
    );
    expect(hoverCasesRegistered).toEqual(expected);
  });
});

/**
 * SessionRow's "Delete" menu item, in every state it can paint (TASK-531).
 *
 * It is `text-destructive` ink on the row menu's own surface, and its hover
 * used to be `hover:bg-destructive/15` — the accent tinted at 15% over the
 * menu. In light mode that drags the fill toward the ink sitting on it:
 * **4.08:1**, under the floor, on the item that deletes a chat. (The follow-up
 * note that filed this also read 4.22 in dark mode; this file's formula puts
 * `/15` over the pure-black dark menu at 5.43, so only light was ever under.)
 *
 * The fix paints `hover:bg-destructive-soft` — the per-theme tint that already
 * sits behind `text-destructive` on the error rows, and which `ACCENT_SOFT_PAIRS`
 * above measures in both themes (4.57 light / 4.63 dark). An alpha cannot do
 * it: the menu is white in light mode and black in dark, so the same `/15`
 * composites to a different pixel in each, and the white one is what fails.
 *
 * These rows read the classes OFF THE COMPONENT — the item's ink, every
 * state-prefixed fill it carries (hover, focus, focus-visible, active), and the
 * menu surface underneath — so reverting the hover, or adding a focus fill that
 * does not clear, goes red here rather than in a browser walk.
 */
const SESSION_ROW_FILE = 'components/SessionRow.tsx';

/** The `className="…"` of the one JSX element carrying `marker`, comments stripped. */
function classNameOf(src: string, marker: string): string {
  const code = stripComments(src);
  const hits = [...code.matchAll(/className="([^"]*)"([^>]*)/g)].filter(
    (m) => m[1]!.includes(marker) || m[2]!.includes(marker),
  );
  if (hits.length !== 1) {
    throw new Error(`expected exactly one className carrying "${marker}", found ${hits.length}`);
  }
  return hits[0]![1]!.replace(/\s+/g, ' ').trim();
}

/** State prefixes a menu item may paint a fill under. Any other prefix is refused. */
const ITEM_STATES = ['hover', 'focus', 'focus-visible', 'active'] as const;

/**
 * Every fill a menu item can show — its resting one (if any) and one per
 * state-prefixed `bg-*` — plus its ink: the one bare `text-<token>` that names
 * a colour (arbitrary sizes like `text-[12.5px]` never match the pattern).
 */
function menuItemPaint(cls: string): {
  text: string;
  fills: Array<{ state: string; token: string; alpha: number; cls: string }>;
} {
  const tokens = cls.split(/\s+/).filter(Boolean);
  const texts = tokens.filter(
    (t) => /^text-[a-z][\w-]*$/.test(t) && !/^text-(xs|sm|base|lg|\d?xl|left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/.test(t),
  );
  if (texts.length !== 1) {
    throw new Error(`expected exactly one bare text colour class, found ${texts.join(', ') || 'none'}`);
  }
  const fills: Array<{ state: string; token: string; alpha: number; cls: string }> = [];
  const unprefixed = tokens.filter((t) => !t.includes(':'));
  if (unprefixed.some((t) => /^bg-/.test(t))) {
    fills.push({ state: 'rest', ...bgFill(unprefixed.join(' ')) });
  }
  for (const t of tokens.filter((x) => /:bg-/.test(x))) {
    const [prefix, ...rest] = t.split(':');
    if (rest.length !== 1 || !(ITEM_STATES as readonly string[]).includes(prefix!)) {
      throw new Error(`unmeasured fill prefix "${t}" — give it a row before painting it`);
    }
    fills.push({ state: prefix!, ...bgFill(rest[0]!) });
  }
  return { text: `--${texts[0]!.slice('text-'.length)}`, fills };
}

const sessionRowCasesRegistered: string[] = [];

describe("SessionRow's delete menu item clears AA in every state", () => {
  const src = readSource(SESSION_ROW_FILE);
  const item = menuItemPaint(classNameOf(src, 'data-testid="row-menu-delete"'));
  const surface = bgFill(classNameOf(src, 'session-row-menu '));

  for (const [themeName, selector] of THEMES) {
    sessionRowCasesRegistered.push(themeName);
    it(`${themeName}: ${item.text} on ${surface.cls}, resting and under ${item.fills.map((f) => f.cls).join(', ') || 'no fill'}`, () => {
      const tokens = tokensAfter(selector);
      const under = tokens.get(surface.token);
      const text = tokens.get(item.text);
      expect(under, `${surface.token} missing`).toBeDefined();
      expect(text, `${item.text} missing`).toBeDefined();
      expect(surface.alpha, 'the menu surface must be opaque to be measured').toBe(1);
      expect(contrast(text!, under!), `resting on ${surface.cls}`).toBeGreaterThanOrEqual(AA_NORMAL);
      for (const fill of item.fills) {
        const v = tokens.get(fill.token);
        expect(v, `${fill.token} missing`).toBeDefined();
        const painted: Colour = fill.alpha === 1 ? v! : composite(v!, fill.alpha, under!);
        expect(contrast(text!, painted), `${fill.state}: ${fill.cls}`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  }

  it('paints a hover, and every fill it paints is a solid per-theme tint', () => {
    expect(item.text).toBe('--destructive');
    expect(item.fills.map((f) => f.state)).toContain('hover');
    for (const f of item.fills) expect(f.alpha, f.cls).toBe(1);
  });

  it('measures the old `hover:bg-destructive/15` under the floor in light mode', () => {
    const old = menuItemPaint('text-destructive hover:bg-destructive/15');
    expect(old.fills).toEqual([{ state: 'hover', token: '--destructive', alpha: 0.15, cls: 'bg-destructive/15' }]);
    const tokens = tokensAfter(':root {');
    const ink = tokens.get('--destructive')!;
    const painted = composite(ink, 0.15, tokens.get('--background')!);
    expect(contrast(ink, painted)).toBeLessThan(AA_NORMAL);
  });

  it('reads the item paint off a class string, and refuses shapes it cannot measure', () => {
    expect(menuItemPaint('text-[12.5px] text-destructive hover:bg-destructive-soft')).toEqual({
      text: '--destructive',
      fills: [{ state: 'hover', token: '--destructive-soft', alpha: 1, cls: 'bg-destructive-soft' }],
    });
    expect(menuItemPaint('text-destructive focus-visible:bg-muted/50').fills[0]).toMatchObject({
      state: 'focus-visible',
      alpha: 0.5,
    });
    expect(() => menuItemPaint('text-destructive dark:hover:bg-destructive/15')).toThrow(/unmeasured/);
    expect(() => menuItemPaint('text-destructive group-hover:bg-destructive/15')).toThrow(/unmeasured/);
    expect(() => menuItemPaint('hover:bg-destructive-soft')).toThrow(/text colour/);
    expect(menuItemPaint('text-ellipsis text-nowrap text-destructive text-2xl').text).toBe('--destructive');
    expect(() =>
      classNameOf('<a className="x" data-k="1" /><b className="y" data-k="1" />', 'data-k'),
    ).toThrow(/found 2/);
    expect(classNameOf('{/* className="old" data-k="1" */}\n<a className="new" data-k="1" />', 'data-k')).toBe(
      'new',
    );
  });

  it('registers one case per theme', () => {
    expect(sessionRowCasesRegistered).toEqual(THEMES.map(([name]) => name));
  });
});

/**
 * SessionRow's inline confirm-delete row, in every state it can paint (TASK-538).
 *
 * Choosing "Delete" from the row menu swaps the row for "Delete this chat?"
 * plus a Cancel and a Delete control. The row used to tint itself
 * `bg-destructive/10` over the sidebar's `bg-background`. In light mode that
 * alpha drags the white page toward the red ink sitting on it: Cancel
 * (`text-muted-foreground`) measured **4.49:1** and Delete (`text-destructive`)
 * **4.44:1**, both under the floor, on the two buttons that decide whether a
 * chat is gone. Dark mode was fine at /10 (5.68 / 5.71).
 *
 * The fix is the same one TASK-531 made for the menu item: the solid per-theme
 * `bg-destructive-soft`. It costs dark mode some headroom (4.61 / 4.63, down
 * from 5.7) and buys light mode its floor (4.63 / 4.57). One token that clears
 * both themes beats an alpha that only clears one, and beats a `dark:` override.
 *
 * Everything is read OFF THE COMPONENTS: the row's fill, each control's resting
 * ink, every state-prefixed fill (via `menuItemPaint`), each `hover:text-*` ink,
 * and the sidebar surface the row sits on. A revert to `/10` goes red here with
 * the true ratios. The Delete control's hover swaps BOTH its fill and its ink
 * (`bg-destructive` + `text-destructive-foreground`), so its hover fill is
 * measured against the hover ink, not the resting one — measuring red on red
 * would be a false alarm, and measuring the resting ink on the resting fill
 * alone would miss a bad hover.
 */
const SIDEBAR_FILE = 'components/Sidebar.tsx';

/** `menuItemPaint`, plus the one `hover:text-*` ink a control may swap to. Other prefixed inks are refused. */
function controlPaint(cls: string): ReturnType<typeof menuItemPaint> & { hoverText?: string } {
  const paint = menuItemPaint(cls);
  const prefixedInks = cls
    .split(/\s+/)
    .filter((t) => /^[\w-]+:text-[a-z][\w-]*$/.test(t) && !/:text-(xs|sm|base|lg|\d?xl|left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/.test(t));
  const hover = prefixedInks.filter((t) => t.startsWith('hover:'));
  const other = prefixedInks.filter((t) => !t.startsWith('hover:'));
  if (other.length > 0) throw new Error(`unmeasured ink prefix "${other.join(', ')}" — give it a row first`);
  if (hover.length > 1) throw new Error(`expected at most one hover ink, found ${hover.join(', ')}`);
  return hover.length === 1
    ? { ...paint, hoverText: `--${hover[0]!.slice('hover:text-'.length)}` }
    : paint;
}

const confirmRowCasesRegistered: string[] = [];

describe("SessionRow's confirm-delete row clears AA in every state", () => {
  const src = readSource(SESSION_ROW_FILE);
  const row = bgFill(classNameOf(src, 'session-row confirming-delete'));
  const surface = bgFill(classNameOf(readSource(SIDEBAR_FILE), 'w-[240px]'));
  const controls = [
    ['prompt', controlPaint(classNameOf(src, 'session-row-confirm-text'))],
    ['Cancel', controlPaint(classNameOf(src, 'session-row-confirm-cancel'))],
    ['Delete', controlPaint(classNameOf(src, 'session-row-confirm-delete'))],
  ] as const;

  function rowColour(tokens: Map<string, string>, fill: { token: string; alpha: number }): Colour {
    const under = tokens.get(surface.token);
    const v = tokens.get(fill.token);
    expect(under, `${surface.token} missing`).toBeDefined();
    expect(v, `${fill.token} missing`).toBeDefined();
    return fill.alpha === 1 ? v! : composite(v!, fill.alpha, under!);
  }

  for (const [themeName, selector] of THEMES) {
    for (const [label, paint] of controls) {
      confirmRowCasesRegistered.push(`${themeName}:${label}`);
      it(`${themeName}: ${label} (${paint.text}) on ${row.cls}, resting and in every state`, () => {
        const tokens = tokensAfter(selector);
        const rest = rowColour(tokens, row);
        const ink = tokens.get(paint.text);
        expect(ink, `${paint.text} missing`).toBeDefined();
        expect(contrast(ink!, rest), `resting on ${row.cls}`).toBeGreaterThanOrEqual(AA_NORMAL);
        const hoverInk = paint.hoverText === undefined ? ink! : tokens.get(paint.hoverText);
        expect(hoverInk, `${paint.hoverText} missing`).toBeDefined();
        const hoverFill = paint.fills.find((f) => f.state === 'hover');
        if (hoverFill === undefined) {
          expect(contrast(hoverInk!, rest), `hover ink on ${row.cls}`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
        for (const fill of paint.fills) {
          const v = tokens.get(fill.token);
          expect(v, `${fill.token} missing`).toBeDefined();
          const painted: Colour = fill.alpha === 1 ? v! : composite(v!, fill.alpha, rest);
          const on = fill.state === 'hover' ? hoverInk! : ink!;
          expect(contrast(on, painted), `${fill.state}: ${fill.cls}`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
      });
    }
  }

  it('sits on an opaque sidebar surface, and the row fill is a solid per-theme tint', () => {
    expect(surface).toEqual({ token: '--background', alpha: 1, cls: 'bg-background' });
    expect(row.alpha, `${row.cls} must be solid: an alpha composites differently per theme`).toBe(1);
    expect(controls.map(([, p]) => p.text)).toEqual(['--foreground', '--muted-foreground', '--destructive']);
    expect(controls[2][1].hoverText).toBe('--destructive-foreground');
  });

  it('measures the old `bg-destructive/10` row under the floor in light mode for both controls', () => {
    const tokens = tokensAfter(':root {');
    const old = composite(tokens.get('--destructive')!, 0.1, tokens.get('--background')!);
    expect(contrast(tokens.get('--muted-foreground')!, old)).toBeLessThan(AA_NORMAL);
    expect(contrast(tokens.get('--destructive')!, old)).toBeLessThan(AA_NORMAL);
  });

  it('reads a hover ink off a class string, and refuses inks it cannot measure', () => {
    expect(controlPaint('text-muted-foreground hover:text-foreground').hoverText).toBe('--foreground');
    expect(controlPaint('text-destructive').hoverText).toBeUndefined();
    expect(() => controlPaint('text-destructive focus:text-foreground')).toThrow(/unmeasured ink/);
    expect(() => controlPaint('text-destructive dark:text-foreground')).toThrow(/unmeasured ink/);
    expect(() => controlPaint('text-x hover:text-y hover:text-z')).toThrow(/at most one/);
    expect(controlPaint('text-destructive hover:text-nowrap').hoverText).toBeUndefined();
  });

  it('registers one case per theme per control', () => {
    expect(confirmRowCasesRegistered).toEqual(
      THEMES.flatMap(([name]) => ['prompt', 'Cancel', 'Delete'].map((l) => `${name}:${l}`)),
    );
  });
});

/**
 * Routines' two error surfaces, in every state they can paint (TASK-548).
 *
 * `StatusChip`'s `error` arm (a routine's last-fire status, on every routine
 * row and every fire row) and `RoutinesList`'s error banner both painted
 * `text-destructive` on `bg-destructive/10`. That is the pairing TASK-538
 * measured on SessionRow's confirm row: over the white Settings page the /10
 * alpha drags the fill toward the red ink and lands at **4.44:1** in light
 * mode, under the floor. Dark was fine (5.71) — the same alpha over a black
 * page and over a white one are two different pixels, which is why the fix is
 * a solid per-theme token rather than a different alpha.
 *
 * The fix is the one #692/#705 made: solid `bg-destructive-soft` (4.57 light /
 * 4.63 dark with `text-destructive`). The banner also holds a ghost Dismiss
 * button. At rest it has no ink of its own and inherits the banner's red, so
 * it is measured on the banner fill; on hover it swaps to its own solid
 * `accent` / `accent-foreground` pair, measured on that.
 *
 * Classes are read OFF THE COMPONENTS. The surface is AdminShell's root: the
 * Routines tab, its list and FireRowsTable paint no fill of their own between
 * it and these two.
 */
const STATUS_CHIP_FILE = 'components/routines/StatusChip.tsx';
const ROUTINES_LIST_FILE = 'components/routines/RoutinesList.tsx';
const ADMIN_SHELL_FILE = 'components/admin/AdminShell.tsx';
const BUTTON_FILE = 'components/ui/button.tsx';

/** One arm of StatusChip's `styles` record, comments stripped. */
function statusChipArm(src: string, arm: string): string {
  const hits = [...stripComments(src).matchAll(new RegExp(`(?<![\\w-])${arm}:\\s*'([^']*)'`, 'g'))];
  if (hits.length !== 1) throw new Error(`expected exactly one "${arm}:" style arm, found ${hits.length}`);
  return hits[0]![1]!;
}

/**
 * A ghost-style variant: no resting fill and no ink of its own, exactly one
 * `hover:bg-*` and one `hover:text-*`. Any other fill or ink is refused.
 */
function ghostPaint(cls: string): { hover: { token: string; alpha: number; cls: string }; hoverText: string } {
  const tokens = cls.split(/\s+/).filter(Boolean);
  const bgs = tokens.filter((t) => /(^|:)bg-/.test(t));
  const inks = tokens.filter((t) => /(^|:)text-[a-z]/.test(t));
  if (bgs.length !== 1 || !bgs[0]!.startsWith('hover:bg-')) {
    throw new Error(`expected one bare "hover:bg-*" and no other fill, found ${bgs.join(', ') || 'none'}`);
  }
  if (inks.length !== 1 || !inks[0]!.startsWith('hover:text-')) {
    throw new Error(`expected one bare "hover:text-*" and no other ink, found ${inks.join(', ') || 'none'}`);
  }
  return { hover: bgFill(bgs[0]!.slice('hover:'.length)), hoverText: `--${inks[0]!.slice('hover:text-'.length)}` };
}

const routinesCasesRegistered: string[] = [];

describe("Routines' error chip and banner clear AA in every state", () => {
  const surface = bgFill(classNameOf(readSource(ADMIN_SHELL_FILE), 'flex flex-1 min-w-0 h-full'));
  const listSrc = readSource(ROUTINES_LIST_FILE);
  const dismiss = ghostPaint(variantClasses(readSource(BUTTON_FILE), 'ghost'));
  const chip = controlPaint(statusChipArm(readSource(STATUS_CHIP_FILE), 'error'));
  const banner = controlPaint(classNameOf(listSrc, 'data-testid="routines-list-error"'));
  const sites = [
    ['StatusChip error', chip],
    ['RoutinesList error banner', banner],
  ] as const;

  function fillColour(tokens: Map<string, string>, fill: { token: string; alpha: number }): Colour {
    const under = tokens.get(surface.token);
    const v = tokens.get(fill.token);
    expect(under, `${surface.token} missing`).toBeDefined();
    expect(v, `${fill.token} missing`).toBeDefined();
    return fill.alpha === 1 ? v! : composite(v!, fill.alpha, under!);
  }

  for (const [themeName, selector] of THEMES) {
    for (const [label, paint] of sites) {
      routinesCasesRegistered.push(`${themeName}:${label}`);
      it(`${themeName}: ${label} (${paint.text}) on ${paint.fills.map((f) => f.cls).join(', ')}`, () => {
        const tokens = tokensAfter(selector);
        const ink = tokens.get(paint.text);
        expect(ink, `${paint.text} missing`).toBeDefined();
        expect(paint.fills.length, 'an error surface paints a fill').toBeGreaterThan(0);
        for (const fill of paint.fills) {
          expect(contrast(ink!, fillColour(tokens, fill)), `${fill.state}: ${fill.cls}`).toBeGreaterThanOrEqual(
            AA_NORMAL,
          );
        }
      });
    }

    routinesCasesRegistered.push(`${themeName}:Dismiss`);
    it(`${themeName}: the banner's ghost Dismiss, on the banner at rest and on its own hover pair`, () => {
      const tokens = tokensAfter(selector);
      const rest = banner.fills.find((f) => f.state === 'rest');
      expect(rest, 'the banner paints a resting fill').toBeDefined();
      expect(
        contrast(tokens.get(banner.text)!, fillColour(tokens, rest!)),
        `resting: inherited ${banner.text} on ${rest!.cls}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
      const hoverInk = tokens.get(dismiss.hoverText);
      expect(hoverInk, `${dismiss.hoverText} missing`).toBeDefined();
      expect(
        contrast(hoverInk!, fillColour(tokens, dismiss.hover)),
        `hover: ${dismiss.hover.cls}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it('sits on an opaque page, and each error fill is one solid per-theme tint', () => {
    expect(surface).toEqual({ token: '--background', alpha: 1, cls: 'bg-background' });
    for (const [label, paint] of sites) {
      expect(paint.text, label).toBe('--destructive');
      expect(paint.hoverText, `${label} swaps no ink`).toBeUndefined();
      expect(paint.fills.map((f) => f.state), `${label}: exactly one resting fill`).toEqual(['rest']);
      expect(paint.fills[0]!.alpha, `${label}: ${paint.fills[0]!.cls} must be solid`).toBe(1);
    }
    expect(dismiss.hover.alpha, 'the ghost hover must stay solid').toBe(1);
  });

  it('measures the old `bg-destructive/10` under the floor in light mode', () => {
    const old = controlPaint('bg-destructive/10 text-destructive border border-destructive/25');
    expect(old.fills).toEqual([{ state: 'rest', token: '--destructive', alpha: 0.1, cls: 'bg-destructive/10' }]);
    const tokens = tokensAfter(':root {');
    const ink = tokens.get('--destructive')!;
    expect(contrast(ink, composite(ink, 0.1, tokens.get('--background')!))).toBeLessThan(AA_NORMAL);
  });

  it('reads a StatusChip arm and a ghost variant, and refuses shapes it cannot measure', () => {
    expect(statusChipArm("const s = { ok: 'bg-muted', error: 'bg-x text-y' };", 'error')).toBe('bg-x text-y');
    expect(() => statusChipArm("{ ok: 'a' }", 'error')).toThrow(/found 0/);
    expect(() => statusChipArm("{ error: 'a', error: 'b' }", 'error')).toThrow(/found 2/);
    expect(statusChipArm("{ /* error: 'old' */ error: 'new' }", 'error')).toBe('new');
    expect(ghostPaint('hover:bg-accent hover:text-accent-foreground')).toEqual({
      hover: { token: '--accent', alpha: 1, cls: 'bg-accent' },
      hoverText: '--accent-foreground',
    });
    expect(() => ghostPaint('bg-muted hover:bg-accent hover:text-accent-foreground')).toThrow(/other fill/);
    expect(() => ghostPaint('hover:bg-accent text-foreground hover:text-accent-foreground')).toThrow(/other ink/);
    expect(() => ghostPaint('dark:hover:bg-accent hover:text-accent-foreground')).toThrow(/other fill/);
  });

  it('registers one case per theme per site', () => {
    expect(routinesCasesRegistered).toEqual(
      THEMES.flatMap(([name]) =>
        ['StatusChip error', 'RoutinesList error banner', 'Dismiss'].map((l) => `${name}:${l}`),
      ),
    );
  });
});
