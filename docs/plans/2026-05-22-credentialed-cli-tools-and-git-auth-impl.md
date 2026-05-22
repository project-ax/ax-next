# Credentialed CLI tools & git Basic-auth egress — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `git clone` over HTTPS Basic-auth work through the credential-proxy (sub-project **B**) and let an admin-installed skill declare third-party CLI packages (`npm`/`pypi`) that the agent runs via `npx`/`uvx` with the registry host auto-allowlisted and the interpreters present in the image (sub-project **D**).

**Architecture:** **B** adds one bounded transform to the credential-proxy MITM client→upstream path: a per-request HTTP/1.1 framing state machine that buffers each request head, decodes any `Authorization`/`Proxy-Authorization: Basic` value, canary-scans it, runs the existing verbatim placeholder substitution on the decoded `user:pass`, and re-base64-encodes — so a placeholder buried in a base64 blob is substituted correctly. Bodies keep the existing per-chunk verbatim substitution. **D** adds a name-only `capabilities.packages` grammar to `@ax/skills-parser`, auto-unions the public registry host(s) into the session allowlist in `chat-orchestrator`, and adds `uv`/`uvx` + `python3` to the agent image. No new credential kind, no new sandbox-visible material, no new service hook.

**Tech Stack:** TypeScript, vitest, Node `tls`/`net`/`http`, `@ax/credential-proxy`, `@ax/skills-parser`, `@ax/skills`, `@ax/chat-orchestrator`, Docker (`node:20-bookworm-slim` + `ghcr.io/astral-sh/uv`).

**Scope:** One PR covering both B and D (the design bundles them; they are independent so tasks can be reviewed per-sub-project). Each sub-project closes its own half-wired window within this PR.

**Design doc:** `docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md` (invariants I1–I7 referenced below).

**Note on code style:** examples below use `str.match(RE)` rather than `RE.exec(str)` (equivalent for non-global regexes) — a repo PreToolUse hook flags the literal `exec(` token. Keep this convention in the implementation.

**Decisions already logged** (`.claude/memory/decisions.md`, 2026-05-22):
- `GIT_TERMINAL_PROMPT=0` is **already** stamped in both sandbox providers → Task B4 is a regression assertion, not a re-stamp.
- B uses a **per-request re-arming** framing state machine (git reuses one CONNECT tunnel for GET `/info/refs` then POST `/git-upload-pack`, both carrying `Authorization`).
- B canary-scans the **decoded** Basic value (inline `chunk.includes` would be blinded by base64).
- D targets **`@ax/skills-parser`** (`@ax/skills/src/manifest.ts` is a re-export shim).
- New `ManifestCode`s: `invalid-package`, `unsupported-package-ecosystem`.
- uv pinned by version tag (digest-pin deferred); `python3` from Debian.

**Security:** I7 is mandatory. Run the `security-checklist` skill before opening the PR (MITM boundary for B; sandbox egress + new image deps + untrusted manifest content for D) and save the note to `docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-security-note.md`. This is **Task S**, run after B and D are implemented and before the pre-PR gate.

---

## File Structure

**Sub-project B (`@ax/credential-proxy`):**
- Create: `packages/credential-proxy/src/request-framer.ts` — pure, socket-free module: `findCanaryHit`, `transformBasicAuthHead`, `RequestFramer` (the framing state machine). All the tricky logic, fully unit-testable in isolation.
- Modify: `packages/credential-proxy/src/listener.ts` — wire `RequestFramer` into the MITM `clientTls 'data'` handler (replace the per-chunk verbatim write; refactor the inline raw canary scan to `findCanaryHit`; route the decoded-canary hit through the existing 403/destroy path).
- Create: `packages/credential-proxy/src/__tests__/request-framer.test.ts` — unit tests for the new module.
- Modify: `packages/credential-proxy/src/__tests__/listener-connect-mitm.test.ts` — add the git-clone-shaped end-to-end + canary-in-Basic-blob cases (reuses the existing real-TLS-upstream harness).
- Create: `packages/sandbox-k8s/src/__tests__/git-terminal-prompt.test.ts` and `packages/sandbox-subprocess/src/__tests__/git-terminal-prompt.test.ts` (or fold into an existing env test) — assert `GIT_TERMINAL_PROMPT=0` is present.

**Sub-project D:**
- Modify: `packages/skills-parser/src/capabilities.ts` — `PackagesSpec` type + add `packages` to `SkillCapabilities`.
- Modify: `packages/skills-parser/src/manifest.ts` — `packages` parse/validation, new `ManifestCode`s, caps, `EMPTY_CAPABILITIES` if it lives here.
- Modify: `packages/skills/src/_row-mappers.ts` — `EMPTY_CAPABILITIES` gains `packages` (if defined here).
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — auto-union registry hosts by declared ecosystem.
- Modify: `container/agent/Dockerfile` — `COPY --from=ghcr.io/astral-sh/uv:<tag>` + `python3` apt.
- Tests: `packages/skills-parser/src/__tests__/manifest-packages.test.ts` (new), `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (extend), `packages/skills/src/__tests__/store.test.ts` (extend if EMPTY_CAPABILITIES shape is asserted there).

---

## Sub-project B — git / Basic-auth

### Task B1: Pure helpers — `findCanaryHit` + `transformBasicAuthHead`

**Files:**
- Create: `packages/credential-proxy/src/request-framer.ts`
- Test: `packages/credential-proxy/src/__tests__/request-framer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/credential-proxy/src/__tests__/request-framer.test.ts
import { describe, it, expect } from 'vitest';
import { findCanaryHit, transformBasicAuthHead, type Replacer } from '../request-framer.js';

// A Replacer that maps a placeholder to a real secret, mirroring SharedCredentialRegistry.
function makeReplacer(map: Record<string, string>): Replacer {
  const replaceAll = (s: string) => {
    let out = s;
    for (const [ph, real] of Object.entries(map)) out = out.split(ph).join(real);
    return out;
  };
  return { replaceAll, replaceAllBuffer: (b) => Buffer.from(replaceAll(b.toString('latin1')), 'latin1') };
}

