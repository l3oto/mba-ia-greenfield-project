---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-10
scope_description: "Video upload and processing backbone: object storage usage, processing queue, video worker (FFmpeg), 10GB upload strategy, unique URL, streaming/download delivery, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload orchestration, processing pipeline, streaming/download endpoints), the new infrastructure (object storage, queue, video worker) and the videos table.
- `next-frontend/` — Frontend deferred: the video UI is explicitly out of scope for this phase (backend-only challenge). Cross-layer TDs below (upload handshake, streaming delivery) define the contract the frontend will consume in a future phase. No frontend-only TD in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram lists "Message Queue (TBD)" — this is the main open stack decision of the phase. The queue decouples upload completion from video processing: the API publishes a job, the video worker consumes it. The choice affects infrastructure (new containers), delivery guarantees, retry semantics, and NestJS integration effort.

**Options:**

### Option A: BullMQ (Redis-backed) via @nestjs/bullmq
- De-facto standard job queue for Node.js, built on Redis streams/lists with atomic Lua scripts. Official NestJS integration (`@nestjs/bullmq`) with decorators (`@Processor`, `@InjectQueue`) and DI-managed workers.
- **Pros:** First-class NestJS module maintained by the NestJS team — producers and consumers are idiomatic Nest code. Built-in retries with exponential backoff, delayed jobs, priorities, rate limiting, dead-letter via failed state, job progress and events. Redis is lightweight to run in Compose (single small container). Huge ecosystem (Bull Board dashboard).
- **Cons:** Adds Redis as a new infrastructure dependency. At-least-once delivery — consumers must be idempotent. Not a general-purpose message broker (no pub/sub routing across services beyond queue semantics).

