import { clampCodeUnits, toWellFormedText } from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { LABEL_MAX } from './limits.js';

/**
 * A name from outside (Slack's team name, auth's name for an admin), made fit
 * to store and to show on one line: no control, bidi or invisible characters
 * (a U+202E would reverse whatever the admin page draws after it), no lone
 * surrogate (Postgres refuses those), single spaces, at most LABEL_MAX units.
 * Empty when nothing printable is left.
 */
export function cleanLabel(raw: string): string {
  const flat = toWellFormedText(replaceSurfaceRewriters(raw)).replace(/\s+/g, ' ').trim();
  return clampCodeUnits(flat, LABEL_MAX).trimEnd();
}