const PH = 'ax-cred:' + 'a'.repeat(32);
const REAL = 'glpat-REALSECRETVALUE';

function head(...lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
}

describe('findCanaryHit', () => {
  it('returns the matching token', () => {
    expect(findCanaryHit('hello CANARY-123 world', ['CANARY-123'])).toBe('CANARY-123');
  });
  it('returns null when no token matches or token list empty', () => {
    expect(findCanaryHit('nothing here', ['CANARY-123'])).toBeNull();
    expect(findCanaryHit('anything', [])).toBeNull();
  });
  it('scans buffers too', () => {
    expect(findCanaryHit(Buffer.from('x CANARY y'), ['CANARY'])).toBe('CANARY');
  });
});

describe('transformBasicAuthHead', () => {
  it('substitutes a placeholder in the password position', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET /info/refs HTTP/1.1', 'Host: gitlab.com', `Authorization: Basic ${b64}`);
    const { head: out, canaryToken } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    expect(canaryToken).toBeNull();
    const m = out.toString('latin1').match(/Authorization: Basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`oauth2:${REAL}`);
  });
  it('substitutes a placeholder in the username position', () => {
    const b64 = Buffer.from(`${PH}:`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    const m = out.toString('latin1').match(/Authorization: Basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`${REAL}:`);
  });
  it('handles Proxy-Authorization and is case-insensitive on scheme', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `proxy-authorization: basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    const wire = out.toString('latin1');
    expect(wire).toMatch(/proxy-authorization: basic /);
    const m = wire.match(/basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`oauth2:${REAL}`);
  });
  it('transforms multiple auth headers in one head', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`, `Proxy-Authorization: Basic ${b64}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []).head.toString('latin1');
    const realB64 = Buffer.from(`oauth2:${REAL}`).toString('base64');
    expect((out.match(new RegExp(realB64, 'g')) ?? []).length).toBe(2);
  });
  it('leaves Bearer untouched (verbatim path handles Bearer; this fn must not corrupt it)', () => {
    const h = head('GET / HTTP/1.1', `Authorization: Bearer ${PH}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []).head.toString('latin1');
    expect(out).toContain(`Bearer ${PH}`);
  });
  it('returns the original head unchanged when no placeholder present', () => {
    const b64 = Buffer.from('oauth2:not-a-placeholder').toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    expect(out.equals(h)).toBe(true);
  });
  it('flags a canary token hidden inside a Basic blob', () => {
    const b64 = Buffer.from('oauth2:CANARY-XYZ').toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { canaryToken } = transformBasicAuthHead(h, makeReplacer({}), ['CANARY-XYZ']);
    expect(canaryToken).toBe('CANARY-XYZ');
  });
  it('cannot inject CRLF: a replaced value that contains CRLF is re-base64-encoded (no raw CR/LF on the wire)', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: 'a\r\nInjected: 1' }), []).head.toString('latin1');
    const authLine = out.split('\r\n').find((l) => /^Authorization:/i.test(l))!;
    expect(authLine).not.toContain('Injected');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @ax/credential-proxy test request-framer`
Expected: FAIL — `Cannot find module '../request-framer.js'`.

- [ ] **Step 3: Implement the helpers**

```ts
// packages/credential-proxy/src/request-framer.ts

/** Minimal substitution surface, satisfied by SharedCredentialRegistry. */
export interface Replacer {
  replaceAll(input: string): string;
  replaceAllBuffer(input: Buffer): Buffer;
}

/** First canary token present in `data`, or null. Mirrors the listener's existing `includes` scan. */
export function findCanaryHit(data: string | Buffer, tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  const hay = typeof data === 'string' ? data : data.toString('latin1');
  for (const token of tokens) {
    if (token && hay.includes(token)) return token;
  }
  return null;
}

export interface HeadTransform {
  head: Buffer;
  canaryToken: string | null;
}

