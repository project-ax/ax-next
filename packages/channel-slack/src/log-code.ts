import { faultLogFields } from '@ax/core';

/**
 * The one thing channel-slack logs about a failure: its code, never its
 * message. A message can quote a request body, a token, a vault ref or
 * Slack's own error text.
 *
 * The error's own code (a PluginError's, a SlackApiError's, an errno). When
 * that is only the bus's generic `unknown` wrap, the code of what it wrapped.
 * Otherwise `unknown`. Every value is identifier-shaped: faultLogFields drops
 * anything that isn't, and never throws.
 */
export function logCode(err: unknown): string {
  const fields = faultLogFields(err);
  if (fields.code !== undefined && fields.code !== 'unknown') return fields.code;
  return fields.causeCode ?? 'unknown';
}
