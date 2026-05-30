import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// In-memory fake of the AWS SDK v3 S3Client `send()` dispatch surface, scoped
// to exactly the four commands S3BlobStore issues. We hand-roll this instead
// of pulling in `aws-sdk-client-mock` so the package adds ONE third-party
// dependency total (@aws-sdk/client-s3) and `pnpm audit` stays minimal — a new
// dev dep is new supply-chain surface for zero behavioral gain here.
//
// It models a single bucket as a `key -> bytes` map and mimics the real
// client's error contract: HeadObject throws `NotFound`, GetObject throws
// `NoSuchKey` (both with the right `name` + a 404 `$metadata.httpStatusCode`),
// and DeleteObject is a no-op on a missing key (S3 returns 204 either way).
// `transformToByteArray()` on the GetObject body matches the real streaming
// payload helper the store relies on.
// ---------------------------------------------------------------------------

type AnyCommand =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand;

export class FakeS3Client {
  /** bucket -> (key -> bytes). Exposed for assertions / tampering in tests. */
  readonly buckets = new Map<string, Map<string, Uint8Array>>();

  /** Every command the store sent, in order — lets tests assert call shape. */
  readonly calls: Array<{ name: string; Bucket?: string; Key?: string }> = [];

  private bucket(name: string): Map<string, Uint8Array> {
    let b = this.buckets.get(name);
    if (b === undefined) {
      b = new Map();
      this.buckets.set(name, b);
    }
    return b;
  }

  /** Test helper: directly seed/overwrite an object (used to simulate tamper). */
  _put(bucket: string, key: string, bytes: Uint8Array): void {
    this.bucket(bucket).set(key, bytes);
  }

  /** Test helper: read the raw stored bytes for a key, or undefined. */
  _get(bucket: string, key: string): Uint8Array | undefined {
    return this.buckets.get(bucket)?.get(key);
  }

  async send(command: AnyCommand): Promise<unknown> {
    const input = (command as { input: { Bucket?: string; Key?: string; Body?: unknown } })
      .input;
    const Bucket = input.Bucket ?? '';
    const Key = input.Key ?? '';

    if (command instanceof PutObjectCommand) {
      this.calls.push({ name: 'PutObject', Bucket, Key });
      const body = input.Body;
      const bytes =
        body instanceof Uint8Array
          ? new Uint8Array(body)
          : new Uint8Array(Buffer.from(body as Buffer));
      this.bucket(Bucket).set(Key, bytes);
      return { $metadata: { httpStatusCode: 200 } };
    }

    if (command instanceof HeadObjectCommand) {
      this.calls.push({ name: 'HeadObject', Bucket, Key });
      const bytes = this.buckets.get(Bucket)?.get(Key);
      if (bytes === undefined) {
        throw new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } });
      }
      return { ContentLength: bytes.length, $metadata: { httpStatusCode: 200 } };
    }

    if (command instanceof GetObjectCommand) {
      this.calls.push({ name: 'GetObject', Bucket, Key });
      const bytes = this.buckets.get(Bucket)?.get(Key);
      if (bytes === undefined) {
        throw new NoSuchKey({
          message: 'The specified key does not exist.',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        Body: {
          transformToByteArray: async (): Promise<Uint8Array> => new Uint8Array(bytes),
        },
        ContentLength: bytes.length,
        $metadata: { httpStatusCode: 200 },
      };
    }

    if (command instanceof DeleteObjectCommand) {
      this.calls.push({ name: 'DeleteObject', Bucket, Key });
      // S3 DeleteObject is idempotent — 204 whether or not the key existed.
      this.buckets.get(Bucket)?.delete(Key);
      return { $metadata: { httpStatusCode: 204 } };
    }

    throw new Error(`FakeS3Client: unsupported command ${command.constructor.name}`);
  }
}
