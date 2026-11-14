import { clampCodeUnits, toWellFormedText } from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { CHANNEL_NAME_MAX, LABEL_MAX } from './limits.js';

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

/**
 * A Slack channel's name (from `conversations.info`), made fit to store on a
 * binding and to put in a channel turn's label for the model to read: what
 * `cleanLabel` removes, and also brackets and parentheses (they become
 * spaces), so a name can't close the label early and start a second one. At
 * most CHANNEL_NAME_MAX code units, never half an emoji. Empty when nothing
 * printable is left. Untrusted text, shown and read, never used to decide
 * anything.
 */
export function cleanChannelName(raw: string): string {
  const flat = toWellFormedText(replaceSurfaceRewriters(raw))
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clampCodeUnits(flat, CHANNEL_NAME_MAX).trimEnd();
}
