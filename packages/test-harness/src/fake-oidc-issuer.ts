/**
 * A loopback OIDC issuer for tests: one signing key, a JWKS route, and a
 * `mint` that signs whatever claims a test hands it. Test-support only; it
 * never ships in a product package.
 *
 * `node:crypto` and `node:http` only, so @ax/test-harness gains no dependency.
 *
 * `mint`'s `alg` override exists to produce FORGED tokens: `'HS256'` signs
 * with the public key's SPKI DER bytes as the HMAC secret (the classic
 * algorithm-confusion probe), and `'none'` leaves the signature empty. Every
 * other token is signed with the issuer's own key and algorithm.
 */
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOidcIssuer {
  /** `http://127.0.0.1:<port>` */
  issuer: string;
  /** `http://127.0.0.1:<port>/jwks` */
  jwksUrl: string;
  kid: string;
  mint(
    claims: Record<string, unknown>,
    opts?: { alg?: 'RS256' | 'ES256' | 'HS256' | 'none'; kid?: string },
  ): string;
  /** The JWKS route answers this status from now on (default 200). */
  setJwksStatus(status: number): void;
  /** How many requests the JWKS route has received. */
  jwksRequests(): number;
  close(): Promise<void>;
}

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export async function startFakeOidcIssuer(
  opts?: { alg?: 'RS256' | 'ES256' },
): Promise<FakeOidcIssuer> {
  const alg = opts?.alg ?? 'RS256';
  const { privateKey, publicKey } =
    alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' };
  const hmacSecret = publicKey.export({ type: 'spki', format: 'der' });

  let jwksStatus = 200;
  let jwksCount = 0;

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/jwks') {
      jwksCount += 1;
      if (jwksStatus !== 200) {
        res.writeHead(jwksStatus, { 'content-type': 'text/plain' });
        res.end('unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  function signWithOwnKey(data: Buffer, key: KeyObject): Buffer {
    return alg === 'ES256'
      ? sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', data, key);
  }

  let closed: Promise<void> | undefined;

  return {
    issuer,
    jwksUrl: `${issuer}/jwks`,
    kid,
    mint(claims, mintOpts) {
      const headerAlg = mintOpts?.alg === 'HS256' || mintOpts?.alg === 'none' ? mintOpts.alg : alg;
      const header = { alg: headerAlg, typ: 'JWT', kid: mintOpts?.kid ?? kid };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const data = Buffer.from(signingInput);
      let signature: string;
      if (headerAlg === 'none') {
        signature = '';
      } else if (headerAlg === 'HS256') {
        signature = createHmac('sha256', hmacSecret).update(data).digest('base64url');
      } else {
        signature = b64url(signWithOwnKey(data, privateKey));
      }
      return `${signingInput}.${signature}`;
    },
    setJwksStatus(status) {
      jwksStatus = status;
    },
    jwksRequests() {
      return jwksCount;
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets from fetch would otherwise hold close() open.
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
