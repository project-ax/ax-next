function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blocksToText(blocks: unknown[]): string {
  let out = '';
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') out += (out.length > 0 ? '\n' : '') + t;
    }
  }
  return out.trim();
}

export interface SilenceConfig {
  silenceToken: string | null;
  silenceMaxChars: number;
}

export function applySilenceLogic(
  contentBlocks: unknown[],
  cfg: SilenceConfig,
): { silenced: boolean } {
  const token = cfg.silenceToken;
  if (token === null || token.length === 0) return { silenced: false };
  const text = blocksToText(contentBlocks);
  if (text.length === 0) return { silenced: false };

  const startsWith = text.startsWith(token);
  const endsWith = text.endsWith(token);
  if (!startsWith && !endsWith) return { silenced: false };

  const escaped = escapeRegex(token);
  const remainder = text
    .replace(new RegExp(`^${escaped}`), '')
    .replace(new RegExp(`${escaped}$`), '')
    .trim();
  return { silenced: remainder.length <= cfg.silenceMaxChars };
}
