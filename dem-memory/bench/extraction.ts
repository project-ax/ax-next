import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenRouterLlm, extractJson, type LlmUsage } from "./llm.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
} from "../src/engine/retain.js";
import { IngestionPayloadSchema, type ExtractFn, type IngestionPayload } from "../src/types.js";

export interface ExtractionCacheStats {
  hits: number;
  misses: number;
}

/**
 * Facts are cached per session, and the prompt that produced them is part of what the entry
 * means. Keying on the transcript alone lets a changed extraction prompt silently reuse facts
 * extracted under the old one — the fix looks inert and the bench looks unchanged.
 */
const PROMPT_FINGERPRINT = createHash("sha1")
  .update(EXTRACTION_SYSTEM_PROMPT)
  .update(buildExtractionPrompt("", ""))
  .digest("hex")
  .slice(0, 8);

export function sessionCacheKey(sessionId: string, content: string): string {
  const digest = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `${sessionId}:${PROMPT_FINGERPRINT}:${digest}`;
}

/** Legacy entries predate prompt fingerprinting; they were produced by whatever prompt was
 *  current when they were written, so adopt them once under today's fingerprint. */
function migrateLegacyKeys(entries: Record<string, IngestionPayload["facts"]>): number {
  let migrated = 0;
  for (const [key, facts] of Object.entries(entries)) {
    const parts = key.split(":");
    if (parts.length !== 2) continue;
    const upgraded = `${parts[0]}:${PROMPT_FINGERPRINT}:${parts[1]}`;
    if (entries[upgraded] === undefined) {
      entries[upgraded] = facts;
      migrated += 1;
    }
    delete entries[key];
  }
  return migrated;
}

export class ExtractionCache {
  private readonly path: string;
  private readonly entries: Record<string, IngestionPayload["facts"]>;
  stats: ExtractionCacheStats = { hits: 0, misses: 0 };

  constructor(cacheDir: string) {
    this.path = join(cacheDir, "extraction.json");
    mkdirSync(cacheDir, { recursive: true });
    this.entries = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, IngestionPayload["facts"]>)
      : {};
    const migrated = migrateLegacyKeys(this.entries);
    if (migrated > 0) {
      console.log(`extraction cache: adopted ${migrated} un-fingerprinted entries as ${PROMPT_FINGERPRINT}`);
      this.flush();
    }
  }

  get(key: string): IngestionPayload["facts"] | undefined {
    const hit = this.entries[key];
    if (hit) this.stats.hits += 1;
    else this.stats.misses += 1;
    return hit;
  }

  put(key: string, facts: IngestionPayload["facts"]): void {
    this.entries[key] = facts;
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries));
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }
}

export function createGlmExtractor(
  llm: OpenRouterLlm,
  cache?: ExtractionCache,
): ExtractFn & { usage: LlmUsage } {
  const wrapper = async (dialogue: string, context: { now: string }): Promise<IngestionPayload> => {
    const response = await llm.chat({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: buildExtractionPrompt(dialogue, context.now),
      maxTokens: 4096,
    });
    wrapper.usage.in += response.usage.in;
    wrapper.usage.out += response.usage.out;
    return parsePayload(response.text, dialogue, context.now, llm, wrapper);
  };
  wrapper.usage = { in: 0, out: 0 };
  return wrapper;
}

function coerceFactStrings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  const coerced = { ...record };
  for (const field of ["subject", "predicate", "object"] as const) {
    const value = coerced[field];
    if (typeof value === "boolean" || typeof value === "number") coerced[field] = String(value);
  }
  return coerced;
}

async function parsePayload(
  text: string,
  dialogue: string,
  now: string,
  llm: OpenRouterLlm,
  usageSink: { usage: LlmUsage },
): Promise<IngestionPayload> {
  const attempt = (raw: unknown): IngestionPayload =>
    IngestionPayloadSchema.parse({
      facts: (raw as { facts?: unknown[] }).facts?.map(coerceFactStrings) ?? [],
    });
  try {
    return attempt(extractJson(text));
  } catch {
    const retry = await llm.chat({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: [
        buildExtractionPrompt(dialogue, now),
        "",
        "Your previous reply was not a valid JSON object matching the required shape. Every fact MUST include network (one of \"world\", \"experience\", \"opinion\"), subject, predicate, object, validStart, confidence, invalidatesPrevious.",
        "Your previous reply (first 600 chars):",
        text.slice(0, 600),
        "",
        "Reply again with ONLY the corrected JSON object.",
      ].join("\n"),
      maxTokens: 4096,
    });
    usageSink.usage.in += retry.usage.in;
    usageSink.usage.out += retry.usage.out;
    return attempt(extractJson(retry.text));
  }
}
