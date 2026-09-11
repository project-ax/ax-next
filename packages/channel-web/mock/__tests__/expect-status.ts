/**
 * `expect(res.status)` with the responder's identity attached on failure.
 *
 * Why this exists. On 2026-09-11 two mock admin suites returned **501** under
 * full-suite parallelism — `admin-mcp`'s "admin DELETE returns 204" and
 * `admin-connectors`' "POST with a bad slug or missing name 400s" — and neither
 * reproduced in isolation (13+ consecutive clean runs between them). A bare
 * status assertion cannot say WHO answered, and a search for the producer came
 * up empty at every layer it could be looked for:
 *
 *   - these mocks: every status is a literal, and the only computed one
 *     (`send(res, gate.status)`) is typed `401 | 403`
 *   - the rest of the repo: exactly one 501 exists, on an unrelated skills
 *     route in `src/server/routes-chat.ts`
 *   - jsdom and undici: no 501 in either
 *   - `node:http` itself: probed directly — an unknown method, a bad
 *     `Transfer-Encoding` and an HTTP/2 preface all answer 400; a bad `Expect`
 *     answers 417. Nothing answers 501.
 *
 * So the next occurrence has to identify itself rather than be re-searched for.
 * This reads the body ONLY on mismatch, so a passing assertion leaves the
 * stream untouched for a following `res.json()`, and reports status, headers
 * and body — enough to tell an application response from a proxy's or some
 * other intermediary's, which is the distinction the investigation lacked.
 *
 * Not a fix. The underlying race is unexplained and tracked separately; this
 * only guarantees the next sighting is worth something.
 */
export async function expectStatus(res: Response, expected: number): Promise<void> {
  if (res.status === expected) return;
  const body = await res.text().catch((e) => `<unreadable: ${String(e)}>`);
  const headers = Object.fromEntries(res.headers.entries());
  throw new Error(
    `expected HTTP ${expected}, got ${res.status} ${res.statusText}\n` +
      `url:     ${res.url}\n` +
      `headers: ${JSON.stringify(headers)}\n` +
      `body:    ${body.slice(0, 500)}`,
  );
}
