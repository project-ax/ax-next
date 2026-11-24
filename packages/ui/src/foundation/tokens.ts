// Design tokens: the single source for @project-ax/ui. Starting values are channel-web's index.css.
// Colors are bare HSL triplets (no `hsl()`), so Tailwind opacity modifiers keep working.

export const bg = {
  light: {
    canvas: '216.00 17.24% 94.31%',
    surface: '220.00 42.86% 98.63%',
    'surface-raised': '0.00 0.00% 100.00%',
    overlay: '0.00 0.00% 100.00%',
    muted: '216.00 17.24% 94.31%',
  },
  dark: {
    canvas: '230.00 15.00% 7.84%',
    surface: '226.67 15.25% 11.57%',
    'surface-raised': '226.15 14.94% 17.06%',
    overlay: '226.15 14.94% 17.06%',
    muted: '226.15 14.94% 17.06%',
  },
} as const;

export const fg = {
  light: {
    default: '201.82 8.27% 26.08%',
    muted: '201.18 8% 41%',
    subtle: '217.89 7.69% 51.57%',
    inverse: '0.00 0.00% 100.00%',
    link: '242.71 63.03% 58.63%',
  },
  dark: {
    default: '220.00 13.04% 90.98%',
    muted: '219.00 11.90% 67.06%',
    subtle: '221.74 10.31% 56.27%',
    inverse: '200.00 11.54% 10.20%',
    link: '245.33 100.00% 82.35%',
  },
} as const;

export const accent = {
  light: {
    base: '242.71 63.03% 58.63%',
    soft: '243.75 100.00% 96.86%',
    hover: '243.26 53.09% 52.35%',
    fg: '0.00 0.00% 100.00%',
  },
  dark: {
    base: '245.33 100.00% 82.35%',
    soft: '246.92 25.49% 20.00%',
    hover: '245.54 100.00% 87.25%',
    fg: '200.00 11.54% 10.20%',
  },
} as const;

export const action = {
  light: { base: '200.00 11.54% 10.20%', hover: '204.00 9.43% 20.78%' },
  dark: { base: '228.00 17.24% 94.31%', hover: '0.00 0.00% 100.00%' },
} as const;

export const line = {
  light: {
    border: '220.00 18.37% 90.39%',
    soft: '222.86 18.92% 92.75%',
    input: '245.14 100.00% 93.14%',
    ring: '242.71 63.03% 58.63%',
  },
  dark: {
    border: '225.00 13.11% 23.92%',
    soft: '227.14 13.73% 20.00%',
    input: '250.00 18.99% 30.98%',
    ring: '245.33 100.00% 82.35%',
  },
} as const;

export const brand = {
  light: { base: '244.09 57.14% 30.20%' },
  dark: { base: '248.11 100.00% 92.75%' },
} as const;

export const status = {
  neutral: {
    light: { base: fg.light.muted, soft: bg.light.muted, fg: fg.light.default },
    dark: { base: fg.dark.muted, soft: bg.dark.muted, fg: fg.dark.default },
  },
  info: {
    light: { base: accent.light.base, soft: accent.light.soft, fg: accent.light.fg },
    dark: { base: accent.dark.base, soft: accent.dark.soft, fg: accent.dark.fg },
  },
  success: {
    light: { base: '152 55% 28%', soft: '152 45% 94%', fg: '0 0% 100%' },
    dark: { base: '152 50% 62%', soft: '152 35% 16%', fg: '223 45% 12%' },
  },
  warning: {
    light: { base: '15 85% 36%', soft: '15 100% 94%', fg: '0 0% 100%' },
    dark: { base: '15 100% 70%', soft: '15 50% 18%', fg: '223 45% 12%' },
  },
  danger: {
    light: { base: '0 60% 49%', soft: '0 60% 96%', hover: '0 60% 45%', fg: '0 0% 100%' },
    dark: { base: '4 86% 66%', soft: '4 60% 16%', hover: '4 86% 68%', fg: '223 45% 12%' },
  },
} as const;

export const space = {
  none: '0',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  section: '32px',
} as const;

export const radius = {
  none: '0',
  sm: '7px',
  md: '9px',
  lg: '16px',
  full: '9999px',
} as const;

export const elevation = {
  light: {
    flat: 'none',
    raised: '0 7px 18px hsl(222 18% 72% / 0.08)',
    overlay: '0 12px 40px -8px hsl(220 18% 40% / 0.18), 0 2px 6px hsl(220 18% 40% / 0.04)',
  },
  dark: {
    flat: 'none',
    raised: '0 7px 18px hsl(0 0% 0% / 0.22)',
    overlay: '0 12px 40px -8px hsl(0 0% 0% / 0.5), 0 2px 6px hsl(0 0% 0% / 0.22)',
  },
} as const;

export const motion = {
  instant: '0ms',
  fast: '120ms',
  base: '180ms',
} as const;

export const ease = 'cubic-bezier(0.2,0.8,0.2,1)';

export const width = {
  narrow: '360px',
  form: '480px',
  content: '680px',
  wide: '900px',
} as const;

export const font = {
  sans: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

export const text = {
  display: { size: '30px', line: '41px', weight: 600, font: 'sans' },
  title: { size: '22px', line: '28px', weight: 600, font: 'sans' },
  heading: { size: '17px', line: '24px', weight: 600, font: 'sans' },
  subheading: { size: '14px', line: '20px', weight: 500, font: 'sans' },
  body: { size: '15px', line: '22px', weight: 400, font: 'sans' },
  'body-strong': { size: '15px', line: '22px', weight: 500, font: 'sans' },
  meta: { size: '13px', line: '18px', weight: 400, font: 'sans' },
  caption: { size: '12px', line: '16px', weight: 400, font: 'sans' },
  code: { size: '13px', line: '20px', weight: 400, font: 'mono' },
} as const satisfies Record<string, { size: string; line: string; weight: 400 | 500 | 600; font: 'sans' | 'mono' }>;

export type BgToken = keyof typeof bg.light;
export type FgToken = keyof typeof fg.light;
export type StatusTone = keyof typeof status;
export type SpaceToken = keyof typeof space;
export type TextRole = keyof typeof text;
export type RadiusToken = keyof typeof radius;
export type ElevationToken = keyof typeof elevation.light;
export type MotionToken = keyof typeof motion;
export type WidthToken = keyof typeof width;
