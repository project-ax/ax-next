import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { embedCacheWrap } from "../bench/harness.js";
import type { EmbeddingFn } from "../src/types.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dem-embed-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function countingEmbedder(): EmbeddingFn & { calls: number; texts: string[] } {
  const fn = async (texts: string[]): Promise<number[][]> => {
    fn.calls += 1;
    fn.texts.push(...texts);
    return texts.map((text) => [text.length, 1, 2]);
  };
  fn.calls = 0;
  fn.texts = [] as string[];
  return fn;
}

describe("embedding cache", () => {
  it("serves a warm entry without calling the embedder again, across process boundaries", async () => {
    const dir = tempDir();
    const first = countingEmbedder();
    const warm = embedCacheWrap(first, dir);
    expect(await warm(["alpha", "beta"], "document")).toEqual([
      [5, 1, 2],
      [4, 1, 2],
    ]);
    warm.flush();
    expect(first.calls).toBe(1);

    const second = countingEmbedder();
    const reopened = embedCacheWrap(second, dir);
    expect(await reopened(["alpha", "beta"], "document")).toEqual([
      [5, 1, 2],
      [4, 1, 2],
    ]);
    expect(second.calls).toBe(0);
  });

  it("keys on the task, so a query embedding never serves a document embedding", async () => {
    const dir = tempDir();
    const inner = countingEmbedder();
    const cache = embedCacheWrap(inner, dir);
    await cache(["alpha"], "document");
    await cache(["alpha"], "query");
    expect(inner.calls).toBe(2);
  });

  /**
   * The regression that stopped a 100-question run dead: the cache was one JSON object
   * rewritten in full on every flush, and at 536,270,828 bytes `JSON.stringify` exceeded V8's
   * max string length (536,870,888) and threw `Invalid string length`. Every remaining
   * question then scored `error`. Appending only what is new keeps each write small no matter
   * how large the cache gets — and is the property that makes the old failure impossible.
   */
  it("APPENDS only new entries — it never rewrites the whole cache", async () => {
    const dir = tempDir();
    const inner = countingEmbedder();
    const cache = embedCacheWrap(inner, dir);

    await cache(["alpha", "beta", "gamma"], "document");
    cache.flush();
    const path = join(dir, "embeddings.ndjson");
    const afterFirst = statSync(path).size;
    const firstBytes = readFileSync(path);

    await cache(["delta"], "document");
    cache.flush();
    const afterSecond = statSync(path).size;

    // The bytes written the first time are still byte-identical at the head of the file:
    // the second flush added a record, it did not re-serialize the first three.
    expect(readFileSync(path).subarray(0, afterFirst)).toEqual(firstBytes);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(4);
  });

  it("flushing twice with nothing new writes nothing", async () => {
    const dir = tempDir();
    const cache = embedCacheWrap(countingEmbedder(), dir);
    await cache(["alpha"], "document");
    cache.flush();
    const size = statSync(join(dir, "embeddings.ndjson")).size;
    cache.flush();
    expect(statSync(join(dir, "embeddings.ndjson")).size).toBe(size);
  });

  it("adopts a legacy single-object embeddings.json once, then reads the ndjson", async () => {
    const dir = tempDir();
    const probe = countingEmbedder();
    const keyed = embedCacheWrap(probe, dir);
    await keyed(["alpha"], "document");
    keyed.flush();
    const [record] = readFileSync(join(dir, "embeddings.ndjson"), "utf8").trimEnd().split("\n");
    const legacyKey = (JSON.parse(record ?? "{}") as { k: string }).k;
    rmSync(join(dir, "embeddings.ndjson"));

    writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ [legacyKey]: [9, 9, 9] }));
    const inner = countingEmbedder();
    const migrated = embedCacheWrap(inner, dir);
    expect(await migrated(["alpha"], "document")).toEqual([[9, 9, 9]]);
    expect(inner.calls).toBe(0);
    migrated.flush();

    const reopened = countingEmbedder();
    const after = embedCacheWrap(reopened, dir);
    expect(await after(["alpha"], "document")).toEqual([[9, 9, 9]]);
    expect(reopened.calls).toBe(0);
  });

  it("survives an unreadable legacy cache rather than taking the run down with it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "embeddings.json"), "{not json");
    const inner = countingEmbedder();
    const cache = embedCacheWrap(inner, dir);
    expect(await cache(["alpha"], "document")).toEqual([[5, 1, 2]]);
    expect(inner.calls).toBe(1);
  });

  it("skips a corrupt ndjson line instead of losing every entry after it", async () => {
    const dir = tempDir();
    const seed = embedCacheWrap(countingEmbedder(), dir);
    await seed(["alpha", "beta"], "document");
    seed.flush();
    const path = join(dir, "embeddings.ndjson");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, [lines[0], "{ truncated", lines[1]].join("\n") + "\n");

    const inner = countingEmbedder();
    const cache = embedCacheWrap(inner, dir);
    await cache(["alpha", "beta"], "document");
    expect(inner.calls).toBe(0);
  });
});
