import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/db/client.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

const db = openDatabase({ path: ":memory:" });

const embed = (text: string): number[] => {
  const vec = new Array<number>(384).fill(0);
  let hash = 2166136261;
  for (const token of text.toLowerCase().split(/\s+/)) {
    for (const ch of token) {
      hash ^= ch.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619) >>> 0;
      const index = hash % 384;
      vec[index] = (vec[index] ?? 0) + 1;
    }
  }
  const norm = Math.hypot(...vec);
  return vec.map((v) => v / norm);
};

const toBlob = (vec: number[]): Buffer => Buffer.from(new Float32Array(vec).buffer);

const id = randomUUID();
const vec = embed("sam prefers python fastapi");
db.prepare(
  `INSERT INTO memories (id, bank_id, network, subject, predicate, object, confidence, valid_start)
   VALUES (?, ?, 'world', 'sam', 'prefers_backend', 'python fastapi', 1.0, '2025-01-15T00:00:00.000Z')`,
).run(id, "test");
db.prepare(`INSERT INTO memories_fts (id, subject, predicate, object) VALUES (?, ?, ?, ?)`).run(
  id,
  "sam",
  "prefers_backend",
  "python fastapi",
);
db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(id, toBlob(vec));

const knn = db
  .prepare(`SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = 5 ORDER BY distance`)
  .get(toBlob(embed("sam prefers python fastapi"))) as { id: string; distance: number } | undefined;
assert(knn !== undefined, "vec0 KNN MATCH query with k constraint returns a row");
assert(knn?.id === id, "vec0 KNN returns the inserted id first");
assert((knn?.distance ?? 1) < 1e-5, `cosine distance to identical vector is ~0 (got ${knn?.distance})`);

const cosine = db
  .prepare(`SELECT vec_distance_cosine(vec_f32(?), vec_f32(?)) AS d`)
  .get(toBlob(embed("sam prefers python fastapi")), toBlob(embed("sam prefers python fastapi"))) as {
  d: number;
};
assert(Math.abs(cosine.d) < 1e-5, `vec_distance_cosine(identical) ~ 0 (got ${cosine.d})`);

const fts = db
  .prepare(
    `SELECT m.id, bm25(memories_fts) AS rank
     FROM memories_fts f JOIN memories m ON m.id = f.id
     WHERE memories_fts MATCH ? AND m.bank_id = ? AND m.valid_end = '9999-12-31T23:59:59.999Z'
     ORDER BY rank`,
  )
  .all("prefers", "test") as Array<{ id: string; rank: number }>;
assert(fts.length === 1 && fts[0]?.id === id, "FTS5 MATCH + bm25 ranking finds the row");

const orthogonal = db
  .prepare(`SELECT vec_distance_cosine(vec_f32(?), vec_f32(?)) AS d`)
  .get(
    toBlob(embed("completely unrelated topic gardening")),
    toBlob(embed("sam prefers python fastapi")),
  ) as { d: number };
assert(orthogonal.d > 0.5, `vec_distance_cosine(disjoint texts) is meaningfully large (got ${orthogonal.d})`);

const jsonVec = db.prepare(`SELECT length(vec_f32(?)) AS bytes`).get(JSON.stringify(vec)) as {
  bytes: number;
};
assert(jsonVec.bytes === 384 * 4, `vec_f32 accepts a JSON array of 384 floats (got ${jsonVec.bytes} bytes)`);

db.close();
console.log("\nAll database verifications passed.");
