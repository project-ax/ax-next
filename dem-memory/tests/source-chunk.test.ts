import { describe, expect, it } from "vitest";
import { findSourceChunk } from "../src/engine/source-chunk.js";

/**
 * The motivating case. LongMemEval `8aef76bc` asks which sealant the assistant recommended for
 * a newspaper flower vase. gpt-4.1-nano extracted the project LIST but dropped "Mod Podge", so
 * the fact reached the table with the answer compressed out of it and dem refused. Hindsight
 * answered it correctly from a raw transcript chunk carried alongside the fact — none of its
 * 232 retrieved memories contained the string either.
 *
 * Attribution is heuristic on purpose: the extractor gives us no pointer back to the turn a
 * fact came from, and asking it for one would change the extraction prompt, which re-keys the
 * fact cache and forces a full cold re-extract. Matching the fact to its best-scoring turn
 * costs nothing and is good enough for a safety net.
 */
const DIALOGUE = [
  "user: I want DIY home decor projects using recycled materials.",
  "assistant: Here are five projects. 1. Wine Cork Bulletin Board - glue corks to a frame. 2. Newspaper Flower Vase - roll newspaper into tubes, shape them around a jar, then seal the vase with Mod Podge or another sealant to make it water-resistant. 3. Bottle Cap Coasters. 4. Mason Jar Wall Planter. 5. Scrap Fabric Rag Rug.",
  "user: I love the wine cork board and the coasters, I'll try those.",
  "assistant: Great choices. Both are beginner friendly and cost almost nothing.",
].join("\n");

describe("findSourceChunk", () => {
  it("recovers the detail the extractor compressed away", () => {
    const chunk = findSourceChunk(
      "assistant suggested diy projects: recycled-material decor projects: wine cork bulletin board, newspaper flower vase, bottle cap coasters",
      DIALOGUE,
    );
    expect(chunk).toBeDefined();
    expect(chunk).toContain("Mod Podge");
  });

  it("picks the turn the fact came from, not merely the longest one", () => {
    const chunk = findSourceChunk("user likes projects: wine cork board and bottle cap coasters", DIALOGUE);
    expect(chunk).toContain("I love the wine cork board");
    expect(chunk).not.toContain("Mason Jar");
  });

  it("never exceeds the requested width", () => {
    const chunk = findSourceChunk("assistant suggested diy projects: newspaper flower vase", DIALOGUE, 120);
    expect(chunk).toBeDefined();
    expect((chunk ?? "").length).toBeLessThanOrEqual(120);
  });

  it("centres the window on the matching region of a long turn", () => {
    // The vase instructions sit in the MIDDLE of a ~320-char turn; a naive head-slice would
    // return the wine cork sentence and lose the sealant entirely.
    const chunk = findSourceChunk(
      "assistant described newspaper flower vase: roll newspaper into tubes and seal it",
      DIALOGUE,
      160,
    );
    expect(chunk).toContain("Mod Podge");
  });

  it("returns undefined when nothing in the source is related", () => {
    expect(findSourceChunk("postgres database runs on: port 5432", DIALOGUE)).toBeUndefined();
  });

  it("returns undefined for empty input rather than an empty string", () => {
    expect(findSourceChunk("anything at all", "")).toBeUndefined();
    expect(findSourceChunk("", DIALOGUE)).toBeUndefined();
  });

  it("strips the flattened transcript's role prefix and timestamp", () => {
    const withMeta = "[2023-05-20T10:00:00.000Z] assistant: seal the vase with Mod Podge or another sealant";
    const chunk = findSourceChunk("assistant recommended sealant: mod podge", withMeta);
    expect(chunk).toBeDefined();
    expect(chunk).not.toContain("2023-05-20T10:00:00.000Z");
    expect(chunk).toContain("Mod Podge");
  });
});
