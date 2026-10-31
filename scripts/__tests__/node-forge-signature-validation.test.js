import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Keep the CVE-2026-85393 regression after replacing our local backport with
// node-forge 1.4.1. Test both consumers, including the preset's test tools,
// in the unconditional scripts suite so a dependency regression fails CI.
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

it('uses the pinned upstream node-forge fix without a local patch or audit exception', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const proxy = JSON.parse(readFileSync(`${root}/packages/credential-proxy/package.json`, 'utf8'));
  const preset = JSON.parse(readFileSync(`${root}/presets/k8s/package.json`, 'utf8'));
  expect(proxy.dependencies['node-forge']).toBe('1.4.1');
  expect(preset.devDependencies['node-forge']).toBe('1.4.1');
  expect(manifest.pnpm.patchedDependencies).not.toHaveProperty('node-forge@1.4.0');
  // The braces exception (GHSA-vfj7-8cjw-p6xm, TASK-750) has its own guard in
  // braces-dev-only-audit-exception.test.js. The zod one (GHSA-mrhx-c7xc-m3w5) is
  // covered by a local patch, patches/zod@3.25.76.patch (TASK-938), guarded by
  // zod-issue-bound.test.js and zod-audit-exception.test.js. The minimatch
  // (GHSA-g3hv-75wg-m249) and glob (GHSA-3g3m-2fjr-6pw4) exceptions are guarded
  // by minimatch-glob-dev-only-audit-exception.test.js. Any further entry
  // needs a guard too.
  expect(manifest.pnpm.auditConfig).toEqual({
    ignoreGhsas: ['GHSA-vfj7-8cjw-p6xm', 'GHSA-mrhx-c7xc-m3w5', 'GHSA-g3hv-75wg-m249', 'GHSA-3g3m-2fjr-6pw4'],
  });
});
