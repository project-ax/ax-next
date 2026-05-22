// Defense-in-depth URL gate for web_extract. Anthropic fetches server-side
// (so this cannot, by itself, stop SSRF against our cluster — Anthropic's
// network can't reach it), but we still refuse obviously-internal targets
// before spending an API call, and to keep the tool's contract honest:
// "extract a public web page", not "probe an address".

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal)$/i;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 0) return true;
  return false;
}

export function isAllowedExtractUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // Strip IPv6 brackets for the loopback check.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (isPrivateIpv4(host)) return false;
  return true;
}
