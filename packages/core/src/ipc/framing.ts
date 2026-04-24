import { PluginError } from '../errors.js';

export const MAX_FRAME = 4 * 1024 * 1024;

export function encodeFrame(obj: unknown): Buffer {
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch (e) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: `encodeFrame: unserializable input (${(e as Error).message})`,
    });
  }
  if (json === undefined) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: 'encodeFrame: input serialized to undefined',
    });
  }
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_FRAME) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: `encodeFrame: body ${body.length} > MAX_FRAME ${MAX_FRAME}`,
    });
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const declared = this.buf.readUInt32BE(0);
      if (declared > MAX_FRAME) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/core',
          hookName: 'ipc',
          message: `FrameDecoder: declared ${declared} > MAX_FRAME ${MAX_FRAME}`,
        });
      }
      if (this.buf.length < 4 + declared) break;
      const body = this.buf.subarray(4, 4 + declared);
      this.buf = this.buf.subarray(4 + declared);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (e) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/core',
          hookName: 'ipc',
          message: `FrameDecoder: invalid JSON (${(e as Error).message})`,
        });
      }
      out.push(parsed);
    }
    return out;
  }
}
