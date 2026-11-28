// The one tone map for status: shape (second channel, never colour alone), mark colour, and the badge emphasis ladder.
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type StatusShape = 'diamond' | 'square' | 'circle' | 'check' | 'ring';

export const SHAPE: Record<StatusTone, StatusShape> = {
  warning: 'diamond',
  danger: 'square',
  info: 'circle',
  success: 'check',
  neutral: 'ring',
};

export const MARK_COLOR: Record<StatusTone, string> = {
  neutral: 'ax-text-status-neutral',
  info: 'ax-text-status-info',
  success: 'ax-text-status-success',
  warning: 'ax-text-status-warning',
  danger: 'ax-text-status-danger',
};

// Emphasis ladder: danger > warning > info > neutral >= success. Neutral and success share the plain raised fill
// (muted text, coloured mark), so a success is never louder than a warning.
export const BADGE_TONE: Record<StatusTone, string> = {
  danger: 'ax-bg-status-danger-soft ax-text-status-danger',
  warning: 'ax-bg-status-warning-soft ax-text-status-warning',
  info: 'ax-bg-status-info-soft ax-text-status-info',
  neutral: 'ax-bg-surface-raised ax-text-fg-muted',
  success: 'ax-bg-surface-raised ax-text-fg-muted',
};
