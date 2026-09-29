/**
 * Registry unit tests (TASK-687: placeholders are bound to hosts AND sessions).
 *
 * The contract under test: a placeholder is substituted ONLY for the session that
 * owns it and ONLY on egress to a host in its `allowedHosts`. There is no API
 * that substitutes without a host, and none that substitutes across sessions —
 * these tests assert the ABSENCE of both, not just the presence of the bound path.
 */

import { describe, it, expect } from 'vitest';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from '../registry.js';

const PROVIDER = 'api.provider.test';
const OTHER = 'attacker.test';

describe('CredentialPlaceholderMap', () => {
  it('register returns ax-cred: prefixed placeholder', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('ANTHROPIC_API_KEY', 'sk-real', [PROVIDER]);
    expect(ph).toMatch(/^ax-cred:[0-9a-f]{32}$/);
  });

  it('toEnvMap returns env-name → placeholder map (bound and unbound alike)', () => {
    const m = new CredentialPlaceholderMap();
    const bound = m.register('ANTHROPIC_API_KEY', 'sk-real', [PROVIDER]);
    const unbound = m.register('UNBOUND_KEY', 'sk-other', []);
    // The sandbox env still gets the placeholder for an unbound credential —
    // the process has something to read; the wire just never honours it.
    expect(m.toEnvMap()).toEqual({ ANTHROPIC_API_KEY: bound, UNBOUND_KEY: unbound });
  });

  describe('forHost — substitution is bound to the destination host', () => {
    it('substitutes a placeholder bound to the host', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'real-secret', [PROVIDER]);
      expect(m.forHost(PROVIDER).replaceAll(`auth: ${ph}`)).toBe('auth: real-secret');
    });

    it('leaves a placeholder bound to a DIFFERENT host untouched', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'real-secret', [PROVIDER]);
      const out = m.forHost(OTHER).replaceAll(`auth: ${ph}`);
      expect(out).toBe(`auth: ${ph}`);
      expect(out).not.toContain('real-secret');
    });

    it('substitutes every bound placeholder in one input, and only those', () => {
      const m = new CredentialPlaceholderMap();
      const bound = m.register('BOUND', 'real-bound', [PROVIDER]);
      const elsewhere = m.register('ELSEWHERE', 'real-elsewhere', [OTHER]);
      const out = m.forHost(PROVIDER).replaceAll(`${bound} ${elsewhere} ${bound}`);
      expect(out).toBe(`real-bound ${elsewhere} real-bound`);
    });

    it('a credential bound to several hosts is substituted on each, and on no other', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v', [PROVIDER, OTHER]);
      expect(m.forHost(PROVIDER).replaceAll(ph)).toBe('v');
      expect(m.forHost(OTHER).replaceAll(ph)).toBe('v');
      expect(m.forHost('third.test').replaceAll(ph)).toBe(ph);
    });

    it('matches the host case-insensitively, on both the binding and the lookup side', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v', ['API.Provider.Test']);
      expect(m.forHost('api.provider.test').replaceAll(ph)).toBe('v');
      expect(m.forHost('API.PROVIDER.TEST').replaceAll(ph)).toBe('v');
      // …and a different host is still refused: case-folding is not a wildcard.
      expect(m.forHost('api.provider.test.evil.test').replaceAll(ph)).toBe(ph);
    });

    it('folds case for ASCII ONLY: a Unicode look-alike (U+212A KELVIN SIGN) never equals the ASCII letter', () => {
      // 'K'.toLowerCase() === 'k' under Unicode case mapping, so a lookup host
      // spelled with a Kelvin sign would collide with a bound host that has a
      // plain 'k'. Hostnames are ASCII by the time they reach the proxy; a
      // non-ASCII spelling must never match, on either side.
      const kelvin = 'K';
      expect(kelvin.toLowerCase()).toBe('k'); // the premise of this test
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v', ['api.kagi.test']);
      expect(m.forHost('api.kagi.test').replaceAll(ph)).toBe('v');
      expect(m.forHost(`api.${kelvin}agi.test`).replaceAll(ph)).toBe(ph);
      const m2 = new CredentialPlaceholderMap();
      const ph2 = m2.register('K', 'v', [`api.${kelvin}agi.test`]);
      expect(m2.forHost('api.kagi.test').replaceAll(ph2)).toBe(ph2);
    });

    it('trims surrounding whitespace on the binding and the lookup', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v', ['  api.provider.test  ']);
      expect(m.forHost('api.provider.test').replaceAll(ph)).toBe('v');
      expect(m.forHost(' api.provider.test\t').replaceAll(ph)).toBe('v');
    });

    it('is an EXACT match: no wildcard, subdomain, suffix, prefix or port folding', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v', [PROVIDER]);
      for (const near of [
        `sub.${PROVIDER}`,
        `${PROVIDER}.evil.test`,
        `x${PROVIDER}`,
        'provider.test',
        `${PROVIDER}:443`,
        `${PROVIDER}.`,
      ]) {
        expect(m.forHost(near).replaceAll(ph), near).toBe(ph);
      }
      // A wildcard in the BINDING is not a pattern: it matches no real host.
      const w = new CredentialPlaceholderMap();
      const wph = w.register('K', 'v', ['*.provider.test']);
      expect(w.forHost(PROVIDER).replaceAll(wph)).toBe(wph);
      expect(w.forHost(`sub.${PROVIDER}`).replaceAll(wph)).toBe(wph);
    });

    it('an empty binding is inert: the placeholder is never substituted, on any host', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'real-secret', []);
      for (const host of [PROVIDER, OTHER, '127.0.0.1', '']) {
        expect(m.forHost(host).replaceAll(ph), host).toBe(ph);
      }
    });

    it('blank / whitespace-only binding entries bind nothing (no empty-host match)', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'real-secret', ['', '   ']);
      expect(m.forHost('').replaceAll(ph)).toBe(ph);
      expect(m.forHost('   ').replaceAll(ph)).toBe(ph);
      expect(m.forHost(PROVIDER).replaceAll(ph)).toBe(ph);
    });

    it('replaceAllBuffer substitutes a bound placeholder', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'real-secret', [PROVIDER]);
      const out = m.forHost(PROVIDER).replaceAllBuffer(Buffer.from(`Bearer ${ph}\r\n`));
      expect(out.toString('utf8')).toBe('Bearer real-secret\r\n');
    });

    it('replaceAllBuffer returns the SAME Buffer (identity) when nothing is substituted', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'secret', [PROVIDER]);

      // No placeholder in the input at all.
      const plain = Buffer.from('plain text');
      expect(m.forHost(PROVIDER).replaceAllBuffer(plain)).toBe(plain);

      // A registered placeholder, but bound to another host: the identity is the
      // framer's "nothing was injected" signal, so it must hold here too.
      const misaimed = Buffer.from(`Bearer ${ph}`);
      expect(m.forHost(OTHER).replaceAllBuffer(misaimed)).toBe(misaimed);
    });

    it('sees a value rotation and a re-registration made AFTER forHost was called', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v1', [PROVIDER]);
      const view = m.forHost(PROVIDER); // obtained once, kept (an open tunnel)
      expect(view.replaceAll(ph)).toBe('v1');
      m.updateValue('K', 'v2');
      expect(view.replaceAll(ph)).toBe('v2');
      const ph2 = m.register('K', 'v3', [PROVIDER]);
      expect(view.replaceAll(ph)).toBe(ph); // old placeholder retired
      expect(view.replaceAll(ph2)).toBe('v3');
    });
  });

  describe('updateValue (rotation)', () => {
    it('changes the value behind the SAME placeholder', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v1', [PROVIDER]);
      expect(m.updateValue('K', 'v2')).toBe(ph);
      expect(m.forHost(PROVIDER).replaceAll(ph)).toBe('v2');
      expect(m.toEnvMap()).toEqual({ K: ph }); // no fresh placeholder minted
    });

    it('keeps the host binding and does not widen it', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v1', [PROVIDER]);
      m.updateValue('K', 'v2');
      expect(m.forHost(PROVIDER).replaceAll(ph)).toBe('v2'); // binding survived
      expect(m.forHost(OTHER).replaceAll(ph)).toBe(ph); // …and did not grow
    });

    it('does not bind an unbound credential by rotating it', () => {
      const m = new CredentialPlaceholderMap();
      const ph = m.register('K', 'v1', []);
      m.updateValue('K', 'v2');
      for (const host of [PROVIDER, OTHER]) {
        expect(m.forHost(host).replaceAll(ph)).toBe(ph);
      }
    });

    it('returns undefined (and registers nothing) for an env name that was never registered', () => {
      const m = new CredentialPlaceholderMap();
      expect(m.updateValue('NOPE', 'v')).toBeUndefined();
      expect(m.toEnvMap()).toEqual({});
    });
  });

  describe('re-registering the same env name', () => {
    it('retires the old placeholder: it is no longer substituted anywhere', () => {
      const m = new CredentialPlaceholderMap();
      const ph1 = m.register('K', 'v1', [PROVIDER]);
      const ph2 = m.register('K', 'v2', [PROVIDER]);
      expect(ph1).not.toBe(ph2);
      const view = m.forHost(PROVIDER);
      expect(view.replaceAll(ph1)).toBe(ph1); // old retired
      expect(view.replaceAll(ph2)).toBe('v2');
      expect(m.hasPlaceholders(ph1)).toBe(false);
      expect(m.hasPlaceholders(ph2)).toBe(true);
    });

    it("retires the old placeholder's HOSTS too: the new binding is exactly the new list", () => {
      const m = new CredentialPlaceholderMap();
      const ph1 = m.register('K', 'v1', [PROVIDER]);
      const ph2 = m.register('K', 'v2', [OTHER]);
      // Old host no longer receives the new value (nor the old one).
      expect(m.forHost(PROVIDER).replaceAll(`${ph1} ${ph2}`)).toBe(`${ph1} ${ph2}`);
      // New host receives only the new value.
      expect(m.forHost(OTHER).replaceAll(`${ph1} ${ph2}`)).toBe(`${ph1} v2`);
    });

    it('re-registering with an EMPTY list un-binds the credential', () => {
      const m = new CredentialPlaceholderMap();
      m.register('K', 'v1', [PROVIDER]);
      const ph2 = m.register('K', 'v2', []);
      expect(m.forHost(PROVIDER).replaceAll(ph2)).toBe(ph2);
    });
  });

  it('does not alias the caller-supplied host array (later mutation cannot widen the binding)', () => {
    const hosts = [PROVIDER];
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'v', hosts);
    hosts.push(OTHER);
    expect(m.forHost(OTHER).replaceAll(ph)).toBe(ph);
  });

  it('exposes NO unscoped substitution surface (a host is always required)', () => {
    // The whole point of TASK-687: the "substitute anywhere" methods are gone, so
    // a future call site cannot reach for them by accident.
    const m = new CredentialPlaceholderMap() as unknown as Record<string, unknown>;
    expect(m.replaceAll).toBeUndefined();
    expect(m.replaceAllBuffer).toBeUndefined();
    const reg = new SharedCredentialRegistry() as unknown as Record<string, unknown>;
    expect(reg.replaceAll).toBeUndefined();
    expect(reg.replaceAllBuffer).toBeUndefined();
    expect(reg.hasPlaceholders).toBeUndefined();
  });
});

