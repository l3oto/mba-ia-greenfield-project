---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-10T19:12:37-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-10T19:45:35-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-10T19:13:56-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-07-10T19:13:56-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-10T19:13:56-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de metadados do vídeo, categorias, visibilidade, publicação e painel do canal (Fase 04); página de visualização, comments/likes (Fase 05+); toda a interface de vídeo no frontend (o desafio é backend-only nesta fase).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de upload/reprodução consome os contratos definidos aqui (TD-02, TD-06) em uma fase futura.

**Sequencing notes:** Depends on Fase 01 — Configuração Base and Fase 02 — Cadastro, Login e Gerenciamento de Conta (vídeos pertencem ao canal criado no cadastro; endpoints protegidos pelo guard JWT global).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq@^5.x, @nestjs/bullmq@^11.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | 10GB Upload Strategy | decided | A (S3 Multipart, presigned part URLs) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Model | decided | A (second Nest app context, separate container) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Integration | decided | A (direct spawn via FfmpegService) | — (ffmpeg/ffprobe via image) |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (nanoid 11-char unique column) | nanoid@^3.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming & Download Delivery | decided | A (presigned GET URLs) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle & Failure Policy | decided | A (status enum + processing_error; attempts=3) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout & Access Policy | decided | A (single private bucket, `videos/{id}/...`) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08, phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-08 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — The consumer is a single Node.js video worker, which is exactly BullMQ's design center: job queue with retries/backoff out of the box and an official NestJS module, keeping producer and worker code idiomatic. Redis is a small, disposable Compose service — cheaper to operate than RabbitMQ and isolated from the application database, unlike pg-boss.

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (S3 Multipart Upload with presigned part URLs) — It is the S3-native contract for large objects: satisfies 10GB (single PUT caps at 5GB), gives per-part retry and parallelism, and keeps the API as pure orchestrator (draft pre-registration on initiate, queue publish on complete).

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A (same codebase, second Nest application context, separate container) — Shares the domain model and infra code without duplicating contracts, while keeping runtime isolation and independent scaling. FFmpeg/ffprobe are installed in the shared dev image; the worker runs a dedicated entrypoint as its Compose command.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Option A (direct spawn of ffprobe/ffmpeg) — The phase needs exactly two well-documented CLI invocations; a wrapper library adds dependency risk without reducing real complexity. A thin internal `FfmpegService` encapsulates the spawns and exposes typed results.

**Libraries:** — (ffmpeg/ffprobe installed in the container image)

### phase-03-videos/TD-05

**Recommendation:** Option A (nanoid, 11 chars, unique column) — Matches the product's YouTube-like URL format with negligible collision risk, a hard DB uniqueness guarantee, and no coupling between public URLs and internal keys.

**Note:** `nanoid@^3.x` (not v5) — the backend compiles to CommonJS (`module: nodenext`, no `"type": "module"`); nanoid v5 is ESM-only.

**Libraries:** `nanoid@^3.x`

### phase-03-videos/TD-06

**Recommendation:** Option A (presigned GET, storage serves bytes) — Consistent with TD-02's "API orchestrates, storage moves bytes" contract and with the C4 diagram ("Frontend streams from Object Storage"); MinIO's native Range support gives correct 206 streaming for free, and presign TTL provides the access-control hook Phase 04 will refine.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-07

**Recommendation:** Option A (status enum + processing_error, retries in the queue) — Delivers the required lifecycle (`draft → uploading → processing → ready | failed`) with the least moving parts; BullMQ's retry/backoff (attempts=3, exponential) replaces hand-rolled failure machinery.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option A (single private bucket, per-video key prefixes) — Uniform private-plus-presign policy keeps the security model single-minded and Phase-04-proof; keys `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02 (Auth Library Approach)

Custom guards with `@nestjs/jwt` — the global `JwtAuthGuard` protects all routes by default; public routes opt out via the `@Public()` decorator. Video endpoints inherit this: upload/management endpoints are authenticated, playback endpoints are public per the product rule "anonymous users can watch freely".

### phase-02-auth/TD-06 (Request Validation Library)

class-validator + class-transformer via global `ValidationPipe` — video DTOs follow the same decorator-based validation.

### phase-02-auth/TD-07 (Error Response Standardization)

Custom Domain Exception Filter with `{ statusCode, error, message }` and machine-readable domain codes — video domain errors (e.g., `VIDEO_NOT_FOUND`, `VIDEO_NOT_READY`, `UPLOAD_ALREADY_COMPLETED`) extend `DomainException` and reuse the filter.

### phase-01-configuracao-base/TD-01..TD-04 (Config foundation)

`@nestjs/config` with namespaced `registerAs` factories + Joi env validation — storage/queue configuration (MinIO endpoint, credentials, bucket, Redis host/port) enters via new `storage.config.ts` and `queue.config.ts` factories added to the Joi schema.

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts` (`allowUnknown: true, abortEarly: false`). _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema evolves via versioned migrations in `src/database/migrations/`. _(from phase 01)_
- Global `JwtAuthGuard` (`APP_GUARD`) + `@Public()` decorator for opt-out routes. _(from phase 02)_
- Domain errors extend `DomainException` and are mapped by the global domain-exception filter to `{ statusCode, error, message }`. _(from phase 02)_
- DTO validation via global `ValidationPipe` (whitelist) with class-validator decorators. _(from phase 02)_
- Rate limiting via `@nestjs/throttler` scoped where needed. _(from phase 02)_
- Docker networking: services address each other by Compose service name (`db`, `redis`, `minio`), never `localhost`. _(repo-wide)_
- Tests: `*.spec.ts` unit (mocked, no I/O), `*.integration-spec.ts` integration (real DB/services, `--runInBand`), `*.e2e-spec.ts` e2e via supertest in `test/`. _(repo-wide)_
- Full suites run with `--runInBand` — integration/e2e share a single test database. _(from nestjs-project/CLAUDE.md)_

## Inherited Deferred Capabilities

- Telas de cadastro, login, confirmação de conta e recuperação de senha _(deferred by phase 02 — `next-frontend/` UI work resumes in a later phase; unchanged by this phase)_

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload e reprodução de vídeo | deferred | Backend-only phase; the frontend consumes TD-02/TD-06 contracts in a future phase. | phase-03-videos/TD-02, phase-03-videos/TD-06 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces: a new entity + migration (integration-tested against the real database), a queue producer/consumer pair (integration-tested against real Redis), a storage service (integration-tested against real MinIO), an FFmpeg service (integration-tested against real binaries with a small generated fixture), and public/authenticated HTTP endpoints (e2e via supertest). Real infrastructure from Compose is used — queue, storage and FFmpeg are exercised without mocks at the integration/e2e levels; unit tests mock collaborators as usual. Specific layer coverage by SI is recorded in `progress.md`.
