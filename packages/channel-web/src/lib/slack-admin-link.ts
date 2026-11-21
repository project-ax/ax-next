/**
 * A link that opens Admin › Slack (TASK-1170): @ax/channel-slack's DM to an AX
 * admin about a bot request carries `<origin>/?admin=slack` on its Approve
 * button. Only that exact pair is read; nothing from the URL reaches the page.
 * For anyone but an admin it means nothing. Keep the literal in step with
 * channel-slack's `bot-request-dms.ts`.
 */
const PARAM = 'admin';
const VALUE = 'slack';

export function readSlackAdminLink(search: string): boolean {
  return new URLSearchParams(search).get(PARAM) === VALUE;
}

/** `search` without `admin=slack`, keeping everything else ('' when nothing is left). */
export function withoutSlackAdminLink(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get(PARAM) !== VALUE) return search;
  params.delete(PARAM);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
}
