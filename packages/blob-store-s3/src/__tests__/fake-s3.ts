import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// In-memory fake of the AWS SDK v3 S3Client `send()` dispatch surface, scoped
// to exactly the five commands S3BlobStore issues. We hand-roll this instead
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
//
// ListObjectsV2 is modelled as faithfully as the store needs: keys come back in
// lexicographic order, narrowed by `Prefix`, then by `StartAfter` (exclusive)
// or — once a page has been taken — by the opaque `ContinuationToken`. A page
// holds at most `MaxKeys` keys (default and cap 1000, like S3); a page that
// stops short of the end says `IsTruncated` and carries a
// `NextContinuationToken`. A real server ignores `StartAfter` once a token is
// present; so does this one.
// ---------------------------------------------------------------------------

type AnyCommand =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand
  | ListObjectsV2Command;

/** ListObjectsV2's hard page cap, and its default when `MaxKeys` is omitted. */
const LIST_PAGE_CAP = 1000;
const TOKEN_PREFIX = 'fake-token:';

/** One recorded command. The List* fields are only set on ListObjectsV2 calls. */
export interface FakeS3Call {
  name: string;
  Bucket?: string;
  Key?: string;
  Prefix?: string;
  StartAfter?: string;
  MaxKeys?: number;
  ContinuationToken?: string;
}

export class FakeS3Client {
  /** bucket -> (key -> bytes). Exposed for assertions / tampering in tests. */
  readonly buckets = new Map<string, Map<string, Uint8Array>>();

  /** Every command the store sent, in order — lets tests assert call shape. */
  readonly calls: FakeS3Call[] = [];

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

    if (command instanceof ListObjectsV2Command) {
      return this.listObjectsV2(command.input);
    }

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

    throw new Error(`FakeS3Client: unsupported command ${(command as object).constructor.name}`);
  }

  private listObjectsV2(input: {
    Bucket?: string | undefined;
    Prefix?: string | undefined;
    StartAfter?: string | undefined;
    MaxKeys?: number | undefined;
    ContinuationToken?: string | undefined;
  }): unknown {
    const Bucket = input.Bucket ?? '';
    const call: FakeS3Call = { name: 'ListObjectsV2', Bucket };
    if (input.Prefix !== undefined) call.Prefix = input.Prefix;
    if (input.StartAfter !== undefined) call.StartAfter = input.StartAfter;
    if (input.MaxKeys !== undefined) call.MaxKeys = input.MaxKeys;
    if (input.ContinuationToken !== undefined) call.ContinuationToken = input.ContinuationToken;
    this.calls.push(call);

    // Where this page starts, exclusive: the token wins over StartAfter.
    let startAfter = input.StartAfter;
    if (input.ContinuationToken !== undefined) {
      if (!input.ContinuationToken.startsWith(TOKEN_PREFIX)) {
        throw new Error('FakeS3Client: malformed ContinuationToken');
      }
      startAfter = input.ContinuationToken.slice(TOKEN_PREFIX.length);
    }
    const maxKeys = Math.min(input.MaxKeys ?? LIST_PAGE_CAP, LIST_PAGE_CAP);
    const prefix = input.Prefix ?? '';

    const matching = [...(this.buckets.get(Bucket)?.entries() ?? [])]
      .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;

    const res: Record<string, unknown> = {
      Name: Bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
      KeyCount: page.length,
      IsTruncated: truncated,
      Contents: page.map(([Key, bytes]) => ({ Key, Size: bytes.length })),
      $metadata: { httpStatusCode: 200 },
    };
    if (truncated) res['NextContinuationToken'] = TOKEN_PREFIX + page[page.length - 1]![0];
    return res;
  }
}
