/**
 * The words an agent's Slack card never shows (design §4b.2, TASK-1187): the
 * plumbing nobody should have to learn, and the product's own name (the app is
 * white-labeled through Branding). Admin › Slack keeps the plumbing words. The
 * install-it-myself path (the self path's token steps and the Reconnect dialog)
 * is the one place "configuration token" may show, so callers never scan it.
 * It also lists the per-channel memory switch's words (TASK-1202 removed the
 * switch: no row says "Not remembered" or offers "Remember this channel").
 */
const PLUMBING =
  /\b(?:approvers?|requesters?|claim(?:s|ed|ing)?|rebuild(?:s|ing)?|rebuilt|shared app|own (?:slack )?bot|configuration tokens?|(?:don['’]t )?remember this channel|not remembered)\b/gi;
const PRODUCT = /\bAX\b/g;

/** Every forbidden word in `text`, as written there. Empty: clean. */
export function slackCardWordsFound(text: string): string[] {
  return [...(text.match(PLUMBING) ?? []), ...(text.match(PRODUCT) ?? [])];
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
