/** Chat downloads are rendered from persisted attachments, through file chips. */
interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
}

function isFileDownload(url: string): boolean {
  return /^ax:\/\/artifact\//i.test(url) || /^\/api\/files(?:[?#]|$)/.test(url);
}

/** An otherwise empty download paragraph may carry a file emoji. */
function isDecoration(node: MarkdownNode): boolean {
  if (node.type === 'text') {
    return (node.value ?? '').replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]/gu, '') === '';
  }
  return (node.type === 'emphasis' || node.type === 'strong') &&
    (node.children ?? []).every(isDecoration);
}

/**
 * Remove download links from parsed markdown, preserving prose, ordinary links,
 * and code examples. Shared with find so hidden link labels cannot be matches.
 * Operates before URL sanitization, which otherwise blanks the artifact URL
 * but leaves its label visible as a second download control.
 */
export function remarkFileDownloads() {
  return (tree: MarkdownNode) => {
    const definitions = new Map<string, string>();
    function collect(node: MarkdownNode) {
      if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined &&
        !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      node.children?.forEach(collect);
    }
    collect(tree);

    function clean(node: MarkdownNode): boolean {
      if (node.children === undefined) return false;
      let removed = false;
      node.children = node.children.filter(child => {
        const url = child.type === 'link' ? child.url
          : child.type === 'linkReference' ? definitions.get(child.identifier ?? '') : undefined;
        if (url !== undefined && isFileDownload(url)) {
          removed = true;
          return false;
        }
        const nestedRemoval = clean(child);
        removed ||= nestedRemoval;
        return !(nestedRemoval && child.type === 'paragraph' &&
          (child.children ?? []).every(isDecoration));
      });
      return removed;
    }
    clean(tree);
  };
}
