/**
 * Status presentation — one place that maps a FleetStatus to its user-facing
 * label, dot color, and badge classes. Section headers, cards, and the detail
 * sheet all read from here so the wall never drifts. All colors are semantic
 * tokens (Invariant #6) — `warning` is the "needs you" accent.
 */
import { AlertTriangle, CircleDot, Hand, Moon } from 'lucide-react';
import type { FleetStatus } from '../../lib/fleet-data';

export interface StatusMeta {
  /** Plain-language label for a non-technical operator. */
  label: string;
  /** Section heading on the wall. */
  heading: string;
  /** Tailwind classes for the status dot. */
  dot: string;
  /** Tailwind classes for the badge pill. */
  badge: string;
  icon: typeof CircleDot;
}

export const STATUS_META: Record<FleetStatus, StatusMeta> = {
  waiting: {
    label: 'needs you',
    heading: 'Needs you',
    dot: 'bg-warning',
    badge: 'bg-warning-soft text-warning border-transparent',
    icon: Hand,
  },
  working: {
    label: 'working',
    heading: 'Working now',
    dot: 'bg-primary',
    badge: 'bg-primary-soft text-primary border-transparent',
    icon: CircleDot,
  },
  error: {
    label: 'stopped',
    heading: 'Stopped',
    dot: 'bg-destructive',
    badge: 'bg-destructive-soft text-destructive border-transparent',
    icon: AlertTriangle,
  },
  idle: {
    label: 'idle',
    heading: 'Idle',
    dot: 'bg-muted-foreground/40',
    badge: 'bg-muted text-muted-foreground border-transparent',
    icon: Moon,
  },
};
