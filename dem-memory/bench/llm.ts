export interface LlmUsage {
  in: number;
  out: number;
}

export interface ChatRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  usage: LlmUsage;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterLlm {
  private readonly apiKey: string;
  readonly model: string;
  private readonly reasoningEffort: string;

  constructor(options: { apiKey: string; model: string; reasoningEffort?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort ?? "minimal";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              ...(request.system ? [{ role: "system", content: request.system }] : []),
              { role: "user", content: request.user },
            ],
            max_tokens: request.maxTokens ?? 2048,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            reasoning: { effort: this.reasoningEffort },
          }),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
          await delay(1000 * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = payload.choices?.[0]?.message?.content ?? "";
        return {
          text,
          usage: {
            in: payload.usage?.prompt_tokens ?? 0,
            out: payload.usage?.completion_tokens ?? 0,
          },
        };
      } catch (error) {
        lastError = error;
        await delay(1000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text) ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}
