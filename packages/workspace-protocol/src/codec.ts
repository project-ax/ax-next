// bytes ↔ base64 codec helpers, shared by host plugin and pod-side server.
// JSON can't carry binary cleanly; the wire wraps every Bytes (Uint8Array)
// payload as a base64 string with the suffix `Base64` in field names.

export function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
export function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
