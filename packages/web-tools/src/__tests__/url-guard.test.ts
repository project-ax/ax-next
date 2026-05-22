import { describe, it, expect } from 'vitest';
import { isAllowedExtractUrl } from '../url-guard.js';

describe('isAllowedExtractUrl', () => {
  it('accepts public https and http URLs', () => {
    expect(isAllowedExtractUrl('https://example.com/page')).toBe(true);
    expect(isAllowedExtractUrl('http://example.com')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x', 'data:text/plain,hi', 'javascript:alert(1)']) {
      expect(isAllowedExtractUrl(u)).toBe(false);
    }
  });

  it('rejects loopback / private / link-local / metadata hosts', () => {
    for (const u of [
      'http://localhost/x',
      'https://127.0.0.1/x',
      'http://10.0.0.5/x',
      'https://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://[::]/x',
      'http://[fc00::1]/x', // unique-local (ULA), fc00::/7
      'http://[fd12:3456::1]/x', // unique-local (ULA), fd00::/8
      'http://[fe80::1]/x', // link-local, fe80::/10
      'http://metadata.google.internal/x',
    ]) {
      expect(isAllowedExtractUrl(u)).toBe(false);
    }
  });

  it('accepts a public IPv6 literal', () => {
    expect(isAllowedExtractUrl('http://[2606:4700:4700::1111]/x')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedExtractUrl('not a url')).toBe(false);
    expect(isAllowedExtractUrl('')).toBe(false);
  });
});