describe('SharedCredentialRegistry.replacerFor', () => {
  function mapWith(envName: string, real: string, hosts: string[]): {
    map: CredentialPlaceholderMap;
    ph: string;
  } {
    const map = new CredentialPlaceholderMap();
    return { map, ph: map.register(envName, real, hosts) };
  }

  it("substitutes the OWN session's placeholder on a bound host", () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    reg.register('sa', a.map);
    expect(reg.replacerFor('sa', PROVIDER).replaceAll(`x ${a.ph} y`)).toBe('x v-a y');
  });

  it("does NOT substitute the own session's placeholder on an unbound host", () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    reg.register('sa', a.map);
    expect(reg.replacerFor('sa', OTHER).replaceAll(a.ph)).toBe(a.ph);
  });

  it("does NOT substitute another session's placeholder, even for the very host it is bound to", () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    const b = mapWith('K', 'v-b', [PROVIDER]);
    reg.register('sa', a.map);
    reg.register('sb', b.map);

    const asB = reg.replacerFor('sb', PROVIDER);
    // B spends B's own…
    expect(asB.replaceAll(b.ph)).toBe('v-b');
    // …but A's placeholder (leaked into a shared transcript, say) is inert for B.
    expect(asB.replaceAll(a.ph)).toBe(a.ph);
    expect(asB.replaceAll(`${a.ph} ${b.ph}`)).toBe(`${a.ph} v-b`);
    // And the symmetric direction.
    const asA = reg.replacerFor('sa', PROVIDER);
    expect(asA.replaceAll(`${a.ph} ${b.ph}`)).toBe(`v-a ${b.ph}`);
  });

  it('an unknown session gets a no-op replacer that returns its input BY IDENTITY', () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    reg.register('sa', a.map);

    const view = reg.replacerFor('ghost', PROVIDER);
    const buf = Buffer.from(`Bearer ${a.ph}`);
    expect(view.replaceAllBuffer(buf)).toBe(buf);
    expect(view.replaceAll(a.ph)).toBe(a.ph);
  });

  it("a different host returns the input Buffer by identity even for the owner's own placeholder", () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    reg.register('sa', a.map);
    const buf = Buffer.from(`Bearer ${a.ph}`);
    expect(reg.replacerFor('sa', OTHER).replaceAllBuffer(buf)).toBe(buf);
  });

  it('deregister takes effect on a replacer obtained BEFORE it (live view: a closed session stops substituting)', () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    reg.register('sa', a.map);

    const view = reg.replacerFor('sa', PROVIDER); // an already-open tunnel holds this
    expect(view.replaceAll(a.ph)).toBe('v-a');

    reg.deregister('sa');
    expect(view.replaceAll(a.ph)).toBe(a.ph);
    const buf = Buffer.from(a.ph);
    expect(view.replaceAllBuffer(buf)).toBe(buf);
  });

  it('deregister only removes the named session, leaves others intact', () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v-a', [PROVIDER]);
    const b = mapWith('K', 'v-b', [PROVIDER]);
    reg.register('sa', a.map);
    reg.register('sb', b.map);
    const asA = reg.replacerFor('sa', PROVIDER);
    const asB = reg.replacerFor('sb', PROVIDER);

    reg.deregister('sa');
    expect(asA.replaceAll(a.ph)).toBe(a.ph);
    expect(asB.replaceAll(b.ph)).toBe('v-b'); // sb still works
  });

  it('re-registering a session swaps its map live: the old map stops substituting, the new one starts', () => {
    const reg = new SharedCredentialRegistry();
    const old = mapWith('K', 'v-old', [PROVIDER]);
    reg.register('sa', old.map);
    const view = reg.replacerFor('sa', PROVIDER);
    expect(view.replaceAll(old.ph)).toBe('v-old');

    const fresh = mapWith('K', 'v-new', [PROVIDER]);
    reg.register('sa', fresh.map);
    expect(view.replaceAll(old.ph)).toBe(old.ph);
    expect(view.replaceAll(fresh.ph)).toBe('v-new');
  });

  it('a session with a registered but empty map changes nothing', () => {
    const reg = new SharedCredentialRegistry();
    reg.register('sa', new CredentialPlaceholderMap());
    const buf = Buffer.from('hello');
    expect(reg.replacerFor('sa', PROVIDER).replaceAllBuffer(buf)).toBe(buf);
  });

  it('a rotation made through get() is seen by a replacer obtained earlier, with the binding intact', () => {
    const reg = new SharedCredentialRegistry();
    const a = mapWith('K', 'v1', [PROVIDER]);
    reg.register('sa', a.map);
    const onProvider = reg.replacerFor('sa', PROVIDER);
    const onOther = reg.replacerFor('sa', OTHER);

    reg.get('sa')!.updateValue('K', 'v2');
    expect(onProvider.replaceAll(a.ph)).toBe('v2');
    expect(onOther.replaceAll(a.ph)).toBe(a.ph);
  });
});
