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
 * Facts are cached per session, and BOTH the prompt and the model that produced them are
 * part of what the entry means. Keying on the transcript alone lets a changed prompt — or a
 * different extraction model — silently reuse the old facts: the change looks inert and the
 * bench looks unchanged.
 */
export const DEFAULT_EXTRACT_MODEL = "z-ai/glm-5.3-flash:nitro";

const promptShape = (): string => EXTRACTION_SYSTEM_PROMPT + buildExtractionPrompt("", "");

export function extractionFingerprint(model: string): string {
  return createHash("sha1").update(promptShape()).update(model).digest("hex").slice(0, 8);
}

/** Entries written before the model joined the fingerprint; all of them came from GLM. */
const PROMPT_ONLY_FINGERPRINT = createHash("sha1")
  .update(promptShape())
  .digest("hex")
  .slice(0, 8);

/**
 * `fingerprint` overrides the generation this key points at. Default (undefined) is the
 * current prompt+model, which is what any run that EXTRACTS must use. Pass an explicit one
 * to read facts produced by an EARLIER prompt — after a prompt edit re-keys the cache, that
 * is the only way to diagnose against the fact store a past number was measured on.
 */
export function sessionCacheKey(
  sessionId: string,
  content: string,
  model: string,
  fingerprint?: string,
): string {
  const digest = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `${sessionId}:${fingerprint ?? extractionFingerprint(model)}:${digest}`;
}

/**
 * Adopt entries written under an older key scheme, once. Only safe for the model those
 * entries were actually produced by, so anything else is left alone to miss and re-extract.
 */
