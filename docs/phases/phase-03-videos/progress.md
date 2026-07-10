# phase-03-videos — Progress

**Status:** in-progress
**SIs:** 2/8 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Infrastructure Services
- **Status:** completed
- **Tests:** no tests — app boots with new env vars; baseline app e2e passing; ffprobe available in the container
- **Observations:** Ports 9000/3000/5432 collide with other services on this host (Portainer/AdGuard/postgres antigo) — resolved locally via untracked compose.override.yaml; committed compose keeps canonical ports. STORAGE_PUBLIC_ENDPOINT defaults to http://minio:9000 so presigned URLs are valid for in-network clients (tests); browser clients on the host use http://localhost:9000.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 9/9 passing (video.entity.integration-spec: 6, migrations.integration-spec: 2, videos.module.spec: 1)
- **Observations:** migrations.integration-spec now drops enum types in beforeAll (DROP TYPE IF EXISTS) — DROP TABLE does not remove enums, which made the suite single-run-only on databases where migrations had already executed. size_bytes is bigint → string in TypeORM.

### SI-03.3 — Storage Module (S3 Client, Presigning, Bucket Bootstrap)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.4 — Upload Orchestration Endpoints (Initiate, Part URLs, Complete, Abort)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.5 — Processing Queue (BullMQ Root Config and Producer)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.6 — Video Worker (Processor, FFmpeg Service, Worker Entrypoint and Container)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.7 — Playback and Delivery Endpoints (Metadata, Streaming, Download)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — AI Documentation Update (CLAUDE.md Root and Backend)
- **Status:** pending
- **Tests:** —
- **Observations:** —
