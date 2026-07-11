---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-10T19:12:37-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-10T19:51:51-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-10T19:13:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion backbone — direct-to-storage multipart upload of files up to 10GB with automatic draft pre-registration, queue-driven processing (metadata extraction + thumbnail generation) in a dedicated FFmpeg worker, unique public URLs, and presigned streaming/download delivery — adding MinIO, Redis, and the video worker to the Docker Compose stack.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Infrastructure Services

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, add MinIO and Redis services to Docker Compose, and install FFmpeg in the dev image.

**Technical actions:**

- Install production dependencies in nestjs-project: `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `nanoid@^3.3.x` (v3 pinned — v4+ is ESM-only and this build compiles to CommonJS)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'` — internal Docker host), `STORAGE_PUBLIC_ENDPOINT` (string, default `'http://localhost:9000'` — host-reachable endpoint that presigned URLs are signed against), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube-videos'`), `STORAGE_PRESIGN_EXPIRES_SECONDS` (number, default `3600`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema (`STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` required, others with defaults). Update `.env.example` with all new variables and Compose-compatible defaults (MinIO root user/password `streamtube` / `streamtube-secret`)
- Add MinIO service to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` (S3 API) and `9001:9001` (console), env `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` matching the storage credentials, named volume for `/data`, healthcheck via `mc ready local`
- Add Redis service to `nestjs-project/compose.yaml` — image `redis:8-alpine`, port `6379:6379`, healthcheck `redis-cli ping`
- Update `nestjs-project/Dockerfile.dev` — install `ffmpeg` via apt (provides both `ffmpeg` and `ffprobe` binaries, used by the worker in SI-03.6)
- Make `nestjs-api` depend on `db`, `mailpit`, `redis`, and `minio` (healthy)

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new environment variables are provided — existing E2E test (`GET /` returns 200) still passes
- Starting the application without `STORAGE_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start
- `docker compose up -d` brings up `minio` (S3 API on 9000, console on 9001) and `redis` (6379) healthy alongside the existing stack
- `ffprobe -version` and `ffmpeg -version` succeed inside the `nestjs-api` container

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity owned by a channel, with the status lifecycle from TD-07, the public URL identifier from TD-05, and the storage keys from TD-08. Generate the migration and extend the migration-runner integration test.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `channel_id` (uuid FK → channels, not null), `title` (varchar(100), not null — initialized from the original filename without extension), `public_id` (varchar(11), unique, not null — nanoid), `status` (enum `video_status`: `'draft'`, `'uploading'`, `'processing'`, `'ready'`, `'failed'`, default `'draft'`), `original_filename` (varchar(255), not null), `mime_type` (varchar(100), not null), `size_bytes` (bigint, not null), `storage_key` (varchar, not null — `videos/{id}/original{ext}` per TD-08), `upload_id` (varchar, nullable — S3 multipart upload id while the upload is in flight), `thumbnail_key` (varchar, nullable — set by the worker), `duration_seconds` (int, nullable — set by the worker), `metadata` (jsonb, nullable — `{ width, height, codec, format }` from ffprobe), `processing_error` (text, nullable — terminal failure detail per TD-07), `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn). Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`
- Add indexes: unique on `(public_id)`, index on `(channel_id)`, index on `(status)`
- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])`, registered in `AppModule`
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL (enum type `videos_status_enum`, FK to channels, unique/normal indexes)
- Update `src/database/migrations.integration-spec.ts` — register the `Video` entity and `CreateVideos` migration in the test DataSource, expect **three** migrations from `runMigrations()`, add `videos` to the managed-tables list, and assert the `videos` table after apply / absence after `undoLastMigration()`. In the `beforeAll` cleanup, also `DROP TYPE IF EXISTS` the enum types (`verification_tokens_type_enum`, `videos_status_enum`) so the suite is re-runnable against a database where migrations had already been applied (fixes the latent leftover-enum failure mode)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id` constraint, status enum values (invalid value rejected), FK to channels, jsonb `metadata` round-trip, nullable worker-owned columns, `size_bytes` bigint round-trip, timestamps auto-populated |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` wiring |
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations()` applies three migrations and `videos` table exists; `undoLastMigration()` removes it; suite re-runnable (enum cleanup) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `video_status` enum, FK to `channels`, and the unique index on `public_id`
- Inserting a video with a duplicate `public_id` fails with a unique constraint violation
- Inserting a video with a status outside the enum is rejected by the database
- The migration is reversible: `migration:revert` drops the table and enum cleanly

