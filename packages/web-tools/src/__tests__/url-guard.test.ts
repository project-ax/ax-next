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
      'http://metadata.google.internal/x',
    ]) {
      expect(isAllowedExtractUrl(u)).toBe(false);
    }
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedExtractUrl('not a url')).toBe(false);
    expect(isAllowedExtractUrl('')).toBe(false);
  });
});
