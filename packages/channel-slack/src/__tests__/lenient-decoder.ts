/**
 * A lenient decoder, for tests: what Markdown or HTML could make of a reply
 * before Slack looks for mentions (whether Slack decodes at all is
 * unmeasured: TASK-1097's walk). Numeric references, the named ones that
 * spell a mention's characters (`&nvlt;` read as a plain `<`), and HTML's
 * legacy `&lt`/`&gt` with no `;`. One pass, left to right, like a decoder.
 */
export function decoded(text: string): string {
  const named: Record<string, string> = { excl: '!', commat: '@', num: '#', lt: '<', gt: '>', nvlt: '<' };
  return text.replace(
    /&#x([0-9a-f]+);?|&#([0-9]+);?|&(excl|commat|num|lt|gt|nvlt);|&(lt|gt)/gi,
    (m: string, hex?: string, dec?: string, full?: string, legacy?: string) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
      return named[(full ?? legacy ?? '').toLowerCase()] ?? m;
    },
  );
}

/** Slack's references (`<!…>`, `<@…>`, `<#…>`) and bare broadcast words. */
const LIVE = /<[!@#]|(?<![A-Za-z0-9])@(?:here|channel|everyone)(?![A-Za-z0-9])/i;

/** The text, decoded, holds a live reference or broadcast. */
export function spellsMention(text: string): boolean {
  return LIVE.test(decoded(text));
}