// Matches `Authorization: Basic <b64>` / `Proxy-Authorization: Basic <b64>` (scheme case-insensitive).
const BASIC_AUTH_LINE_RE = /^((?:proxy-)?authorization):[ \t]*(basic)[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i;

/**
 * Decode → canary-scan → substitute → re-encode each Basic auth header in an HTTP
 * request head. All other bytes (including Bearer/Digest auth) are preserved 1:1
 * (latin1 round-trip). Re-encoding to base64 cannot emit CR/LF, so a malicious
 * decoded value cannot inject headers. If a canary token appears in any decoded
 * value, returns `{ canaryToken }` and leaves the head unmodified (caller blocks).
 */
export function transformBasicAuthHead(
  head: Buffer,
  replacer: Replacer,
  canaryTokens: readonly string[],
): HeadTransform {
  const lines = head.toString('latin1').split('\r\n');
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(BASIC_AUTH_LINE_RE);
    if (!m) continue;
    const [, name, scheme, b64] = m;
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const hit = findCanaryHit(decoded, canaryTokens);
    if (hit) return { head, canaryToken: hit };
    const replaced = replacer.replaceAll(decoded);
    if (replaced !== decoded) {
      lines[i] = `${name}: ${scheme} ${Buffer.from(replaced, 'utf8').toString('base64')}`;
      mutated = true;
    }
  }
  if (!mutated) return { head, canaryToken: null };
  return { head: Buffer.from(lines.join('\r\n'), 'latin1'), canaryToken: null };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/credential-proxy test request-framer`
Expected: PASS (all `findCanaryHit` + `transformBasicAuthHead` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/request-framer.ts packages/credential-proxy/src/__tests__/request-framer.test.ts
git commit -m "feat(credential-proxy): Basic-auth head transform + canary helpers (B)"
```

---

### Task B2: `RequestFramer` — per-request HTTP/1.1 framing state machine

**Files:**
- Modify: `packages/credential-proxy/src/request-framer.ts`
- Test: `packages/credential-proxy/src/__tests__/request-framer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// append to request-framer.test.ts
import { RequestFramer } from '../request-framer.js';

const PH2 = 'ax-cred:' + 'b'.repeat(32);
const REAL2 = 'glpat-SECOND';

function basicHead(method: string, path: string, ...extra: string[]): string {
  const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
  return [`${method} ${path} HTTP/1.1`, 'Host: gitlab.com', `Authorization: Basic ${b64}`, ...extra, '', ''].join('\r\n');
}

function decodeAuth(wire: string): string {
  const m = wire.match(/Authorization: Basic (\S+)/)!;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

describe('RequestFramer', () => {
  const replacer = makeReplacer({ [PH]: REAL, [PH2]: REAL2 });

  it('transforms a single bodyless GET head', () => {
    const f = new RequestFramer(replacer, []);
    const { out } = f.process(Buffer.from(basicHead('GET', '/info/refs?service=git-upload-pack'), 'latin1'));
    expect(decodeAuth(out.toString('latin1'))).toBe(`oauth2:${REAL}`);
  });

  it('transforms BOTH heads on a keep-alive connection (GET then POST)', () => {
    const f = new RequestFramer(replacer, []);
    const get = basicHead('GET', '/info/refs?service=git-upload-pack'); // no body -> re-arm
    const body = '0011want abcd\n0000';
    const post = basicHead('POST', '/git-upload-pack', `Content-Length: ${Buffer.byteLength(body)}`) + body;
    const { out } = f.process(Buffer.from(get + post, 'latin1'));
    const wire = out.toString('latin1');
    const auths = [...wire.matchAll(/Authorization: Basic (\S+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
    expect(auths).toEqual([`oauth2:${REAL}`, `oauth2:${REAL}`]); // both transformed
    expect(wire).toContain(body); // body forwarded verbatim
  });

  it('substitutes a placeholder split across two chunks (latent-bug regression)', () => {
    const f = new RequestFramer(replacer, []);
    const full = basicHead('GET', '/');
    const split = Math.floor(full.length / 2);
    const r1 = f.process(Buffer.from(full.slice(0, split), 'latin1'));
    expect(r1.out.length).toBe(0); // held until end-of-head
    const r2 = f.process(Buffer.from(full.slice(split), 'latin1'));
    expect(decodeAuth(r2.out.toString('latin1'))).toBe(`oauth2:${REAL}`);
  });

  it('streams a chunked body verbatim and does not re-arm', () => {
    const f = new RequestFramer(replacer, []);
    const post = basicHead('POST', '/git-upload-pack', 'Transfer-Encoding: chunked');
    const chunkedBody = `5\r\nhello\r\n0\r\n\r\n`;
    const { out } = f.process(Buffer.from(post + chunkedBody, 'latin1'));
    const wire = out.toString('latin1');
    expect(decodeAuth(wire)).toBe(`oauth2:${REAL}`); // head transformed
    expect(wire).toContain(chunkedBody); // body verbatim
  });

  it('passes an oversized head through verbatim and fires onOversizedHead', () => {
    let oversized = false;
    const f = new RequestFramer(replacer, [], { maxHeadBytes: 64, onOversizedHead: () => { oversized = true; } });
    const big = 'GET / HTTP/1.1\r\nX-Pad: ' + 'z'.repeat(200); // no end-of-head within 64 bytes
    const { out } = f.process(Buffer.from(big, 'latin1'));
    expect(oversized).toBe(true);
    expect(out.toString('latin1')).toContain('z'.repeat(50)); // flushed verbatim
  });

  it('runs verbatim substitution on body bytes (Bearer-in-body keeps working)', () => {
    const f = new RequestFramer(replacer, []);
    const body = `{"token":"${PH2}"}`;
    const post = `POST /api HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const { out } = f.process(Buffer.from(post, 'latin1'));
    expect(out.toString('latin1')).toContain(`"token":"${REAL2}"`);
  });

  it('flags a canary in a Basic blob and stops at the head', () => {
    const f = new RequestFramer(replacer, ['CANARY-9']);
    const b64 = Buffer.from('oauth2:CANARY-9').toString('base64');
    const h = `GET / HTTP/1.1\r\nAuthorization: Basic ${b64}\r\n\r\n`;
    const { canaryToken } = f.process(Buffer.from(h, 'latin1'));
    expect(canaryToken).toBe('CANARY-9');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @ax/credential-proxy test request-framer`
Expected: FAIL — `RequestFramer is not a constructor`.

- [ ] **Step 3: Implement the state machine**

```ts
// append to packages/credential-proxy/src/request-framer.ts

const DEFAULT_MAX_HEAD = 64 * 1024;

export interface FramerOptions {
  /** Cap on a single buffered request head; exceeding it falls back to verbatim passthrough. */
  maxHeadBytes?: number;
  /** Called once when a head exceeds `maxHeadBytes` (for logging). */
  onOversizedHead?: () => void;
}

export interface FramerOutput {
  /** Bytes to forward upstream (may be empty while a head is still buffering). */
  out: Buffer;
  /** Non-null if a canary token appeared in a decoded Basic value — caller must block. */
  canaryToken: string | null;
}

type Phase = 'head' | 'body-counted' | 'passthrough';

function indexOfCrlfCrlf(buf: Buffer): number {
  return buf.indexOf('\r\n\r\n', 0, 'latin1');
}

interface BodyFraming {
  contentLength: number;
  chunked: boolean;
}

function parseBodyFraming(head: Buffer): BodyFraming {
  let contentLength = 0;
  let chunked = false;
  for (const line of head.toString('latin1').split('\r\n')) {
    const c = line.match(/^content-length:[ \t]*(\d+)[ \t]*$/i);
    if (c) contentLength = Number(c[1]);
    const te = line.match(/^transfer-encoding:[ \t]*(.+?)[ \t]*$/i);
    if (te && /\bchunked\b/i.test(te[1])) chunked = true;
  }
  return { contentLength, chunked };
}

/**
 * Frames the decrypted client→upstream byte stream of one MITM connection into
 * HTTP/1.1 requests so each request head can be Basic-auth-transformed.
 *
 * - HEAD phase: buffer until `\r\n\r\n`, transform Basic auth, then route by framing.
 * - Content-Length body: forward verbatim, count down, re-arm to HEAD (catches the
 *   next pipelined/keep-alive request — e.g. git's POST after the info/refs GET).
 * - Transfer-Encoding: chunked, or an oversized head: forward verbatim and stay in
 *   passthrough for the rest of the connection (git's chunked POST is terminal). I1:
 *   bodies are never rewritten beyond the existing verbatim placeholder substitution.
 */
export class RequestFramer {
  private phase: Phase = 'head';
  private headBuf: Buffer = Buffer.alloc(0);
  private bodyRemaining = 0;
  private readonly maxHead: number;

  constructor(
    private readonly replacer: Replacer,
    private readonly canaryTokens: readonly string[],
    private readonly opts: FramerOptions = {},
  ) {
    this.maxHead = opts.maxHeadBytes ?? DEFAULT_MAX_HEAD;
  }

  process(chunk: Buffer): FramerOutput {
    const parts: Buffer[] = [];
    let working = chunk;
    for (;;) {
      if (this.phase === 'passthrough') {
        if (working.length) parts.push(this.replacer.replaceAllBuffer(working));
        break;
      }
      if (this.phase === 'body-counted') {
        const take = Math.min(working.length, this.bodyRemaining);
        if (take > 0) parts.push(this.replacer.replaceAllBuffer(working.subarray(0, take)));
        this.bodyRemaining -= take;
        working = working.subarray(take);
        if (this.bodyRemaining > 0) break; // need more body bytes
        this.phase = 'head';
        if (working.length === 0) break;
        continue;
      }
      // phase === 'head'
      this.headBuf = this.headBuf.length ? Buffer.concat([this.headBuf, working]) : working;
      working = Buffer.alloc(0);
      const idx = indexOfCrlfCrlf(this.headBuf);
      if (idx < 0) {
        if (this.headBuf.length > this.maxHead) {
          parts.push(this.replacer.replaceAllBuffer(this.headBuf));
          this.headBuf = Buffer.alloc(0);
          this.phase = 'passthrough';
          this.opts.onOversizedHead?.();
        }
        break; // wait for more head bytes
      }
      const headEnd = idx + 4;
      const head = this.headBuf.subarray(0, headEnd);
      const rest = this.headBuf.subarray(headEnd);
      this.headBuf = Buffer.alloc(0);
      const t = transformBasicAuthHead(head, this.replacer, this.canaryTokens);
      if (t.canaryToken) return { out: Buffer.concat(parts), canaryToken: t.canaryToken };
      parts.push(t.head);
      const framing = parseBodyFraming(head);
      if (framing.chunked) {
        this.phase = 'passthrough';
        if (rest.length) parts.push(this.replacer.replaceAllBuffer(rest));
        break;
      }
      if (framing.contentLength > 0) {
        this.phase = 'body-counted';
        this.bodyRemaining = framing.contentLength;
        working = rest;
        continue;
      }
      // no body — re-arm for the next request head
      this.phase = 'head';
      if (rest.length === 0) break;
      working = rest;
    }
    return { out: Buffer.concat(parts), canaryToken: null };
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/credential-proxy test request-framer`
Expected: PASS (all `RequestFramer` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/request-framer.ts packages/credential-proxy/src/__tests__/request-framer.test.ts
git commit -m "feat(credential-proxy): RequestFramer keep-alive HTTP/1.1 framing for Basic-auth (B)"
```

---

### Task B3: Wire `RequestFramer` into the MITM listener

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts` (the `handleMITMConnect` `clientTls 'data'` handler — Explore located it ~lines 505–538, canary scan ~515–533, verbatim write ~535).
- Test: `packages/credential-proxy/src/__tests__/listener-connect-mitm.test.ts`

> **Read first:** open `listener.ts` and study the existing `clientTls.on('data', ...)` block: how `canaryTokens` is collected (`collectCanaryTokens(sessions)`), the exact 403/destroy/`event.http-egress` emission on a canary hit, and the `registry.replaceAllBuffer(chunk)` forward. The integration must preserve all of that behavior — only the *mechanism* changes.

- [ ] **Step 1: Write failing tests** (extend the existing MITM suite, which already stands up a real TLS upstream signed by the test CA and drives it via a proxy client)

```ts
// add to packages/credential-proxy/src/__tests__/listener-connect-mitm.test.ts
// Pattern: register a session with a credential placeholder + allowlist host, open the
// MITM tunnel, send a raw git-clone-shaped GET then POST through clientTls, and assert
// the stub upstream received the REAL credential (decoded from the Basic header) on BOTH.

it('git-clone-shaped GET+POST: upstream sees the real credential in the Basic header (B)', async () => {
  // ... reuse the suite's helpers to: resolve a placeholder for e.g. GITLAB_TOKEN -> 'glpat-REAL',
  //     register a session allowlisting the upstream host, capture every request the stub upstream sees.
  // Send over the established clientTls socket:
  //   GET /info/refs?service=git-upload-pack HTTP/1.1\r\nHost: <upstream>\r\nAuthorization: Basic base64("oauth2:<placeholder>")\r\n\r\n
  //   POST /git-upload-pack HTTP/1.1\r\nHost: <upstream>\r\nContent-Length: N\r\nAuthorization: Basic base64("oauth2:<placeholder>")\r\n\r\n<body>
  // Assert: both received Authorization headers decode to "oauth2:glpat-REAL".
});

it('blocks a canary token hidden inside a Basic blob (B canary parity)', async () => {
  // Register a session whose canaryToken = 'CANARY-XYZ'.
  // Send: Authorization: Basic base64("oauth2:CANARY-XYZ")
  // Assert: the connection is refused exactly like the existing raw-canary case
  //         (e.g. a 403 / destroyed socket, and an http-egress block event if the suite asserts that).
});
```

> The implementing engineer fills the `// ...` using the suite's existing helpers (do NOT invent a new harness). If the suite lacks a "capture requests at the upstream" helper, add a minimal request handler to the existing `tls.createServer` upstream that records `req.headers.authorization`.

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @ax/credential-proxy test listener-connect-mitm`
Expected: FAIL — POST's Authorization decodes to `oauth2:ax-cred:...` (placeholder, not substituted) before the wiring; canary-in-Basic not yet blocked.

- [ ] **Step 3: Integrate the framer**

Replace the body of the `clientTls.on('data', ...)` handler so it:
1. Constructs one `RequestFramer` per connection (outside the handler), e.g.:
   ```ts
   import { RequestFramer, findCanaryHit } from './request-framer.js';
   // ... after canaryTokens is known:
   const framer = new RequestFramer(registry, canaryTokens, {
     onOversizedHead: () => { /* use the existing logger; do NOT log header values */ },
   });
   ```
2. Inside the handler, keep the existing raw-chunk canary scan but route it through the shared helper (parity, DRY):
   ```ts
   const rawHit = findCanaryHit(chunk, canaryTokens);
   if (rawHit) { /* EXISTING 403 + destroy + event.http-egress block emission, unchanged */ return; }
   ```
3. Replace `targetTls.write(registry.replaceAllBuffer(chunk))` with:
   ```ts
   const { out, canaryToken } = framer.process(chunk);
   if (canaryToken) { /* SAME block path as rawHit above (extract a local closure to avoid duplication) */ return; }
   if (out.length) targetTls.write(out);
   ```

Notes:
- `SharedCredentialRegistry` already satisfies `Replacer` (`replaceAll` + `replaceAllBuffer`); pass it directly.
- The framer holds bytes until end-of-head, so `out` is legitimately empty for a partial head — only `write` when `out.length > 0`.
- Leave the separate pre-TLS `head`-param flush (Explore ~553–557) untouched; it is unrelated raw bytes.
- Do not log decoded values anywhere (I7 / §4.5 no-secret-logging).

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/credential-proxy test`
Expected: PASS — the whole credential-proxy suite green (new git-clone + canary cases pass; all prior MITM/bypass/http/shutdown/egress tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/listener.ts packages/credential-proxy/src/__tests__/listener-connect-mitm.test.ts
git commit -m "feat(credential-proxy): wire RequestFramer into MITM path for git Basic-auth (B)"
```

---

### Task B4: Regression assertion — `GIT_TERMINAL_PROMPT=0` present in both sandbox providers

**Files:**
- Test: `packages/sandbox-k8s/src/__tests__/git-terminal-prompt.test.ts` (new) and `packages/sandbox-subprocess/src/__tests__/git-terminal-prompt.test.ts` (new). If each package already has an env/pod-spec test that materializes the env, add an assertion there instead of a new file (engineer's choice — check first).

> Rationale (logged decision): the var is already stamped (`pod-spec.ts` `gitParanoidEnv` ~180–201; `open-session.ts` ~495–504). This task only **locks it in** so an accidental removal fails CI; it adds no production code.

- [ ] **Step 1: Write the assertion test(s)**

For sandbox-k8s — assert the rendered pod spec's env contains `GIT_TERMINAL_PROMPT=0`:
```ts
// packages/sandbox-k8s/src/__tests__/git-terminal-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildPodSpec /* or the actual exported builder */ } from '../pod-spec.js';

describe('sandbox-k8s git env', () => {
  it('stamps GIT_TERMINAL_PROMPT=0 so a missing credential fails fast (B)', () => {
    const spec = buildPodSpec(/* minimal valid args — copy from an existing pod-spec test */);
    const env = spec.spec!.containers[0].env!;
    const entry = env.find((e) => e.name === 'GIT_TERMINAL_PROMPT');
    expect(entry?.value).toBe('0');
  });
});
```

For sandbox-subprocess — assert the env object the open-session builder produces contains it:
```ts
// packages/sandbox-subprocess/src/__tests__/git-terminal-prompt.test.ts
// Find the function/exported constant that builds the child env (Explore: open-session.ts ~495–504).
// If it is not directly exported, assert against whatever IS exported/observable (e.g. the spawned
// child's env via the existing open-session test harness). Prefer extending an existing test.
expect(env.GIT_TERMINAL_PROMPT).toBe('0');
```

> **Read first:** open both files and an existing test in each package to learn the exact exported builder name + minimal args. Do not export new internals just for the test if an existing test already exercises the env path — extend that test.

- [ ] **Step 2: Run, verify pass** (these should pass immediately — the var is already set)

Run: `pnpm --filter @ax/sandbox-k8s test git-terminal-prompt && pnpm --filter @ax/sandbox-subprocess test git-terminal-prompt`
Expected: PASS. (If FAIL, the var is missing — that is the bug this guards; re-add it.)

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox-k8s/src/__tests__/git-terminal-prompt.test.ts packages/sandbox-subprocess/src/__tests__/git-terminal-prompt.test.ts
git commit -m "test(sandbox): lock in GIT_TERMINAL_PROMPT=0 for fail-fast git auth (B)"
```

---

## Sub-project D — CLI tool provisioning

### Task D1: `capabilities.packages` grammar + validation in `@ax/skills-parser`

**Files:**
- Modify: `packages/skills-parser/src/capabilities.ts` (types)
- Modify: `packages/skills-parser/src/manifest.ts` (parse + validation + error codes; `EMPTY_CAPABILITIES` if defined here)
- Test: `packages/skills-parser/src/__tests__/manifest-packages.test.ts` (new)

> **Read first:** `manifest.ts` — the existing `capabilities.mcpServers` parse block, the `ManifestCode` union (~lines 4–17), `MCP_SERVERS_MAX`/`MCP_ARGS_MAX` caps, `findSecretKey`, and how a capability sub-block reports `{ ok:false, code, message }`. Mirror that exact style (hand-rolled, no zod).

- [ ] **Step 1: Write failing tests**

```ts
// packages/skills-parser/src/__tests__/manifest-packages.test.ts
import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

function manifest(capabilitiesYaml: string): string {
  return [
    'name: pkg-skill',
    'description: A skill that needs a CLI',
    'capabilities:',
    capabilitiesYaml,
  ].join('\n');
}

describe('capabilities.packages', () => {
  it('parses npm and pypi name-only lists', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["@linear/cli"]\n    pypi: ["some-tool"]'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.capabilities.packages.npm).toEqual(['@linear/cli']);
      expect(r.value.capabilities.packages.pypi).toEqual(['some-tool']);
    }
  });

  it('defaults packages to empty arrays when omitted', () => {
    const r = parseSkillManifest(manifest('  allowedHosts: [api.linear.app]'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.capabilities.packages).toEqual({ npm: [], pypi: [] });
  });

  it('rejects packages.go with unsupported-package-ecosystem', () => {
    const r = parseSkillManifest(manifest('  packages:\n    go: ["github.com/x/y"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported-package-ecosystem');
  });

  it('rejects an unknown ecosystem key', () => {
    const r = parseSkillManifest(manifest('  packages:\n    cargo: ["serde"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported-package-ecosystem');
  });

  it('rejects a malformed npm name with invalid-package', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["bad name; rm -rf /"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('rejects a non-array ecosystem value', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: "@linear/cli"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('rejects more than the per-ecosystem cap', () => {
    const many = Array.from({ length: 33 }, (_, i) => `pkg-${i}`);
    const r = parseSkillManifest(manifest(`  packages:\n    npm: ${JSON.stringify(many)}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('accepts a valid scoped npm name and a dotted pypi name', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["@scope/tool-1"]\n    pypi: ["ruamel.yaml"]'));
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @ax/skills-parser test manifest-packages`
Expected: FAIL — `packages` undefined / codes not produced.

- [ ] **Step 3: Implement**

In `capabilities.ts`:
```ts
export interface PackagesSpec {
  npm: string[];
  pypi: string[];
}

export interface SkillCapabilities {
  allowedHosts: string[];
  credentials: CapabilitySlot[];
  mcpServers: McpServerSpec[];
  packages: PackagesSpec; // always present; empty arrays when none declared
}
```

In `manifest.ts` (mirror the mcpServers block):
```ts
// extend the ManifestCode union:
//   | 'invalid-package' | 'unsupported-package-ecosystem'

const PACKAGES_PER_ECOSYSTEM_MAX = 32;
const PACKAGE_NAME_LEN_MAX = 214; // npm's hard limit; generous for pypi
const SUPPORTED_ECOSYSTEMS = ['npm', 'pypi'] as const;
// npm: optional @scope/, then lowercase name; pypi: PEP 503-ish name. Both block whitespace
// and shell metacharacters by construction (defense in depth on top of I4's no-shell rule).
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePackagesCapability(
  raw: unknown,
): { ok: true; value: PackagesSpec } | { ok: false; code: ManifestCode; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: { npm: [], pypi: [] } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-package', message: 'capabilities.packages must be a mapping of ecosystem to name list' };
  }
  const out: PackagesSpec = { npm: [], pypi: [] };
  for (const [eco, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SUPPORTED_ECOSYSTEMS as readonly string[]).includes(eco)) {
      return { ok: false, code: 'unsupported-package-ecosystem', message: `package ecosystem '${eco}' is not supported yet (supported: ${SUPPORTED_ECOSYSTEMS.join(', ')})` };
    }
    if (!Array.isArray(names)) {
      return { ok: false, code: 'invalid-package', message: `capabilities.packages.${eco} must be an array of package names` };
    }
    if (names.length > PACKAGES_PER_ECOSYSTEM_MAX) {
      return { ok: false, code: 'invalid-package', message: `capabilities.packages.${eco} exceeds ${PACKAGES_PER_ECOSYSTEM_MAX} entries` };
    }
    const re = eco === 'npm' ? NPM_NAME_RE : PYPI_NAME_RE;
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0 || name.length > PACKAGE_NAME_LEN_MAX || !re.test(name)) {
        return { ok: false, code: 'invalid-package', message: `invalid ${eco} package name: ${JSON.stringify(name)}` };
      }
    }
    out[eco as 'npm' | 'pypi'] = names as string[];
  }
  return { ok: true, value: out };
}
```

Wire `parsePackagesCapability(rawCapabilities.packages)` into the capabilities assembly, returning its error if `!ok`, and set `capabilities.packages = result.value`. Update `EMPTY_CAPABILITIES` (wherever it is defined) to include `packages: { npm: [], pypi: [] }`.

> Keep `findSecretKey` covering `packages` automatically — it already walks all nodes; no change needed (names are not secret keys).

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/skills-parser test`
Expected: PASS (new packages tests + all existing manifest/mcp tests).

- [ ] **Step 5: Commit**

```bash
git add packages/skills-parser/src/capabilities.ts packages/skills-parser/src/manifest.ts packages/skills-parser/src/__tests__/manifest-packages.test.ts
git commit -m "feat(skills-parser): capabilities.packages name-only grammar (npm/pypi) (D)"
```

---

### Task D2: Carry `packages` through `skills:resolve`

**Files:**
- Modify: `packages/skills/src/_row-mappers.ts` — `EMPTY_CAPABILITIES` (Explore: this constant exists here, returned by `parseCapabilities` on parse failure) gains `packages: { npm: [], pypi: [] }`.
- Test: `packages/skills/src/__tests__/store.test.ts` (extend) or `_row-mappers` test if one exists.

> `ResolvedSkill.capabilities` is typed as `SkillCapabilities`, so `packages` flows through automatically once D1 lands and `EMPTY_CAPABILITIES` is updated. This task exists to (a) fix the now-incomplete `EMPTY_CAPABILITIES` literal (a TS error after D1) and (b) prove resolve round-trips `packages`.

- [ ] **Step 1: Write failing test**

```ts
// in packages/skills/src/__tests__/store.test.ts (or nearest resolve test)
it('skills:resolve carries capabilities.packages through from the stored manifest (D)', async () => {
  // Install/store a skill whose manifest declares packages.npm: ["@linear/cli"].
  // Resolve it and assert resolved.capabilities.packages.npm === ['@linear/cli'].
  // (Reuse the suite's existing store/install + resolve helpers.)
});
```

- [ ] **Step 2: Run, verify fail (or TS error)**

Run: `pnpm --filter @ax/skills build && pnpm --filter @ax/skills test`
Expected: FAIL — `EMPTY_CAPABILITIES` missing `packages` (TS2741) and/or the resolve assertion fails.

- [ ] **Step 3: Implement**

Add `packages: { npm: [], pypi: [] }` to the `EMPTY_CAPABILITIES` object literal in `_row-mappers.ts`. No other change — `parseCapabilities` already re-parses the full manifest via `parseSkillManifest`, so a stored manifest's `packages` is included.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/skills build && pnpm --filter @ax/skills test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/_row-mappers.ts packages/skills/src/__tests__/store.test.ts
git commit -m "feat(skills): carry capabilities.packages through skills:resolve (D)"
```

---

### Task D3: Orchestrator auto-allowlist of registry hosts by declared ecosystem

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (the `unionedAllowlist` build, Explore: ~960–1005, where each attached skill's `capabilities.allowedHosts` is added to `baseAllowSet`).
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (extend; uses `buildSkillsHooks()` returning inline `ResolvedSkill` fixtures and `buildProxyHooks()` capturing `lastOpenInput`).

> **Read first:** the exact loop that unions `allowedHosts`, the variable holding resolved skills (Explore: it iterates attachments and reads `skill.capabilities.allowedHosts`), and how `buildSkillsHooks()` fixtures set `capabilities`.

- [ ] **Step 1: Write failing tests**

```ts
// in orchestrator.test.ts, alongside the existing allowlist-union test (~line 1671)
it('auto-unions registry.npmjs.org when a skill declares packages.npm (D)', async () => {
  // Arrange a resolved-skill fixture with capabilities.packages.npm = ['@linear/cli'] (allowedHosts may be []).
  // Run a turn; capture proxy open-session input.
  expect(lastOpenInput.allowlist).toContain('registry.npmjs.org');
});

it('auto-unions pypi.org + files.pythonhosted.org for packages.pypi (D)', async () => {
  // fixture: capabilities.packages.pypi = ['some-tool']
  expect(lastOpenInput.allowlist).toEqual(expect.arrayContaining(['pypi.org', 'files.pythonhosted.org']));
});

it('unions no registry hosts when no packages are declared (D)', async () => {
  // fixture: capabilities.packages = { npm: [], pypi: [] }
  expect(lastOpenInput.allowlist).not.toContain('registry.npmjs.org');
  expect(lastOpenInput.allowlist).not.toContain('pypi.org');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @ax/chat-orchestrator test orchestrator`
Expected: FAIL — registry hosts not in `allowlist`.

- [ ] **Step 3: Implement**

Right after the existing `allowedHosts` union loop (and before `unionedAllowlist = [...baseAllowSet]`), add:
```ts
// D: auto-allowlist public package registries for any declared ecosystem (I5 — no blanket access).
let needsNpmRegistry = false;
let needsPypiRegistry = false;
for (const skill of /* same iterable used by the allowedHosts loop */) {
  const pkgs = skill.capabilities.packages;
  if (pkgs?.npm?.length) needsNpmRegistry = true;
  if (pkgs?.pypi?.length) needsPypiRegistry = true;
}
if (needsNpmRegistry) baseAllowSet.add('registry.npmjs.org');
if (needsPypiRegistry) {
  baseAllowSet.add('pypi.org');
  baseAllowSet.add('files.pythonhosted.org');
}
```
Use the same loop variable/iterable the `allowedHosts` union uses (fold it into that loop if cleaner — one pass). Keep `pkgs?.` optional-chaining so an older fixture without `packages` doesn't throw.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ax/chat-orchestrator test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(chat-orchestrator): auto-allowlist npm/pypi registries by declared packages (D)"
```

---

### Task D4: Agent image — `uv`/`uvx` + `python3`

**Files:**
- Modify: `container/agent/Dockerfile` (Explore: `node:20-bookworm-slim`; runtime apt at ~lines 101–103 installs `ca-certificates tini git git-lfs`; non-root `axagent` UID/GID 1000 created ~123–127).

> **Verification is a real docker build + smoke run** — not a unit test (no docker in `pnpm test`). The committed regression guard is the Dockerfile diff + the captured smoke output; the kind-cluster end-to-end is a MANUAL-ACCEPTANCE item (TODO).

- [ ] **Step 1: Edit the Dockerfile**

Add `python3` to the existing runtime apt install (keep `--no-install-recommends`):
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini git git-lfs python3 \
    && rm -rf /var/lib/apt/lists/*
```
Add the uv binaries from the official pinned image **before** the non-root user switch so perms are correct (a static binary in `/usr/local/bin`, world-executable):
```dockerfile
# uv/uvx: ephemeral on-demand runner for skill-declared python CLIs (capabilities.packages.pypi).
# Pinned by version tag (digest-pin is a tracked follow-up, alongside tini/ca-certificates).
COPY --from=ghcr.io/astral-sh/uv:<PINNED_TAG> /uv /uvx /usr/local/bin/
```
> Pick `<PINNED_TAG>` = the latest stable uv release tag (e.g. `0.5.x`). Verify the tag exists by building (Step 2). Do NOT use `latest`.

- [ ] **Step 2: Build + smoke-test the image** (real verification)

```bash
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
docker run --rm --user 1000:1000 ax-next/agent:dev sh -c 'uv --version && uvx --version && python3 --version && which npx'
```
Expected: prints uv version, uvx version, a Python 3.x version, and an `npx` path — all as UID 1000 (axagent), exit 0. Capture this output for the PR body / verification evidence.

- [ ] **Step 3: Commit**

```bash
git add container/agent/Dockerfile
git commit -m "feat(agent-image): add uv/uvx + python3 for skill-declared CLI packages (D)"
```

---

## Task S: Security-checklist note (I7 — required)

**Files:**
- Create: `docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-security-note.md`

- [ ] Invoke the `security-checklist` skill and walk all three threat models for the combined change:
  - **Sandbox escape / MITM boundary (B):** head buffering is bounded (64 KiB) → no unbounded memory; re-encode to base64 cannot emit CR/LF → no header injection; decoded value is never logged; canary scans the decoded value (parity); no new sandbox-visible material (I2); bodies still only get verbatim substitution (I1, no general rewriting).
  - **Prompt injection (B+D):** a prompt-injected agent replaying a placeholder to another allowlisted host is unchanged from today (bounded by session allowlist + canary). For D, the agent can already run arbitrary Bash; auto-allowlisting a whole public registry widens reachable hosts — bounded by the admin-installed-skill trust boundary, the session allowlist, and the canary scanner. Document, don't hide.
  - **Supply chain (D):** `uv`/`uvx` pinned by version (digest-pin = follow-up); `python3` from Debian; `packages` names are validated (shape + caps) and never interpolated into a shell (I4 — canonical `npx <name>`/`uvx <name>` only).
- [ ] Save the structured note. Reference invariants I1–I7 explicitly. Commit:

```bash
git add docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-security-note.md
git commit -m "docs(security): security-checklist note for credentialed CLI + git Basic-auth (I7)"
```

---

## Pre-PR gate (Phase 4)

- [ ] Allowlist the design + impl + security docs in `.gitignore` (the repo ignores `docs/plans/*`), so they ride into the PR (matches the web-tools / title-SSE precedent):
  ```
  !docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md
  !docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-impl.md
  !docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-security-note.md
  ```
  then `git add` the three docs + `.gitignore` and commit.
- [ ] **Whole-repo build:** `pnpm build` — tsc clean across all packages (not just the touched ones; catch project-reference + shared-type breaks). Add any missing tsc project `references` for new test imports if the build complains.
- [ ] **Whole-repo test:** `pnpm test` — green. (Watch for shared-table teardown surprises, though this change adds no DB schema.)
- [ ] **Lint:** `pnpm lint` — scope to changed files if `.worktrees/` noise appears (`pnpm lint` can exit 1 from stale worktree copies, not your branch).
- [ ] Write deferred items to `TODO.md`:
  - uv/uvx + ca-certificates/tini digest-pin (currently version-tag-pinned).
  - kind-cluster MANUAL-ACCEPTANCE walks: (1) real `git clone https://oauth2:$GITLAB_TOKEN@gitlab.com/...` through the proxy; (2) a skill declaring `packages.npm: ['@linear/cli']` running `npx @linear/cli` against a stubbed/real upstream.
  - Per-package registry allowlisting (vs whole-registry) — possible later tightening (§5.7).
  - Body-split placeholder substitution across TCP segments is still per-chunk (head-split is fixed by B; body-split remains a pre-existing limitation — out of scope).
  - Cross-session tool caching / pre-warming (§5.6, deferred).

---

## Self-review (against the design doc)

- **§4.2 mechanism (decode/sub/re-encode):** B1 `transformBasicAuthHead` ✅; head buffering + body framing: B2 `RequestFramer` ✅ (extends §4.2 to per-request re-arm — logged decision).
- **§4.3 credential/agent UX:** no new credential kind (uses existing `api-key`) ✅; `GIT_TERMINAL_PROMPT=0` already present, B4 locks it in ✅. (SKILL.md authoring guidance is documentation, not code — covered by the design doc + MANUAL-ACCEPTANCE example.)
- **§4.4 edge cases:** token-in-password/username (B1 tests) ✅; split-across-chunks (B2 test) ✅; oversized head (B2 test) ✅; non-Basic untouched (B1 test) ✅; multiple auth headers (B1 test) ✅.
- **§4.5 security:** no header-splitting (B1 test) ✅; no secret logging (B3 note) ✅; canary parity on decoded value (B1+B2+B3 tests) ✅; bounded memory (B2) ✅.
- **§4.7 tests:** all six B test cases mapped to B1/B2/B3 ✅.
- **§5.2 grammar:** name-only npm/pypi (D1) ✅.
- **§5.3 registry egress:** orchestrator auto-union (D3) ✅.
- **§5.5 image:** uv/uvx + python3 (D4) ✅.
- **§5.6 decisions:** per-session ephemeral (no caching infra — nothing built) ✅; go rejected with clear message (D1 test) ✅.
- **§5.9 tests:** manifest parse/reject (D1) ✅; orchestrator union (D3) ✅; image smoke (D4) ✅; e2e `npx <name>` through proxy → MANUAL-ACCEPTANCE (TODO, matches web-tools precedent) ✅.
- **§6 half-wired window:** B reachable from its own tests; D's grammar+union+image ship together ✅.
- **I1–I7:** I1 (header-only transform, no body rewrite) ✅; I2 (no new sandbox material) ✅; I3 (reuse replaceAll + env-placeholder path) ✅; I4 (name-only, no shell strings) ✅; I5 (specific registry hosts only) ✅; I6 (no leaky field names — `packages.npm`/`pypi` are ecosystem names) ✅; I7 (Task S) ✅.
