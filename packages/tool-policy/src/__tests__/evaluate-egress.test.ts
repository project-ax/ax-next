/**
 * TASK-330 — the egress contingency in `evaluate`.
 *
 * The rule under test answers `hold` for a host nobody allowed and `allow` for
 * one somebody did, and the interesting half of this file is everything that
 * must NOT relax it. `web_extract` is an exfiltration channel: under prompt
 * injection the model chooses the URL, so every near-miss below is something an
 * attacker gets to try for free.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import type { PolicyRule } from '../types.js';

const EXTRACT: PolicyRule = {
  id: 'web.extract',
  match: { tool: 'web_extract' },
  verdict: 'hold',
  capability: 'read a web page, and remember the site it came from',
  subject: 'agent',
  provenance: 'rule',
  effect: ['spends', 'outward'],
  egress: { urlField: 'url' },
};

/** A rule for the same tool with no contingency — the control. */
const UNGATED: PolicyRule = {
  id: 'other.hold',
  match: { tool: 'other_tool' },
  verdict: 'hold',
  capability: 'do the other thing',
  subject: 'agent',
  provenance: 'rule',
};

const RULES: readonly PolicyRule[] = [EXTRACT, UNGATED];

function verdictFor(url: unknown, allowed: string[] = []): string {
  return evaluate(
    RULES,
    { name: 'web_extract', input: { url } },
    { allowedHosts: new Set(allowed) },
  ).verdict;
}

describe('evaluate — egress contingency', () => {
  it('allows silently when the target host is on the allowlist', () => {
    expect(verdictFor('https://docs.example.com/guide', ['docs.example.com'])).toBe('allow');
  });

  it('holds when the target host is NOT on the allowlist', () => {
    expect(verdictFor('https://attacker.test/x', ['docs.example.com'])).toBe('hold');
  });

  it('holds when nothing is allowed at all — the fresh-install default', () => {
    // The empty default is only safe because THIS is a hold and not a refusal.
    expect(verdictFor('https://docs.example.com/guide')).toBe('hold');
  });

  it('holds when the caller passed no allowlist — not knowing is not allowing', () => {
    // The plugin passes an EMPTY SET when the allowlist read fails, and omits
    // the option entirely for tools nothing gates. Both must land here.
    expect(
      evaluate(RULES, { name: 'web_extract', input: { url: 'https://docs.example.com/' } })
        .verdict,
    ).toBe('hold');
  });

  it('keeps the rule identity when it relaxes the verdict', () => {
    // A silent allow that reported `ruleId: null` would look to the rail like a
    // tool no rule describes, and the row would lose both its sentence and its
    // effect disclosure.
    const out = evaluate(
      RULES,
      { name: 'web_extract', input: { url: 'https://docs.example.com/' } },
      { allowedHosts: new Set(['docs.example.com']) },
    );
    expect(out).toEqual({
      verdict: 'allow',
      ruleId: 'web.extract',
      capability: EXTRACT.capability,
      irreversible: false,
    });
  });

  it('never relaxes a rule that did not opt in', () => {
    // The allowlist must not be able to turn some unrelated hold into an allow
    // just because a URL-ish field happens to be in the input.
    expect(
      evaluate(
        RULES,
        { name: 'other_tool', input: { url: 'https://docs.example.com/' } },
        { allowedHosts: new Set(['docs.example.com']) },
      ).verdict,
    ).toBe('hold');
  });

  describe('matches the HOST and nothing else', () => {
    const ALLOWED = ['good.example.com'];

    it('does not treat the allowed host as a PREFIX of another host', () => {
      // The registrable-suffix attack: anybody can register
      // `good.example.com.evil.test` and it starts with the allowed string.
      expect(verdictFor('https://good.example.com.evil.test/', ALLOWED)).toBe('hold');
    });

    it('does not match a host that merely ENDS with the allowed one', () => {
      // No implicit subdomains. Allowing `good.example.com` is not allowing
      // every name somebody can create underneath it.
      expect(verdictFor('https://evil.good.example.com/', ALLOWED)).toBe('hold');
    });

    it('is not fooled by the allowed host appearing in the QUERY STRING', () => {
      // This is the whole reason the match is on the host rather than on a URL
      // prefix: the query string is the exfiltration payload, so a matcher that
      // reads it is a matcher the payload can steer.
      expect(verdictFor('https://evil.test/?to=good.example.com', ALLOWED)).toBe('hold');
      expect(verdictFor('https://evil.test/good.example.com/steal', ALLOWED)).toBe('hold');
      expect(verdictFor('https://evil.test/#good.example.com', ALLOWED)).toBe('hold');
    });

    it('is not fooled by userinfo before the @', () => {
      // `https://good.example.com@evil.test/` reads as the allowed host to a
      // person and parses to `evil.test`. Naive string matching gets this
      // wrong; `URL.hostname` does not.
      expect(verdictFor('https://good.example.com@evil.test/', ALLOWED)).toBe('hold');
    });

    it('ignores the port and the scheme', () => {
      // Neither is part of the identity the allowlist stores, and the SSRF
      // guard above already refuses non-http(s) schemes.
      expect(verdictFor('https://good.example.com:8443/x', ALLOWED)).toBe('allow');
      expect(verdictFor('http://good.example.com/x', ALLOWED)).toBe('allow');
    });

    it('matches case-insensitively', () => {
      expect(verdictFor('https://GOOD.Example.COM/x', ALLOWED)).toBe('allow');
    });

    it('does not let a unicode homograph inherit the ASCII host', () => {
      // `gооd` here carries Cyrillic о. `URL` applies IDNA, so the hostname is
      // the punycode form and cannot collide with what somebody allowed.
      expect(verdictFor('https://gооd.example.com/', ALLOWED)).toBe('hold');
    });
  });

  describe('holds on anything it cannot read a host out of', () => {
    it('holds for a missing, empty or non-string url', () => {
      for (const bad of [undefined, '', 42, null, { toString: () => 'https://good.test/' }]) {
        expect(verdictFor(bad, ['good.test'])).toBe('hold');
      }
    });

    it('holds for an unparseable url', () => {
      expect(verdictFor('not a url', ['good.test'])).toBe('hold');
      expect(verdictFor('https://', ['good.test'])).toBe('hold');
    });

    it('holds when the input is not an object at all', () => {
      for (const input of [null, 'https://good.test/', 7, undefined]) {
        expect(evaluate(RULES, { name: 'web_extract', input }, {
          allowedHosts: new Set(['good.test']),
        }).verdict).toBe('hold');
      }
    });

    it('does not read the url field off the prototype chain', () => {
      // Same hazard `matches()` guards against: an inherited `url` would be a
      // host the caller never named being read as the one they did.
      const input = Object.create({ url: 'https://good.test/' }) as object;
      expect(
        evaluate(RULES, { name: 'web_extract', input }, {
          allowedHosts: new Set(['good.test']),
        }).verdict,
      ).toBe('hold');
    });

    it('never throws, whatever it is handed', () => {
      // `@ax/decisions` calls this from a `tool:pre-call` subscriber, where
      // `HookBus.fire` swallows a throw as a CLEAN PASS — so a throw here is a
      // silent allow, which is the worst outcome available.
      const nasty: unknown[] = [
        Symbol('x'),
        () => 'https://good.test/',
        new Proxy({}, { get: () => { throw new Error('boom'); } }),
      ];
      for (const url of nasty) {
        expect(() =>
          evaluate(RULES, { name: 'web_extract', input: { url } }, {
            allowedHosts: new Set(['good.test']),
          }),
        ).not.toThrow();
      }
    });
  });
});
