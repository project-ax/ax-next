import type Anthropic from '@anthropic-ai/sdk';

export interface CallOpts {
  model: string;
  maxTokens: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  age?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchHit[];
  summary?: string;
}

const MAX_PAUSE_ITERATIONS = 4;

// Drive a server-tool conversation to completion, accumulating every
// content block across pause_turn continuations. Generic over both web
// tools — the caller supplies the tool definition and the user prompt.
async function collectBlocks(
  client: Anthropic,
  opts: CallOpts,
  tool: Record<string, unknown>,
  userText: string,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: userText }];
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MAX_PAUSE_ITERATIONS; i += 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      tools: [tool],
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const content: Array<Record<string, unknown>> = Array.isArray(res?.content) ? res.content : [];
    blocks.push(...content);
    if (res?.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content });
  }
  return blocks;
}

export async function runWebSearch(
  client: Anthropic,
  opts: CallOpts,
  query: string,
): Promise<WebSearchOutput> {
  const blocks = await collectBlocks(
    client,
    opts,
    { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    `Search the web for: ${query}\nUse the web_search tool once, then stop.`,
  );

  const resultBlock = blocks.find((b) => b?.type === 'web_search_tool_result') as
    | { content?: unknown }
    | undefined;
  const rbContent = resultBlock?.content;
  if (resultBlock !== undefined && !Array.isArray(rbContent)) {
    const code = (rbContent as { error_code?: string } | undefined)?.error_code ?? 'unknown';
    throw new Error(`web_search failed: ${code}`);
  }

  const hits: WebSearchHit[] = Array.isArray(rbContent)
    ? (rbContent as Array<Record<string, unknown>>)
        .filter((r) => r?.type === 'web_search_result')
        .map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          ...(typeof r.page_age === 'string' && r.page_age.length > 0 ? { age: r.page_age as string } : {}),
        }))
    : [];

  const summary = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();

  return {
    query,
    results: hits,
    ...(summary.length > 0 ? { summary } : {}),
  };
}

export interface WebExtractOutput {
  url: string;
  title?: string;
  text: string;
}

export async function runWebExtract(
  client: Anthropic,
  opts: CallOpts,
  url: string,
  maxContentTokens: number,
): Promise<WebExtractOutput> {
  const blocks = await collectBlocks(
    client,
    opts,
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, max_content_tokens: maxContentTokens },
    `Fetch this URL and return its content verbatim: ${url}\nUse the web_fetch tool once, then stop.`,
  );

  const resultBlock = blocks.find((b) => b?.type === 'web_fetch_tool_result') as
    | { content?: Record<string, unknown> }
    | undefined;
  const content = resultBlock?.content;
  if (content === undefined) {
    throw new Error('web_fetch failed: no result returned');
  }
  if (content.type === 'web_fetch_tool_result_error') {
    throw new Error(`web_fetch failed: ${(content as { error_code?: string }).error_code ?? 'unknown'}`);
  }

  const doc = content.content as { source?: Record<string, unknown>; title?: unknown } | undefined;
  const source = doc?.source;
  if (source?.type !== 'text' || typeof source.data !== 'string') {
    throw new Error('web_fetch: unsupported content type (only text pages are supported; PDFs/binary are not)');
  }

  return {
    url: typeof content.url === 'string' ? (content.url as string) : url,
    ...(typeof doc?.title === 'string' && (doc.title as string).length > 0 ? { title: doc.title as string } : {}),
    text: source.data as string,
  };
}
