import type { Config } from 'tailwindcss';
import { accent, action, bg, fg, line, motion, radius, space, status, text, width } from '../foundation/tokens.js';

// Restricted preset: every theme key below REPLACES Tailwind's defaults, so only token-backed
// utilities exist (a token name works, a default-scale number does not). Values point at the --ax-* variables in theme.css.

const v = (name: string): string => `var(--ax-${name})`;
const hsl = (name: string): string => `hsl(var(--ax-${name}) / <alpha-value>)`;

// Variable name -> color key: drop a leading `bg-`, fold a trailing `-default`/`-base` into DEFAULT.
function colorEntries(): Record<string, string> {
  const names: string[] = [];
  for (const k of Object.keys(bg.light)) names.push(`bg-${k}`);
  for (const k of Object.keys(fg.light)) names.push(`fg-${k}`);
  for (const k of Object.keys(accent.light)) names.push(k === 'base' ? 'accent' : `accent-${k}`);
  for (const k of Object.keys(action.light)) names.push(k === 'base' ? 'action' : `action-${k}`);
  for (const k of Object.keys(line.light)) names.push(`line-${k}`);
  names.push('brand');
  for (const [tone, themes] of Object.entries(status)) {
    for (const k of Object.keys(themes.light)) names.push(k === 'base' ? `status-${tone}` : `status-${tone}-${k}`);
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    const key = name.replace(/^bg-/, '').replace(/-(default|base)$/, '') || 'DEFAULT';
    out[key] = hsl(name);
  }
  return out;
}

// Control sizes: not part of the spacing scale, so they get their own keys (md control 40px, sm 36px, touch target 44px).
const CONTROL = { 'control-sm': '36px', 'control-md': '40px', touch: '44px' };

// Avatar sizes (xs 16, sm 20, md 26, lg 36 px): square boxes, named tokens rather than arbitrary values.
const AVATAR = { 'avatar-xs': '16px', 'avatar-sm': '20px', 'avatar-md': '26px', 'avatar-lg': '36px' };

const keyed = <T extends Record<string, unknown>>(group: T, f: (k: string) => string): Record<string, string> =>
  Object.fromEntries(Object.keys(group).map((k) => [k, f(k)]));

export const axPreset: Config = {
  content: [],
  prefix: 'ax-',
  corePlugins: { preflight: false },
  theme: {
    screens: { md: '768px', lg: '1024px' },
    spacing: keyed(space, (k) => v(`space-${k}`)),
    colors: { transparent: 'transparent', current: 'currentColor', ...colorEntries() },
    fontSize: {
      ...Object.fromEntries(
        Object.keys(text).map((role) => [
          role,
          [v(`text-${role}-size`), { lineHeight: v(`text-${role}-line`), fontWeight: v(`text-${role}-weight`) }],
        ]),
      ),
      // Avatar initials, about 38% of the tile (the old AgentTile ratio, floored at 9px).
      'avatar-xs': ['9px', { lineHeight: '1', fontWeight: '500' }],
      'avatar-sm': ['9px', { lineHeight: '1', fontWeight: '500' }],
      'avatar-md': ['10px', { lineHeight: '1', fontWeight: '500' }],
      'avatar-lg': ['14px', { lineHeight: '1', fontWeight: '500' }],
    },
    fontFamily: { sans: v('font-sans'), mono: v('font-mono') },
    borderRadius: keyed(radius, (k) => v(`radius-${k}`)),
    boxShadow: { flat: v('elevation-flat'), raised: v('elevation-raised'), overlay: v('elevation-overlay') },
    maxWidth: keyed(width, (k) => v(`width-${k}`)),
    transitionDuration: keyed(motion, (k) => v(`motion-${k}`)),
    animation: { none: 'none', spin: 'spin 1s linear infinite', pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' },
    keyframes: {
      spin: { to: { transform: 'rotate(360deg)' } },
      pulse: { '50%': { opacity: '0.5' } },
    },
    // Added on top of the token scales: control heights (Button, IconButton), the 44px touch target below md, and the skeleton block height / 90% line width.
    extend: {
      height: { ...CONTROL, ...AVATAR, 'skeleton-block': '160px' },
      width: { ...CONTROL, ...AVATAR, '9/10': '90%' },
      minHeight: CONTROL,
      minWidth: CONTROL,
      // A shrink-to-fit inline box (StatusBadge) caps at its container so its text can truncate.
      maxWidth: { full: '100%' },
    },
  },
};

export default axPreset;
