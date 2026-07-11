# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Infrastructure Services
- **Status:** completed
- **Tests:** no tests — app boots with new env vars; baseline app e2e passing; ffprobe available in the container
- **Observations:** Ports 9000/3000/5432 collide with other services on this host (Portainer/AdGuard/postgres antigo) — resolved locally via untracked compose.override.yaml; committed compose keeps canonical ports. STORAGE_PUBLIC_ENDPOINT defaults to http://minio:9000 so presigned URLs are valid for in-network clients (tests); browser clients on the host use http://localhost:9000.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 9/9 passing (video.entity.integration-spec: 6, migrations.integration-spec: 2, videos.module.spec: 1)
- **Observations:** migrations.integration-spec now drops enum types in beforeAll (DROP TYPE IF EXISTS) — DROP TABLE does not remove enums, which made the suite single-run-only on databases where migrations had already executed. size_bytes is bigint → string in TypeORM.

### SI-03.3 — Storage Module (S3 Client, Presigning, Bucket Bootstrap)
- **Status:** completed
- **Tests:** 10/10 passing (storage.service.spec: 4 unit, storage.service.integration-spec: 6 against real MinIO — multipart round-trip, Range/206, attachment disposition, abort)
- **Observations:** Dual S3Client (internal para dados, público para presign) porque a assinatura cobre o header Host. forcePathStyle obrigatório no MinIO.

### SI-03.4 — Upload Orchestration Endpoints (Initiate, Part URLs, Complete, Abort)
- **Status:** completed
- **Tests:** 16/16 passing (public-id.util.spec: 2, videos.service.spec: 11, videos.service.integration-spec: 3 com DB+MinIO+Redis reais)
- **Observations:** Exceções de domínio adicionadas em common/exceptions (padrão do projeto). Retry único de public_id em violação 23505.

### SI-03.5 — Processing Queue (BullMQ Root Config and Producer)
- **Status:** completed
- **Tests:** 2/2 passing (queue.module.integration-spec com Redis real — job publicado com attempts/backoff e dedup por jobId)
- **Observations:** jobId = videoId deduplica double-completion. QueueModule exporta o BullModule root para reuso no worker.

### SI-03.6 — Video Worker (Processor, FFmpeg Service, Worker Entrypoint and Container)
- **Status:** completed
- **Tests:** 10/10 passing (video.processor.spec: 5 unit, ffmpeg.service.integration-spec: 3 com binários reais e clipe sintético lavfi, video.processor.integration-spec: 2 end-to-end DB+MinIO+FFmpeg)
- **Observations:** O forFeature do worker precisa registrar Video+Channel+User (metadata das relações). Falha terminal via @OnWorkerEvent(failed) apenas quando attemptsMade >= attempts.

### SI-03.7 — Playback and Delivery Endpoints (Metadata, Streaming, Download)
- **Status:** completed
- **Tests:** 5 unit novos em videos.service.spec + test/videos.e2e-spec 7/7 — pipeline completo com o worker REAL do compose processando, stream 302→206 com Range, download com attachment
- **Observations:** O e2e usa o container video-worker real consumindo a fila (nada mockado abaixo do HTTP). cleanAllTables ganhou DELETE de videos com guarda to_regclass; drops do migrations spec serializados (deadlock no grafo de FK).

### SI-03.8 — AI Documentation Update (CLAUDE.md Root and Backend)
- **Status:** completed
- **Tests:** no tests — docs verificadas contra o código (endpoints, paths, comandos e serviços citados existem)
- **Observations:** Fila deixou de ser TBD no C4 (Redis+BullMQ). Seção "Videos Module (Phase 03)" documenta handshake, delivery, lifecycle, contrato da fila e layout do storage. Definition of Done final em banco zerado: 192/192 unit+integration, 59/59 e2e, tsc 0, lint 0 erros, build ok.
