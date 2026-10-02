import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// The audit exception is safe only while the installed dependency rejects the
// CVE-2026-85393 vector. Test both consumers, including the preset's test tools,
// in the unconditional scripts suite so patch removal cannot silently pass CI.
for (const consumer of ['packages/credential-proxy', 'presets/k8s']) {
  describe(`${consumer}: node-forge PKCS#1 signature validation`, () => {
    const require = createRequire(new URL(`../../${consumer}/package.json`, import.meta.url));
    const forge = require('node-forge');
    let keys;
    let digest;

    beforeAll(() => {
      keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
      const md = forge.md.sha256.create();
      md.update('AX signature validation regression');
      digest = md.digest().getBytes();
    });

    function signature({ parameters, extraChildren }) {
      const { asn1 } = forge;
      const child = (type, value) => asn1.create(asn1.Class.UNIVERSAL, type, false, value);
      const algorithm = [child(asn1.Type.OID, asn1.oidToDer(forge.pki.oids.sha256).getBytes())];
      if (parameters) algorithm.push(child(asn1.Type.NULL, ''));
      for (let i = 0; i < extraChildren; i++) {
        algorithm.push(child(asn1.Type.OCTETSTRING, 'unconsumed signature garbage'));
      }
      const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
        child(asn1.Type.OCTETSTRING, digest),
      ]);
      // Sign the malformed DigestInfo with valid PKCS#1 padding, isolating the
      // nested ASN.1 check from key strength and padding validation.
      return keys.privateKey.sign(asn1.toDer(info).getBytes(), 'NONE');
    }

    it.each([true, false])('accepts a valid DigestAlgorithm (NULL parameters: %s)', (parameters) => {
      expect(keys.publicKey.verify(digest, signature({ parameters, extraChildren: 0 }))).toBe(true);
    });

    it.each([true, false])('rejects an extra nested DigestAlgorithm child (NULL parameters: %s)', (parameters) => {
      expect(() => keys.publicKey.verify(digest, signature({ parameters, extraChildren: 1 })))
        .toThrow('DigestInfo');
    });
  });
}

it('limits the advisory exception to the pinned, patched node-forge release', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const proxy = JSON.parse(readFileSync(`${root}/packages/credential-proxy/package.json`, 'utf8'));
  expect(proxy.dependencies['node-forge']).toBe('1.4.0');
  expect(manifest.pnpm.patchedDependencies['node-forge@1.4.0']).toBe('patches/node-forge@1.4.0.patch');
  expect(manifest.pnpm.auditConfig).toEqual({ ignoreGhsas: ['GHSA-86w9-cpqp-85rv'] });
});
