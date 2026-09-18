/**
 * `run.ts` calls `flush()` once per QUESTION. It used to re-serialize and rewrite the whole
 * 65 MB cache every time, which cost more wall clock than the actual work (8.7s/question of
 * answering became 38s/question) and made two concurrent bench arms two processes truncating
 * one file — an interleaved write there corrupts ~$7 and ~5h of extraction. A run pinned to a
 * past generation adds nothing, so the common case must be a no-op, and the writes that do
 * happen must be atomic.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtractionCache } from "../bench/extraction.js";

const fact = { network: "world", subject: "s", predicate: "p", object: "o" } as never;

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "dem-cache-"));
}

describe("ExtractionCache.flush", () => {
  it("does not touch the file when nothing was added", () => {
    const dir = freshDir();
    const path = join(dir, "extraction.json");
    writeFileSync(path, JSON.stringify({ "s1:fp:abc": [fact] }));
    const before = statSync(path);
    const cache = new ExtractionCache(dir, "some-model-with-no-legacy-entries");
    cache.get("s1:fp:abc");
    cache.flush();
    cache.flush();
    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it("writes when an entry was added, and leaves no temp file behind", () => {
    const dir = freshDir();
    const cache = new ExtractionCache(dir, "some-model-with-no-legacy-entries");
    cache.put("s2:fp:def", [fact]);
    cache.flush();
    const entries = JSON.parse(readFileSync(join(dir, "extraction.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(entries)).toContain("s2:fp:def");
    // temp-then-rename must not leave debris a later run would try to parse
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("clears the dirty flag, so a second flush is again a no-op", () => {
    const dir = freshDir();
    const cache = new ExtractionCache(dir, "some-model-with-no-legacy-entries");
    cache.put("s3:fp:ghi", [fact]);
    cache.flush();
    const first = statSync(join(dir, "extraction.json"));
    cache.flush();
    expect(statSync(join(dir, "extraction.json")).mtimeMs).toBe(first.mtimeMs);
  });
});
