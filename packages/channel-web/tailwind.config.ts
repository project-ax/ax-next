// packages/channel-web/tailwind.config.ts
import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        brand: ['Inter', 'sans-serif'],
        sans: [
          '"Inter"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          '"IBM Plex Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      colors: {
        canvas: 'hsl(var(--canvas))',
        panel: 'hsl(var(--panel))',
        brand: 'hsl(var(--brand))',
        action: { DEFAULT: 'hsl(var(--action))', foreground: 'hsl(var(--action-foreground))', hover: 'hsl(var(--action-hover))' },
        send: { DEFAULT: 'hsl(var(--send))', foreground: 'hsl(var(--send-foreground))', hover: 'hsl(var(--send-hover))' },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          soft: 'hsl(var(--primary-soft))',
          hover: 'hsl(var(--primary-hover))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          soft: 'hsl(var(--destructive-soft))',
          hover: 'hsl(var(--destructive-hover))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          soft: 'hsl(var(--warning-soft))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        bubble: 'hsl(var(--bubble))',
        sidebar: 'hsl(var(--sidebar-background, var(--background)))',
        'rule-soft': 'hsl(var(--rule-soft))',
        'state-quiet': 'hsl(var(--state-quiet))',
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
        well: 'var(--radius-well)',
        lg: 'calc(var(--radius) + 4px)',
        md: 'var(--radius)',
        sm: 'calc(var(--radius) - 2px)',
      },
      boxShadow: {
        sm: 'var(--shadow-key)',
        md: 'var(--shadow-panel)',
        panel: 'var(--shadow-panel)',
        key: 'var(--shadow-key)',
        action: 'var(--shadow-action)',
        popover: 'var(--shadow-popover)',
      },
      keyframes: {
        'form-in': {
          from: { opacity: '0', transform: 'translateY(-2px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'form-in': 'form-in 180ms cubic-bezier(0.2,0.8,0.2,1) both',
      },
    },
  },
  plugins: [animate],
};

export default config;