### Option B: pg-boss (PostgreSQL-backed)
- Job queue implemented on top of PostgreSQL using `SKIP LOCKED`. Jobs live in a schema inside the existing database; no new infrastructure.
- **Pros:** Zero new containers — reuses PostgreSQL 17 already in the stack. Transactional enqueue (job insert can join the video's DB transaction). Retries, scheduling, archiving built in.
- **Cons:** No official NestJS module — integration is manual (custom provider + lifecycle hooks). Queue load competes with application DB (large video pipelines generate polling traffic). Smaller community than BullMQ. Job throughput bounded by Postgres row locking; less suited if processing fan-out grows (multiple resolutions in later phases).

### Option C: RabbitMQ (AMQP) via @golevelup/nestjs-rabbitmq
- Full message broker with exchanges/routing. NestJS integration via community package or the built-in microservices transport.
- **Pros:** Real broker semantics (ack/nack, dead-letter exchanges, routing keys) useful for polyglot consumers. Mature management UI. Per-message ack fits long video jobs.
- **Cons:** Heaviest option to operate (Erlang runtime, another sizable container). NestJS microservices RabbitMQ transport is request/response-oriented; job-queue patterns (retry with backoff, delayed jobs) must be assembled manually with DLX + TTL tricks. Overkill for a single Node consumer.

**Recommendation:** **Option A (BullMQ + Redis)** — The consumer is a single Node.js video worker, which is exactly BullMQ's design center: job queue with retries/backoff out of the box and an official NestJS module, keeping producer and worker code idiomatic. Redis is a small, disposable Compose service — cheaper to operate than RabbitMQ and isolated from the application database, unlike pg-boss. If later phases add polyglot consumers, a broker can be revisited.

**Decision:** A (BullMQ + Redis)

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Uploading 10GB through the API process would hold connections, memory and CPU hostage for the duration of the transfer (and is an automatic-failure criterion). The upload contract is cross-layer: the client executes the handshake the backend defines. S3-compatible storage (MinIO) constrains the options: a single `PUT` object upload is capped at 5GB by the S3 protocol, so a plain presigned PUT cannot satisfy the 10GB requirement.

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs (direct to storage)
- API creates the video draft, initiates a multipart upload (`CreateMultipartUpload`), and issues presigned URLs for each part (e.g., 100MB parts). The client uploads parts directly to MinIO/S3, then calls the API to complete (`CompleteMultipartUpload`), which enqueues processing.
- **Pros:** File bytes never pass through the API — zero API load regardless of file size. S3-native: parts up to 10,000 × 5GB (far beyond 10GB), parallel part upload, per-part retry (resume on failure of a single part). Works identically on MinIO and AWS S3. The API keeps full control of the lifecycle (draft pre-registration at initiation, queue publish at completion).
- **Cons:** Client-side orchestration (part splitting, ETag collection) — the frontend/consumer must implement the handshake. More endpoints (initiate / part URLs / complete / abort). Incomplete multipart uploads need a cleanup policy.

### Option B: Single presigned PUT URL
- API issues one presigned PUT URL; client sends the whole file in a single request to storage.
- **Pros:** Simplest possible handshake (one URL, one request). No part bookkeeping.
- **Cons:** **S3 protocol caps single PUT at 5GB — fails the 10GB requirement outright.** No resume: a network hiccup at 9GB restarts everything. No upload parallelism.

### Option C: tus resumable upload protocol (tusd sidecar)
- Run a `tusd` server (or `@tus/server` in Node) that receives chunked, resumable uploads and stores to S3 backend; API integrates via webhooks.
- **Pros:** Standardized resumable protocol with mature clients (Uppy). Excellent for flaky networks — byte-level resume.
- **Cons:** New infrastructure component (tusd) plus webhook integration — more moving parts than presigned multipart for the same outcome. S3 backend of tusd uses multipart internally anyway. Diverges from the S3-native contract the project already assumes ("Frontend streams from Object Storage").

**Recommendation:** **Option A (S3 Multipart Upload with presigned part URLs)** — It is the S3-native contract for large objects: satisfies 10GB (Option B cannot), gives per-part retry and parallelism, and keeps the API as pure orchestrator (draft pre-registration on initiate, queue publish on complete). Option C adds a server component to obtain properties multipart already provides.

**Decision:** A (S3 Multipart Upload with presigned part URLs)

---

## TD-03: Video Worker Runtime Model

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The architecture diagram defines the Video Worker as a separate container consuming the queue. The decision is how that worker is built and deployed relative to the NestJS codebase: shared codebase with a second entrypoint, or a fully separate project — and how FFmpeg is provisioned.

**Options:**

### Option A: Second NestJS application context in the same codebase, separate container
- The repo gains a worker entrypoint (e.g., `src/worker.ts`) that boots a NestJS application context containing only the processing modules (queue consumer, storage, DB). Compose runs a second service from the same image with a different command; FFmpeg/ffprobe installed in the image.
- **Pros:** Reuses entities, repositories, config validation, and DI — no duplication of the Video model or storage client. One `package.json`, one build, one test suite. Independent scaling and isolation at runtime (API dies ≠ worker dies). NestJS lifecycle hooks manage the BullMQ worker cleanly.
- **Cons:** API-only dependency changes trigger worker image rebuilds too (acceptable at this scale). Worker bundle carries some unused API code.

### Option B: Separate standalone Node.js project for the worker
- A dedicated `video-worker/` project with its own package.json, consuming the queue with plain BullMQ and its own DB/storage clients.
- **Pros:** Minimal runtime footprint; fully independent dependency set.
- **Cons:** Duplicates entity definitions, config schema, and storage code — two sources of truth for the videos table contract. Second test/lint/build toolchain to maintain. Violates "continuidade, não retrabalho" for a single-team monorepo.

### Option C: In-process consumer inside the API
- The API process also registers the BullMQ processor.
- **Pros:** Zero new containers.
- **Cons:** CPU-bound FFmpeg work inside the API event-loop/host starves HTTP traffic — exactly what the phase forbids ("sem travar o sistema"). Contradicts the C4 diagram's dedicated Video Worker container. Rejected.

**Recommendation:** **Option A (same codebase, second Nest application context, separate container)** — Shares the domain model and infra code without duplicating contracts, while keeping runtime isolation and independent scaling. FFmpeg/ffprobe are installed in the shared dev image; the worker runs `nest start --entryFile worker` (or equivalent) as its Compose command.

**Decision:** A (second NestJS app context, separate container, FFmpeg in image)

---

## TD-04: FFmpeg Integration for Metadata & Thumbnail

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration/metadata and capture a frame as thumbnail. FFmpeg/ffprobe are the standard tools; the decision is how Node invokes them.

**Options:**

### Option A: Direct child_process spawn of ffprobe/ffmpeg
- Invoke `ffprobe -print_format json -show_format -show_streams` and `ffmpeg -ss <t> -i <input> -frames:v 1` via `child_process.spawn`, parsing ffprobe's JSON output. Binaries come from the container image (apt).
- **Pros:** Zero npm dependencies — no abstraction over a stable CLI contract. ffprobe's JSON output is a documented, versioned interface. Full control of args, timeouts, and process lifecycle. Trivial to unit-test by wrapping the spawn behind a small service interface.
- **Cons:** Manual argument construction and error mapping (exit codes → domain errors). No fluent API for complex filter graphs (not needed in this phase).

### Option B: fluent-ffmpeg
- Popular fluent wrapper around the ffmpeg CLI (`ffmpeg()` chainable API, `.screenshots()`, `ffprobe()` helper).
- **Pros:** Convenient API for screenshots and probing; large install base and examples.
- **Cons:** Maintenance is sporadic (long-standing issue backlog; the package spent 2023-2024 marked as unmaintained before a maintenance-mode revival). Adds an abstraction layer over two commands this phase uses trivially. Callback-style API wrapped in promises adds noise.

### Option C: WASM FFmpeg (@ffmpeg/ffmpeg)
- Run FFmpeg compiled to WebAssembly inside Node.
- **Pros:** No system binary requirement.
- **Cons:** Significantly slower and memory-bound — unusable for 10GB inputs. Designed for browser use cases. Rejected.

**Recommendation:** **Option A (direct spawn of ffprobe/ffmpeg)** — The phase needs exactly two well-documented CLI invocations; a wrapper library adds dependency risk without reducing real complexity. A thin internal service (`FfmpegService`) encapsulates the spawns and exposes typed results, keeping the rest of the worker testable.

**Decision:** A (direct spawn behind an internal FfmpegService)

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a unique, URL-safe public identifier (YouTube-style watch URL). It must be generated without coordination, collision-resistant, and independent from the internal primary key (which stays `uuid` per project convention).

**Options:**

### Option A: nanoid with custom URL-safe alphabet (11 chars)
- Generate an 11-character ID from alphabet `[A-Za-z0-9_-]` using `nanoid`'s cryptographically secure generator; store in a `unique` column, retry on the (astronomically rare) unique-violation.
- **Pros:** 64^11 ≈ 7.3×10^19 space — collision probability negligible at platform scale, matching YouTube's own format. Short, clean URLs. `nanoid` is tiny, dependency-free, and battle-tested. DB unique constraint gives a hard guarantee; insert-retry handles the theoretical collision.
- **Cons:** One extra dependency. Opaque ID carries no semantics (also a pro for privacy).

### Option B: Reuse the primary-key UUID in the URL
- Expose the row's `uuid` as the public URL identifier.
- **Pros:** Zero extra code or column — uniqueness guaranteed by the PK.
- **Cons:** 36-char URLs hurt readability/shareability. Couples public contract to internal PK (renumbering/migration pain). UUIDv4 leaks nothing but is ugly in a "YouTube-like" product.

### Option C: Slug derived from title + random suffix
- Slugify the title and append a short random suffix to disambiguate.
- **Pros:** Human-readable, SEO-friendly URLs.
- **Cons:** Title is editable in Phase 04 — slug either goes stale or breaks links on rename. Requires collision handling on every title edit. More policy surface (normalization, length, i18n) for marginal value in this phase.

**Recommendation:** **Option A (nanoid, 11 chars, unique column)** — Matches the product's YouTube-like URL format with negligible collision risk, a hard DB uniqueness guarantee, and no coupling between public URLs and internal keys.

**Decision:** A (nanoid 11-char public ID in a unique column)

---

## TD-06: Streaming & Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Players stream via HTTP Range requests (`206 Partial Content`); download needs `Content-Disposition: attachment`. The C4 diagram already states "Frontend streams from Object Storage". The decision is how clients reach the bytes: direct presigned storage URLs brokered by the API, or the API proxying the stream.

**Options:**

### Option A: API issues short-lived presigned GET URLs; storage serves the bytes
- `GET /videos/{publicId}/stream` validates the video state and returns/redirects to a presigned MinIO/S3 GET URL (with `response-content-disposition: attachment` for the download variant). MinIO serves Range/206 natively.
- **Pros:** Byte traffic bypasses the API entirely — same principle that justified TD-02; API stays thin. S3/MinIO implement Range, ETag and 206 semantics natively and efficiently. Matches the C4 diagram ("Frontend streams from Object Storage"). Presign expiry gives simple access control.
- **Cons:** URLs expire — players must refresh on long sessions (mitigated by generous TTL). Storage endpoint must be reachable by clients (in Compose: published MinIO port). Per-object ACL logic lives in the API, not the storage.

### Option B: API proxies the stream with Range forwarding
- `GET /videos/{publicId}/stream` reads from storage (S3 `GetObject` with `Range`) and pipes to the response, translating Range headers and status 206.
- **Pros:** Single origin for clients (no storage exposure). Fine-grained per-request authorization on every byte range.
- **Cons:** Every video byte crosses the API — bandwidth×2 and event-loop pressure under concurrent playback, recreating the problem TD-02 eliminated for uploads. Manual, error-prone Range/206 implementation. Doesn't match the C4 diagram.

### Option C: Public-read bucket
- Make video objects publicly readable; clients hit stable storage URLs.
- **Pros:** Zero presign logic; CDN-friendly.
- **Cons:** No access control at all — anyone with the key reads any video, including drafts/unlisted (Phase 04 requires visibility rules). Rejected as it forecloses known upcoming requirements.

**Recommendation:** **Option A (presigned GET, storage serves bytes)** — Consistent with TD-02's "API orchestrates, storage moves bytes" contract and with the architecture diagram; MinIO's native Range support gives correct 206 streaming for free, and presign TTL provides the access-control hook Phase 04 will refine.

**Decision:** A (presigned GET URLs for streaming and download)

---

## TD-07: Video Status Lifecycle & Failure Policy

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** The video row is created before any byte is uploaded and mutates as the pipeline advances. The status model is the contract between API, worker, and (future) frontend polling; the failure policy defines what happens when FFmpeg or storage fails mid-processing.

**Options:**

### Option A: Single status enum + error detail column, queue-managed retries
- `status ∈ {draft, uploading, processing, ready, failed}` on the videos table, plus `processing_error` (nullable text). Transitions: `draft` (initiate) → `uploading` (parts in flight) → `processing` (upload completed, job enqueued) → `ready` | `failed`. BullMQ retries the job (attempts: 3, exponential backoff) before the terminal `failed` state; the worker writes `processing_error` on final failure. Idempotent worker: reprocessing a `ready` video is a no-op.
- **Pros:** One authoritative column — trivial to query, index, and expose. Retry policy delegated to the queue (already provides attempts/backoff/failed set). Error detail preserved for debugging/UX. Matches the phase's required cycle (rascunho → processando → pronto/erro) with an explicit uploading stage that makes abandoned uploads detectable.
- **Cons:** No historical audit of transitions (only current state). Concurrent transition guards must be enforced in service code (state-machine checks).

### Option B: Status enum + separate video_events audit table
- Same enum, plus an append-only events table recording every transition with timestamps and payloads.
- **Pros:** Full audit trail; enables analytics and debugging of stuck pipelines.
- **Cons:** Extra table, writes, and consistency logic for a capability nobody consumes in this phase. Can be added later without breaking the enum contract.

**Recommendation:** **Option A (status enum + processing_error, retries in the queue)** — Delivers the required lifecycle with the least moving parts; BullMQ's retry/backoff replaces hand-rolled failure machinery, and the audit table can be introduced in a later phase if a real consumer appears.

**Decision:** A (status enum {draft, uploading, processing, ready, failed} + processing_error; BullMQ attempts=3 with exponential backoff)

---

## TD-08: Object Storage Layout & Access Policy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage engine is fixed (S3-compatible; MinIO in Compose, S3 in production). The open questions are bucket/key organization and object visibility — the "how to use it" the phase leaves to the implementer. This layout is cited by upload (TD-02), worker (TD-03) and delivery (TD-06), making it a cross-component contract inside the backend.

**Options:**

### Option A: Single private bucket, key prefixes per video
- One bucket (`streamtube-videos`), keys `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`. Everything private; all reads via presigned URLs (TD-06).
- **Pros:** One bucket to provision/configure in Compose bootstrap. The `{videoId}/` prefix groups all artifacts of a video — delete/inspect is a prefix operation. Uniform access policy (private + presign) — no per-bucket ACL divergence. Extends naturally to future artifacts (`renditions/720p.mp4`).
- **Cons:** Thumbnails (hot, small, cacheable) share the policy of videos — public thumbnail delivery in later phases will need presigns too or a policy change.

### Option B: Two buckets — private videos, public thumbnails
- `streamtube-videos` (private) and `streamtube-thumbnails` (public-read).
- **Pros:** Thumbnails become directly linkable/CDN-cacheable without presign churn.
- **Cons:** Second bucket to bootstrap and configure; two access models to reason about. Public thumbnails of draft/unlisted videos leak content (Phase 04 visibility rules). Premature: no frontend consumes thumbnails yet.

**Recommendation:** **Option A (single private bucket, per-video key prefixes)** — Uniform private-plus-presign policy keeps the security model single-minded and Phase-04-proof; the per-video prefix is the natural aggregation unit. Revisit thumbnail publicity when a real consumer (frontend/CDN) exists.

**Decision:** A (single private bucket `streamtube-videos`, keys `videos/{videoId}/...`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Cross-layer | 10GB Upload Strategy | S3 Multipart with presigned part URLs | A (Presigned multipart, direct to storage) |
| TD-03 | Backend | Video Worker Runtime Model | Same codebase, second Nest app context | A (Second app context, separate container) |
| TD-04 | Backend | FFmpeg Integration | Direct spawn of ffprobe/ffmpeg | A (Direct spawn via FfmpegService) |
| TD-05 | Backend | Unique Video URL Identifier | nanoid 11-char | A (nanoid 11-char unique column) |
| TD-06 | Cross-layer | Streaming & Download Delivery | Presigned GET, storage serves bytes | A (Presigned GET URLs) |
| TD-07 | Backend | Video Status Lifecycle & Failure Policy | Status enum + queue retries | A (enum + processing_error; attempts=3) |
| TD-08 | Backend | Object Storage Layout & Access Policy | Single private bucket, per-video prefixes | A (single bucket, `videos/{id}/...`) |