function migrateLegacyKeys(
  entries: Record<string, IngestionPayload["facts"]>,
  model: string,
): number {
  if (model !== DEFAULT_EXTRACT_MODEL) return 0;
  const current = extractionFingerprint(model);
  let migrated = 0;
  for (const [key, facts] of Object.entries(entries)) {
    const parts = key.split(":");
    const legacy =
      (parts.length === 2 && parts[0] !== undefined) ||
      (parts.length === 3 && parts[1] === PROMPT_ONLY_FINGERPRINT);
    if (!legacy) continue;
    const id = parts[0] ?? "";
    const digest = parts[parts.length - 1] ?? "";
    const upgraded = `${id}:${current}:${digest}`;
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

  constructor(cacheDir: string, model: string = DEFAULT_EXTRACT_MODEL) {
    this.path = join(cacheDir, "extraction.json");
    mkdirSync(cacheDir, { recursive: true });
    this.entries = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, IngestionPayload["facts"]>)
      : {};
    const migrated = migrateLegacyKeys(this.entries, model);
    if (migrated > 0) {
      console.log(`extraction cache: adopted ${migrated} legacy entries as ${extractionFingerprint(model)}`);
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

/**
 * Place a `network` the model invented onto one of the three the schema allows.
 *
 * `network` never filters retrieval — `recall.ts` reads none of it and `reflect.ts` maps both
 * `world` and `experience` onto the same "FACT" tag — so a wrong network costs a display tag
 * while a rejected payload costs the whole session. gpt-4.1-nano emits `network: "user"` and
 * `network: "assistant"` even after being told explicitly that network is not the speaker, and
 * lost 2 of 4 probe sessions to it. The mappings follow the contract's own wording: assistant
 * actions and records of user interactions are `experience`; beliefs and preferences are
 * `opinion`; everything unplaceable is an assertion about the world.
 */
export function coerceNetworkValue(value: unknown): string {
  if (value === "world" || value === "experience" || value === "opinion") return value;
  const text = String(value).toLowerCase();
  if (["assistant", "user", "episode", "interaction", "action"].includes(text)) return "experience";
  if (["preference", "belief", "sentiment", "subjective"].includes(text)) return "opinion";
  return "world";
}

/** Facts whose `network` had to be coerced, so an unusable extractor is visible as a number. */
export const coercionStats = { network: 0 };

function coerceFactStrings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  const coerced = { ...record };
  for (const field of ["subject", "predicate", "object"] as const) {
    const value = coerced[field];
    if (typeof value === "boolean" || typeof value === "number") coerced[field] = String(value);
  }
  const network = coerceNetworkValue(coerced.network);
  if (network !== coerced.network) {
    coercionStats.network += 1;
    coerced.network = network;
  }
  return coerced;
}

/** A short, safe description of a payload's shape for an error or repair message. */
function describeShape(raw: unknown): string {
  if (raw === null || raw === undefined) return String(raw);
  if (Array.isArray(raw)) return `an array of ${raw.length}`;
  if (typeof raw === "object") {
    const keys = Object.keys(raw as Record<string, unknown>);
    return keys.length > 0 ? `an object with keys ${keys.slice(0, 5).join(", ")}` : "an empty object";
  }
  return typeof raw;
}

/**
 * A one-line-per-distinct-mistake description of why a payload failed the schema.
 *
 * The generic retry ("was not a valid JSON object") is enough for a model that merely wrapped
 * its JSON in prose, and useless for one that is confidently wrong about a field.
 * gpt-4.1-nano reads the prompt's "USER facts / ASSISTANT facts" framing as if it named the
 * `network` enum and emits `network: "user"` on every fact; told only that something was
 * invalid, it reproduces the same output and the session is lost. Distinct issues are
 * collapsed with a count so one systematic mistake across 30 facts costs one line, not 30.
 */
export function describeValidationFailure(raw: unknown): string {
  const facts = (raw as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) {
    return `facts: expected an array of facts at the top level, received ${describeShape(raw)}`;
  }
  const parsed = IngestionPayloadSchema.safeParse({ facts: facts.map(coerceFactStrings) });
  if (parsed.success) return "";

  const counts = new Map<string, number>();
  for (const issue of parsed.error.issues) {
    // Collapse the array index so facts[0].network and facts[17].network are one complaint.
    const where =
      issue.path.reduce<string>(
        (acc, part) =>
          typeof part === "number" ? `${acc}[]` : acc === "" ? String(part) : `${acc}.${String(part)}`,
        "",
      ) || "facts";
    const received =
      issue.code === "invalid_enum_value" ? ` received ${JSON.stringify(issue.received)},` : "";
    const key = `${where}:${received} ${issue.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => (count > 1 ? `${key} (${count} facts)` : key))
    .slice(0, 5)
    .join("\n");
}

export function buildRepairPrompt(input: {
  dialogue: string;
  now: string;
  previous: string;
  detail: string;
}): string {
  return [
    buildExtractionPrompt(input.dialogue, input.now),
    "",
    "Your previous reply did not match the required shape. What was wrong with it:",
    input.detail,
    "",
    'Note: `network` is the KIND OF KNOWLEDGE, not the speaker. It is always exactly one of',
    '"world", "experience", or "opinion" — never "user" or "assistant". Record the speaker in',
    "`subject` instead (use the subject `assistant` for what the assistant said or supplied).",
    "Every fact needs network, subject, predicate, object, validStart, confidence, invalidatesPrevious.",
    "",
    "Your previous reply (first 600 chars):",
    input.previous.slice(0, 600),
    "",
    "Reply again with ONLY the corrected JSON object.",
  ].join("\n");
}

async function parsePayload(
  text: string,
  dialogue: string,
  now: string,
  llm: OpenRouterLlm,
  usageSink: { usage: LlmUsage },
): Promise<IngestionPayload> {
  // A missing `facts` array is MALFORMED and must reach the retry. `?? []` used to turn it
  // into a clean empty extraction: no throw, no retry, and the empty result cached forever.
  const attempt = (raw: unknown): IngestionPayload => {
    const facts = (raw as { facts?: unknown } | null)?.facts;
    if (!Array.isArray(facts)) {
      throw new Error(`extraction payload has no "facts" array (received ${describeShape(raw)})`);
    }
    return IngestionPayloadSchema.parse({ facts: facts.map(coerceFactStrings) });
  };
  let decoded: unknown;
  try {
    decoded = extractJson(text);
    return attempt(decoded);
  } catch {
    const retry = await llm.chat({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: buildRepairPrompt({
        dialogue,
        now,
        previous: text,
        detail:
          describeValidationFailure(decoded) ||
          "The reply was not a JSON object at all (it must start with { and contain a \"facts\" array).",
      }),
      maxTokens: 4096,
    });
    usageSink.usage.in += retry.usage.in;
    usageSink.usage.out += retry.usage.out;
    return attempt(extractJson(retry.text));
  }
}
