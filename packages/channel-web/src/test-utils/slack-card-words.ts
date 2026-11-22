/**
 * The words an agent's Slack card never shows (design §4b.2, TASK-1187): the
 * plumbing nobody should have to learn, and the product's own name (the app is
 * white-labeled through Branding). Admin › Slack keeps the plumbing words. The
 * install-it-myself path (the self path's token steps and the Reconnect dialog)
 * is the one place "configuration token" may show, so callers never scan it.
 */
const PLUMBING =
  /\b(?:approvers?|requesters?|claim(?:s|ed|ing)?|rebuild(?:s|ing)?|rebuilt|shared app|own (?:slack )?bot|configuration tokens?)\b/gi;
const PRODUCT = /\bAX\b/g;
/**
 * The removed per-channel memory switch's own labels (TASK-1202): no row
 * offers "Remember this channel" or says "Not remembered" any more. Exact
 * labels only, so a later sentence that happens to say "not remembered" is
 * not caught as the switch.
 */
const REMOVED_SWITCH = /(?:\bdon['’]t remember this channel\b|\bremember this channel\b|^\s*not remembered\s*$)/gim;

/** Every forbidden word in `text`, as written there. Empty: clean. */
export function slackCardWordsFound(text: string): string[] {
  return [...(text.match(PLUMBING) ?? []), ...(text.match(PRODUCT) ?? []), ...(text.match(REMOVED_SWITCH) ?? [])];
}

/** What a person can read now: the body's text (menus and dialogs portal into it) and every aria-label. */
export function slackCardText(root: Element = document.body): string {
  // Text nodes joined by newlines: `textContent` glues neighbouring elements
  // ("Rebuild" + "Rename" -> "RebuildRename"), so `\b` never sees the word.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? '');
  const labels = [...root.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '');
  // `textContent` too: a phrase split across text nodes ("own {kind} bot" in JSX) only reads whole there.
  return [...texts, root.textContent ?? '', ...labels].join('\n');
}
