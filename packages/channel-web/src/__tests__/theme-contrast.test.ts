/**
 * Every accent pair in both themes, measured against the WCAG AA floor.
 *
 * A browser walk found two buttons below it: "Just this once" on the permission
 * card at 3.75:1 and "Turn it off anyway" on the sign-in lockout dialog at
 * 3.40:1 — the two most consequential buttons in the product. Both were white
 * text on an accent that dark mode had deliberately LIGHTENED (primary 44% ->
 * 52%, destructive 55% -> 62%), which moves the accent toward white and
 * squeezes the text on top of it.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** `"211 100% 52%"` (the bare triple Tailwind wraps in `hsl()`) -> sRGB 0-255. */
function hslTripleToRgb(triple: string): [number, number, number] {
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

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hslTripleToRgb(a));
  const lb = luminance(hslTripleToRgb(b));
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
 * Measured rather than assumed — 5.05 over white, 5.52 over dark
 * `--background`, 4.68 over dark `--card` — so it passes and gets no row.
 *
 * It passes only BECAUSE it is fractional, which is the part worth writing
 * down: quiet text on a SOLID `bg-warning-soft` would be **4.10:1** in dark
 * mode, under the floor. Nothing renders that today — the solid `-soft`
 * surfaces carry their own accent text, not the quiet token — so there is
 * nothing to fix and no row to add. But a `-soft` surface is the likeliest
 * next place this defect appears, and it is the one shape nothing in this file
 * bounds. (For the record, solid light: warning-soft 4.81, destructive-soft
 * 4.64, primary-soft 4.55. Dark: 4.10 / 4.63 / 4.69.)
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