---

### SI-03.3 — Storage Module (S3 Client, Presigning, Bucket Bootstrap)

**Description:** Create the `StorageModule` wrapping the AWS SDK v3 S3 client for MinIO: dual-endpoint clients (internal for API/worker calls, public for presigning), multipart upload primitives, presigned GET for delivery, object streaming for the worker, and idempotent bucket bootstrap.

**Technical actions:**

- Create `src/storage/storage.module.ts` — `StorageModule` providing and exporting `StorageService`
- Create `src/storage/storage.service.ts` — `StorageService` injecting `storageConfig`. Instantiate two `S3Client`s: `internal` bound to `storage.endpoint` and `presigner` bound to `storage.publicEndpoint` — both with `forcePathStyle: true` (MinIO requirement) and the configured credentials/region. Presigned URLs are signed by the `presigner` client so the signature matches the host clients actually reach (the signature covers the `Host` header)
- Implement `onApplicationBootstrap(): ensureBucket()` — `HeadBucketCommand`; on 404/`NotFound`, `CreateBucketCommand`; swallow `BucketAlreadyOwnedByYou` (idempotent — API and worker both run it)
- Implement multipart primitives: `createMultipartUpload(key, contentType): Promise<string /* uploadId */>`, `presignUploadPart(key, uploadId, partNumber): Promise<string>` (via `getSignedUrl(presigner, new UploadPartCommand(...), { expiresIn })`), `completeMultipartUpload(key, uploadId, parts: { partNumber, etag }[]): Promise<void>` (parts sorted by `partNumber`), `abortMultipartUpload(key, uploadId): Promise<void>`
- Implement delivery/worker primitives: `presignGetObject(key, opts?: { downloadFilename?: string }): Promise<string>` — sets `ResponseContentDisposition: attachment; filename="..."` when `downloadFilename` is given; `putObject(key, body, contentType): Promise<void>` (thumbnail upload); `downloadToFile(key, destPath): Promise<void>` — streams `GetObjectCommand` body to disk with `pipeline()` (worker fetches the original for FFmpeg)
- Register `StorageModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | Presigner client (public endpoint) is used for presigning and internal client for data commands; `completeMultipartUpload` sorts parts by number; `ensureBucket` creates only when missing (mocked `send`) |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: `ensureBucket` idempotent; multipart round-trip (initiate → PUT one part via presigned URL → complete → object exists with expected size); presigned GET serves the bytes, honors `Range` header with `206 Partial Content`, and `downloadFilename` yields `Content-Disposition: attachment`; `downloadToFile` writes the object to disk |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- On application bootstrap the bucket `streamtube-videos` exists in MinIO (created if missing, no error if present)
- A file uploaded via the multipart flow (initiate → presigned part PUT → complete) is retrievable from the bucket with the exact original bytes
- A presigned GET URL fetched with `Range: bytes=0-99` returns HTTP 206 with exactly 100 bytes
- A presigned GET URL generated with a download filename returns `Content-Disposition: attachment; filename="..."`
- Presigned URLs point at the public endpoint host, not the internal Docker hostname

---

### SI-03.4 — Upload Orchestration Endpoints (Initiate, Part URLs, Complete, Abort)

**Description:** Implement the multipart upload handshake from TD-02: initiating an upload pre-registers the video as a draft owned by the caller's channel and opens the S3 multipart upload; part URLs are presigned on demand; completing finalizes the object, flips the status to `processing`, and enqueues the processing job (producer wired in SI-03.5); aborting cancels the multipart upload and removes the draft row.

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto` with `@IsString() @IsNotEmpty() @MaxLength(255)` filename, `@IsString() @Matches(/^video\//)` mime_type (only `video/*` accepted), `@IsInt() @Min(1) @Max(10 * 1024 ** 3)` size_bytes (10GB cap)
- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `parts: UploadPartDto[]` (`@ValidateNested({ each: true })`, `@ArrayMinSize(1)`), each `UploadPartDto` with `@IsInt() @Min(1) @Max(10000)` part_number and `@IsString() @IsNotEmpty()` etag
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `Repository<Channel>`, and `StorageService`. Implement:
  - `initiateUpload(userId, dto)` — resolve the caller's channel by `user_id` (1:1 from Phase 02); generate `public_id` via `src/videos/public-id.util.ts` (`customAlphabet('[0-9A-Za-z_-]', 11)` from nanoid); derive `storage_key = videos/{id}/original{ext}` (extension from the sanitized original filename); create the row with `status: 'draft'`, `title` = filename without extension (truncated to 100); call `storage.createMultipartUpload(storage_key, mime_type)`; persist `upload_id` and flip `status → 'uploading'`; retry the insert once on `public_id` unique violation (PostgreSQL `23505`); compute `part_size = 100MB` and `part_count = ceil(size_bytes / part_size)`; return `{ video_id, public_id, upload_id, part_size, part_count }`
  - `getUploadPartUrl(userId, videoId, partNumber)` — load video, assert ownership (video's channel belongs to `userId`, else `NotVideoOwnerException`), assert `status === 'uploading'` (else `InvalidUploadStateException`), assert `1 ≤ partNumber ≤ part_count`; return presigned URL
  - `completeUpload(userId, videoId, dto)` — ownership + `status === 'uploading'` checks; `storage.completeMultipartUpload(...)`; set `upload_id = null`, `status → 'processing'`; enqueue the processing job (SI-03.5); return the updated video
  - `abortUpload(userId, videoId)` — ownership + `status === 'uploading'` checks; `storage.abortMultipartUpload(...)`; delete the row
- Create `src/videos/videos.controller.ts` — `VideosController` (route prefix `'videos'`, `@ApiTags('videos')`), all four routes authenticated (global guard, no `@Public()`): `@Post('upload')` → 201 initiate response; `@Get(':id/upload/parts/:partNumber/url')` → 200 `{ url }`; `@Post(':id/upload/complete')` → 200 video response; `@Delete(':id/upload')` → 204
- Create domain exceptions in `src/videos/exceptions/` extending `DomainException` (Phase 02 filter, inherited): `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `NotVideoOwnerException` (403 `NOT_VIDEO_OWNER`), `InvalidUploadStateException` (409 `INVALID_UPLOAD_STATE`)
- Map the video response shape in `src/videos/dto/video-response.dto.ts` — `{ id, public_id, title, status, original_filename, mime_type, size_bytes, duration_seconds, created_at }` (no storage keys leaked)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Generates 11-char IDs from the URL-safe alphabet; consecutive calls differ |
| `src/videos/videos.service.spec.ts` | Unit | Initiate: draft created, multipart opened, status flips to uploading, public_id collision retried once; part URL: ownership/state/part-range guards; complete: finalizes storage, flips to processing, enqueues job; abort: aborts multipart and deletes row (storage + queue mocked) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full handshake against real DB + MinIO: initiate persists draft with upload_id; complete after a real part PUT finalizes the object and persists `processing`; abort removes the multipart upload and the row |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/upload` 201 with `{ video_id, public_id, upload_id, part_size, part_count }`; 401 unauthenticated; 400 on non-video mime or size > 10GB; part-url 200 for owner / 403 for another user / 409 when not uploading; complete 200 → status processing; abort 204 → subsequent GET 404 |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos/upload` (authenticated) with a valid filename/mime/size returns 201 with `{ video_id, public_id, upload_id, part_size: 104857600, part_count }` — a `videos` row exists with `status = 'uploading'`, owned by the caller's channel, before any byte is transferred
- `POST /videos/upload` with `size_bytes` above 10GB returns 400 (validation); with a non-`video/*` mime type returns 400 — no draft row is created
- File bytes never transit the NestJS API: parts are PUT directly to presigned MinIO URLs by the client
- `POST /videos/:id/upload/complete` with the collected part ETags returns 200 with `status = 'processing'` and the object exists in the bucket under `videos/{id}/original{ext}`
- Only the owner can request part URLs, complete, or abort — another authenticated user receives 403 `NOT_VIDEO_OWNER`
- `DELETE /videos/:id/upload` aborts the multipart upload in MinIO and removes the draft row (204)

---

### SI-03.5 — Processing Queue (BullMQ Root Config and Producer)

**Description:** Wire BullMQ per TD-01: root Redis connection from the `queue` config namespace, the `video-processing` queue registration, and the producer call on upload completion with the retry policy from TD-07.

**Technical actions:**

- Create `src/queue/queue.module.ts` — global-ish infrastructure module calling `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: cfg => ({ connection: { host: cfg.redisHost, port: cfg.redisPort } }) })`; import it in `AppModule`
- Define the queue contract in `src/videos/processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, payload type `ProcessVideoJobData = { videoId: string }`, and the job options: `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true }` (5s → 10s → 20s per BullMQ's `delay * 2^(attemptsMade-1)`)
- Register the queue in `VideosModule` via `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`
- In `VideosService.completeUpload` (SI-03.4), inject `@InjectQueue(VIDEO_PROCESSING_QUEUE)` and `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...JOB_OPTIONS, jobId: videoId })` — `jobId = videoId` deduplicates accidental double-completion enqueues
- Job publication happens after the DB status flip to `processing` — at-least-once semantics with an idempotent consumer (SI-03.6) per TD-01

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload` publishes `process-video` with `{ videoId }`, attempts=3, exponential backoff, `jobId = videoId` (queue mocked) |
| `src/queue/queue.module.integration-spec.ts` | Integration | Against real Redis: a job added to `video-processing` is retrievable via `queue.getJob(jobId)` with the configured options; connection uses the Compose service name |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- Completing an upload enqueues exactly one `process-video` job in Redis with `{ videoId }`, attempts=3 and exponential backoff (5s base)
- Enqueueing twice with the same `videoId` does not create a second pending job (`jobId` dedup)
- The queue connects to Redis via the `redis` Compose service name — no `localhost` reference

---

### SI-03.6 — Video Worker (Processor, FFmpeg Service, Worker Entrypoint and Container)

**Description:** Implement the video worker from TD-03/TD-04: a second NestJS application context in the same codebase, running in its own container, consuming `video-processing`. The processor downloads the original from MinIO, extracts duration/metadata with ffprobe, captures a thumbnail frame with ffmpeg, uploads it to storage, and updates the video row — with idempotency and the terminal-failure policy from TD-07.

**Technical actions:**

- Create `src/videos/processing/ffmpeg.service.ts` — `FfmpegService` with `probe(filePath): Promise<VideoProbeResult>` spawning `ffprobe -v error -print_format json -show_format -show_streams` (parse `format.duration` → seconds as int, first `codec_type === 'video'` stream → `{ width, height, codec }`, `format.format_name` → format) and `captureFrame(filePath, atSeconds, outPath): Promise<void>` spawning `ffmpeg -y -ss <atSeconds> -i <filePath> -frames:v 1 -vf scale=320:-1 <outPath>`. Both wrap `child_process.spawn` with stderr capture; non-zero exit → throw with the captured stderr (TD-04)
- Create `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` class `VideoProcessor extends WorkerHost` injecting `Repository<Video>`, `StorageService`, `FfmpegService`. `process(job)`: load the video (missing row → log and return — job is stale); **idempotency:** if `status === 'ready'`, return; download the original via `storage.downloadToFile` into `os.tmpdir()`; `probe()`; `captureFrame(min(1, duration/2))`; upload thumbnail to `videos/{id}/thumbnail.jpg` (`image/jpeg`, TD-08); update the row: `duration_seconds`, `metadata { width, height, codec, format }`, `thumbnail_key`, `status → 'ready'`, `processing_error → null`; always cleanup temp files in `finally`
- Terminal failure: `@OnWorkerEvent('failed')` — when `job.attemptsMade >= job.opts.attempts`, update the row to `status = 'failed'` with `processing_error = <error message>` (intermediate failed attempts leave the status at `processing` while BullMQ retries)
- Create `src/worker.ts` — worker entrypoint: `NestFactory.createApplicationContext(WorkerModule)` with shutdown hooks (`app.enableShutdownHooks()`); no HTTP listener
- Create `src/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot` (same Joi validation), `TypeOrmModule.forRootAsync` (same `databaseConfig` factory), `QueueModule`, `StorageModule`, `TypeOrmModule.forFeature([Video])`; providers: `VideoProcessor`, `FfmpegService`
- Add npm scripts: `"start:worker": "nest start --entryFile worker"`, `"start:worker:dev": "nest start --watch --entryFile worker"`
- Add `video-worker` service to `nestjs-project/compose.yaml` — same build/image and volume as `nestjs-api`, command `npm run start:worker:dev`, depends on `db`, `redis`, `minio` (healthy); no ports
- Register `FfmpegService` also in `VideosModule`? No — processing providers live only in `WorkerModule` (the API never processes); keep `VideoProcessor`/`FfmpegService` out of `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video.processor.spec.ts` | Unit | Skips when video is missing or already ready (idempotency); happy path calls download → probe → frame → upload → row update; `failed` handler marks terminal failure only on the last attempt (all collaborators mocked) |
| `src/videos/processing/ffmpeg.service.integration-spec.ts` | Integration | Against the real binaries: generate a 2s synthetic clip via `ffmpeg -f lavfi -i testsrc` in a temp dir; `probe()` returns duration≈2 and video stream dims; `captureFrame()` writes a non-empty JPEG; corrupt input file → probe rejects |
| `src/videos/processing/video.processor.integration-spec.ts` | Integration | Real DB + MinIO + FFmpeg: seed user/channel/video (`processing`) + upload a small synthetic clip as the original object; run `processor.process(fakeJob)`; row becomes `ready` with duration/metadata/thumbnail_key set and the thumbnail object exists in the bucket; second run is a no-op (idempotent) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.5

**Acceptance criteria:**

- `docker compose up -d` starts the `video-worker` container alongside the stack; it connects to Redis and consumes `video-processing`
- After `POST /videos/:id/upload/complete` of a real video file, the row transitions `processing → ready` automatically with `duration_seconds`, `metadata` (width/height/codec/format) and `thumbnail_key` populated, and `videos/{id}/thumbnail.jpg` exists in MinIO
- Processing a video that is already `ready` performs no writes (idempotent consumer, at-least-once safe)
- When processing fails on all 3 attempts (e.g., corrupt file), the row ends `failed` with `processing_error` filled — earlier attempts leave the status `processing` while BullMQ backs off (5s/10s/20s)
- The worker runs no HTTP server and the API runs no FFmpeg — CPU-bound work is isolated in the worker container (TD-03)

---

### SI-03.7 — Playback and Delivery Endpoints (Metadata, Streaming, Download)

**Description:** Implement the public delivery surface from TD-05/TD-06: video metadata lookup by `public_id`, streaming via redirect to a presigned storage URL (Range/206 served natively by MinIO), and download via presigned URL with attachment disposition.

**Technical actions:**

- Implement in `VideosService`:
  - `findByPublicId(publicId): Promise<Video>` — load with channel relation; missing → `VideoNotFoundException`
  - `getStreamUrl(publicId)` — load; `status !== 'ready'` → `VideoNotReadyException`; return `storage.presignGetObject(storage_key)`
  - `getDownloadUrl(publicId)` — same guards; return `storage.presignGetObject(storage_key, { downloadFilename: original_filename })`
  - `getThumbnailUrl(video)` — presigned GET of `thumbnail_key` when set (embedded in the metadata response)
- Add to `VideosController`, all `@Public()` (product rule: anonymous users watch freely):
  - `@Get(':publicId')` → 200 public metadata `{ public_id, title, status, duration_seconds, thumbnail_url, created_at, channel: { nickname, name } }` — non-`ready` videos return 404 `VIDEO_NOT_FOUND` for the public (draft/processing/failed videos are not publicly addressable in this phase)
  - `@Get(':publicId/stream')` → **302 redirect** (`Location: <presigned GET URL>`) — the player follows the redirect and issues `Range` requests directly against MinIO, which answers `206 Partial Content`
  - `@Get(':publicId/download')` → 302 redirect to the presigned URL carrying `response-content-disposition: attachment; filename="<original_filename>"`
- Create `VideoNotReadyException` (409 `VIDEO_NOT_READY`) in `src/videos/exceptions/`
- Route ordering: literal upload routes (`upload`) are declared before the `:publicId` wildcard routes in the controller to avoid shadowing

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Metadata/stream/download guards: unknown public_id → not found; not-ready → VideoNotReadyException; download passes the original filename to the presigner (storage mocked) |
| `test/videos.e2e-spec.ts` | E2E | Full pipeline: register/login/confirm user → initiate → PUT part to MinIO → complete → poll until `ready` (worker processors run in-test) → `GET /videos/:publicId` 200 with duration/thumbnail_url without auth; `/stream` 302 whose Location fetched with `Range: bytes=0-99` returns 206 and 100 bytes; `/download` 302 with attachment disposition; 404 for unknown id; 409 VIDEO_NOT_READY while still processing; upload routes not shadowed |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- `GET /videos/:publicId` without authentication returns 200 with the public metadata shape (including a presigned `thumbnail_url`) for a `ready` video, and 404 for unknown or non-`ready` videos
- `GET /videos/:publicId/stream` returns 302 with a presigned MinIO URL; fetching that URL with a `Range` header returns `206 Partial Content` — playback never requires downloading the full file, and the bytes do not transit the API
- `GET /videos/:publicId/download` returns 302 whose target serves `Content-Disposition: attachment; filename="<original_filename>"`
- Streaming/downloading a video that is still `processing` returns 409 `VIDEO_NOT_READY`
- Two videos uploaded from the same file receive distinct `public_id`s — URLs never conflict (unique index + retry)

---

### SI-03.8 — AI Documentation Update (CLAUDE.md Root and Backend)

**Description:** Update the AI-facing documentation to reflect the real post-phase state: the videos module, the new endpoints, the queue/worker/storage infrastructure, and the resolved "Message Queue (TBD)" decision.

**Technical actions:**

- Update root `CLAUDE.md` — Architecture section: replace `Message Queue (TBD)` with `Message Queue (Redis + BullMQ)`; keep the C4 container list consistent with the now-implemented Video Worker and Object Storage (MinIO local / S3-compatible)
- Update `nestjs-project/CLAUDE.md`:
  - Services list: add `redis` (6379), `minio` (9000 S3 API / 9001 console, bucket `streamtube-videos`), `video-worker` (no ports; BullMQ consumer with FFmpeg)
  - Add a "Videos module (Phase 03)" section documenting: the multipart upload handshake endpoints (initiate → part URLs → complete / abort), the delivery endpoints (metadata / stream / download via presigned redirect), the status lifecycle (`draft → uploading → processing → ready | failed`), the `video-processing` queue contract (`process-video`, `{ videoId }`, attempts=3 exponential backoff), and the worker entrypoint (`src/worker.ts`, `npm run start:worker:dev`)
  - Commands: add `start:worker` / `start:worker:dev` to the container-only commands list
- Verify every file path and behavior cited in the docs exists in the code (documentation inconsistent with code is an automatic-failure criterion)

**Dependencies:** SI-03.1 … SI-03.7 (documents the final state)

**Acceptance criteria:**

- Root `CLAUDE.md` no longer lists the message queue as TBD and matches the implemented architecture
- `nestjs-project/CLAUDE.md` documents the videos module, new services, and worker commands — every cited path/command exists in the repository
- No documented endpoint, file, or behavior diverges from the implemented code

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; storage keys derive from it (TD-08) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (1:1 user↔channel from Phase 02) |
| title | varchar(100) | not null | Initialized from original filename (no extension); editable in Phase 04 |
| public_id | varchar(11) | unique, not null | nanoid, alphabet `[0-9A-Za-z_-]` (TD-05) — the watch URL identifier |
| status | enum video_status | not null, default `'draft'` | `'draft' \| 'uploading' \| 'processing' \| 'ready' \| 'failed'` (TD-07) |
| original_filename | varchar(255) | not null | As sent by the client; reused on download disposition |
| mime_type | varchar(100) | not null | Must match `video/*` at initiate |
| size_bytes | bigint | not null | Declared size; ≤ 10GB enforced at initiate |
| storage_key | varchar | not null | `videos/{id}/original{ext}` (TD-08) |
| upload_id | varchar | nullable | S3 multipart upload id; non-null only while `status = 'uploading'` |
| thumbnail_key | varchar | nullable | `videos/{id}/thumbnail.jpg`; set by the worker |
| duration_seconds | int | nullable | From ffprobe `format.duration`; set by the worker |
| metadata | jsonb | nullable | `{ width, height, codec, format }` from ffprobe |
| processing_error | text | nullable | Terminal failure detail (TD-07); null on success |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(public_id)` — unique, `(channel_id)`, `(status)`

**Status lifecycle (TD-07):**

```
draft ──initiate──▶ uploading ──complete──▶ processing ──worker ok──▶ ready
                        │                        │
                      abort                 3 failed attempts
                        ▼                        ▼
                    (row deleted)             failed (processing_error set)
```

---

### API Contracts

#### POST /videos/upload (SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — original filename, max 255 chars
- mime_type: string, required — must match `video/*`
- size_bytes: integer, required — 1 … 10737418240 (10GB)

**Response 201:**
- video_id: string (uuid)
- public_id: string (11 chars)
- upload_id: string
- part_size: number — 104857600 (100MB)
- part_count: number — `ceil(size_bytes / part_size)`

**Error responses:**
- 401: missing/invalid access token
- 400 validation error: non-`video/*` mime, size out of range, missing fields

---

#### GET /videos/:id/upload/parts/:partNumber/url (SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned PUT URL for the part (client PUTs the raw bytes and collects the `ETag` response header)

**Error responses:**
- 401: missing/invalid access token
- 403 NOT_VIDEO_OWNER: video belongs to another user's channel
- 404 VIDEO_NOT_FOUND: unknown video id
- 409 INVALID_UPLOAD_STATE: video is not in `uploading` status
- 400 validation error: partNumber outside 1..part_count

---

#### POST /videos/:id/upload/complete (SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required, min 1 — `[{ part_number: int, etag: string }, ...]`

**Response 200:** video response object — `{ id, public_id, title, status: 'processing', original_filename, mime_type, size_bytes, duration_seconds: null, created_at }`

**Error responses:**
- 401 / 403 NOT_VIDEO_OWNER / 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: not in `uploading` status (e.g., completed twice)
- 400 validation error: empty/malformed parts

---

#### DELETE /videos/:id/upload (SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content — multipart upload aborted in storage, draft row removed.

**Error responses:**
- 401 / 403 NOT_VIDEO_OWNER / 404 VIDEO_NOT_FOUND
- 409 INVALID_UPLOAD_STATE: not in `uploading` status

---

#### GET /videos/:publicId (SI-03.7) — public

**Response 200:**
- public_id: string
- title: string
- status: string — always `'ready'` on the public surface in this phase
- duration_seconds: number
- thumbnail_url: string — presigned GET URL (expires per `STORAGE_PRESIGN_EXPIRES_SECONDS`)
- created_at: string (ISO)
- channel: `{ nickname: string, name: string }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` OR video not `ready` (drafts/processing/failed are not publicly addressable)

---

#### GET /videos/:publicId/stream (SI-03.7) — public

**Response 302:** `Location: <presigned MinIO GET URL>` — the player follows the redirect; MinIO serves `Range` requests natively with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id`
- 409 VIDEO_NOT_READY: video exists but `status !== 'ready'`

---

#### GET /videos/:publicId/download (SI-03.7) — public

**Response 302:** `Location: <presigned MinIO GET URL>` with `response-content-disposition: attachment; filename="<original_filename>"` baked into the signed query string.

**Error responses:**
- 404 VIDEO_NOT_FOUND / 409 VIDEO_NOT_READY (same rules as stream)

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos/upload | | ✓ | — | Draft is created on the caller's own channel |
| GET /videos/:id/upload/parts/:partNumber/url | | ✓ | ✓ | 403 NOT_VIDEO_OWNER otherwise |
| POST /videos/:id/upload/complete | | ✓ | ✓ | 403 NOT_VIDEO_OWNER otherwise |
| DELETE /videos/:id/upload | | ✓ | ✓ | 403 NOT_VIDEO_OWNER otherwise |
| GET /videos/:publicId | ✓ | | | Anonymous users watch freely (product rule) |
| GET /videos/:publicId/stream | ✓ | | | Presigned redirect; TTL is the access control (TD-06) |
| GET /videos/:publicId/download | ✓ | | | Same as stream + attachment disposition |

---

### Error Catalog

Error response format inherited from Phase 02: `{ statusCode, error, message }` via the global `DomainExceptionFilter`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown video id/public_id; public lookup of a non-`ready` video |
| NOT_VIDEO_OWNER | 403 | Video belongs to another channel | Upload management endpoints called by a non-owner |
| INVALID_UPLOAD_STATE | 409 | Upload is not in progress for this video | Part-url/complete/abort when `status !== 'uploading'` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Stream/download while `status !== 'ready'` |
| VALIDATION_ERROR | 400 | (array of field errors) | DTO validation failures (inherited format) |

---

### Events / Messages

**Queue:** `video-processing` (BullMQ over Redis — TD-01)

| Property | Value |
|----------|-------|
| Job name | `process-video` |
| Payload | `{ videoId: string }` — uuid of the `videos` row |
| Producer | `VideosService.completeUpload` (API) — after the row flips to `processing` |
| Consumer | `VideoProcessor` (video-worker container) |
| jobId | `videoId` — deduplicates double-completion enqueues |
| attempts | 3 |
| backoff | exponential, 5000ms base (5s → 10s → 20s) |
| removeOnComplete | true |
| Delivery | At-least-once — consumer is idempotent (`ready` rows are skipped) |
| Terminal failure | `@OnWorkerEvent('failed')` with `attemptsMade >= attempts` → `status = 'failed'`, `processing_error` persisted (TD-07) |

**Consumer side effects (success path):** original downloaded from storage → ffprobe metadata (`duration_seconds`, `width`, `height`, `codec`, `format`) → thumbnail frame at `min(1s, duration/2)` scaled to 320px width → `videos/{id}/thumbnail.jpg` uploaded → row updated to `ready`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
└── SI-03.3

SI-03.2 + SI-03.3
└── SI-03.4
    └── SI-03.5

SI-03.2 + SI-03.3 + SI-03.5
└── SI-03.6

SI-03.4 + SI-03.6
└── SI-03.7

SI-03.1 … SI-03.7
└── SI-03.8
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8

## Deliverables

- [ ] MinIO (S3-compatible object storage), Redis, and the video-worker container running via `docker compose up -d` alongside the existing stack
- [ ] `videos` table created by migration, linked to `channels`, with status lifecycle `draft → uploading → processing → ready | failed`
- [ ] Multipart upload handshake (initiate / presigned part URLs / complete / abort) supporting files up to 10GB with zero video bytes transiting the API
- [ ] Automatic draft pre-registration at upload initiation, owned by the caller's channel
- [ ] Automatic processing after completion: duration + metadata extracted via ffprobe in the worker
- [ ] Automatic thumbnail generated from a video frame and stored in the bucket
- [ ] Unique 11-char public URL identifier per video (nanoid + unique index, collision retry)
- [ ] Streaming via presigned URL redirect with native Range/206 support (no full download required)
- [ ] Download via presigned URL with attachment disposition and the original filename
- [ ] `video-processing` BullMQ queue with attempts=3 exponential backoff and idempotent consumer; terminal failures persist `failed` + `processing_error`
- [ ] Root and backend `CLAUDE.md` updated to the real post-phase state (queue no longer TBD, videos module documented)
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
