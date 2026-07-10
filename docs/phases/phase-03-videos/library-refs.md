---
libs:
  bullmq:
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-10T19:52:00-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-10T19:52:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-10T19:53:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-10T19:53:00-03:00"
  nanoid:
    version: "^3.3.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-10T19:53:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-10T19:45:35-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Pulled via Context7. Re-fetch when the underlying TD changes.

## bullmq + @nestjs/bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, 1397 snippets. Maps to `phase-03-videos/TD-01` Decision A. `@nestjs/bullmq@11.x` is the official NestJS 11-compatible wrapper.

### Module registration (root connection + queue)

```typescript
// Root (AppModule / WorkerModule): connection comes from queue.config.ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.redisHost, port: config.redisPort },
  }),
}),
// Feature module:
BullModule.registerQueue({ name: 'video-processing' }),
```

### Producer (API side)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private queue: Queue) {}

await this.queue.add('process-video', payload, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
  removeOnComplete: true,
});
```

Built-in exponential backoff formula: `delay * 2^(attemptsMade - 1)`.

### Consumer (worker side)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    // throwing marks the attempt failed → BullMQ retries per job opts;
    // after the last attempt the job lands in the failed set.
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job) { /* terminal failure handling when attemptsMade === opts.attempts */ }
}
```

Notes: at-least-once delivery — `process()` must be idempotent (re-check video status before side effects). The processor class is a provider; NestJS manages the underlying `Worker` lifecycle (graceful shutdown via `app.close()`).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, 24k snippets. Maps to `phase-03-videos/TD-02`, `TD-06`, `TD-08`.

### Client for MinIO (S3-compatible)

```typescript
new S3Client({
  endpoint: 'http://minio:9000',   // Compose service name
  forcePathStyle: true,            // required for MinIO (no virtual-host DNS)
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
});
```

**Presign caveat:** URLs signed against `http://minio:9000` are only valid for that host — the signature covers the host header. For clients outside the Compose network, presigns must be generated against the public endpoint (`STORAGE_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000`); a second S3Client instance bound to the public endpoint handles presigning.

### Multipart upload flow (TD-02)

```typescript
// 1. initiate
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
// 2. presign each part (PartNumber 1..N)
const url = await getSignedUrl(s3Public, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn });
// 3. client PUTs bytes to each url and collects the ETag response headers
// 4. complete — Parts must be ordered by PartNumber, ETags from step 3
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '...' }, ...] },
}));
// abort path:
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

S3 protocol constraints: single PUT caps at 5GB; multipart parts 5MB–5GB (last part may be smaller), max 10,000 parts. 100MB parts → 10GB = 100 parts.

### Presigned GET for streaming/download (TD-06)

```typescript
const cmd = new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: download ? `attachment; filename="${name}"` : undefined,
});
const url = await getSignedUrl(s3Public, cmd, { expiresIn: 3600 });
```

`ResponseContentDisposition` becomes the `response-content-disposition` query param of the presigned URL. Range/206 is handled natively by MinIO/S3 on GET — the player sends `Range` headers directly to the storage URL.

### Bucket bootstrap

`CreateBucketCommand` + `HeadBucketCommand` (idempotent ensure-bucket on startup / init job). MinIO Compose service uses `minio server /data`; healthcheck via `mc ready local` or HTTP `/minio/health/live`.

## nanoid

**Source:** `/ai/nanoid` (Context7). Maps to `phase-03-videos/TD-05` Decision A.

**Version pin:** `nanoid@^3.3.x` — v4+ is ESM-only and cannot be `require`d from this CommonJS build (`module: nodenext`, no `"type": "module"` in package.json). v3 is CJS-native and still maintained for security fixes.

```typescript
import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
export const generatePublicId = customAlphabet(ALPHABET, 11); // 64^11 ≈ 7.3e19
```

Cryptographically secure (`crypto.randomBytes` under the hood). Collision guarded in depth by the DB `UNIQUE` constraint + single insert retry.

## ffmpeg / ffprobe (system binaries — no npm lib, TD-04)

Installed via apt in `Dockerfile.dev` (`ffmpeg` package provides both binaries). Canonical invocations:

```bash
# metadata (JSON on stdout)
ffprobe -v error -print_format json -show_format -show_streams <input>
# thumbnail: seek to timestamp, capture 1 frame, scale to 320px width
ffmpeg -y -ss <seconds> -i <input> -frames:v 1 -vf scale=320:-1 <output.jpg>
```

`format.duration` (seconds, string) → duration; `streams[codec_type=video]` → width/height/codec. Exit code ≠ 0 → processing failure (job retry per TD-07).
