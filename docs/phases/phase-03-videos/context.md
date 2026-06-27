---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-27T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-27T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T12:23:19-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails) via MinIO (S3-compatible)
- Serviço de processamento em segundo plano via BullMQ + Redis
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance (presigned PUT URL)
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload: extração de duração e metadados via ffprobe
- Geração automática de thumbnail a partir de um frame do vídeo via FFmpeg
- URL única por vídeo via NanoID (11 chars), sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo) via presigned GET URL + 302 redirect
- Download do vídeo pelo usuário via presigned GET URL com Content-Disposition: attachment

**Out of scope:** Edição de metadados de vídeo (título, descrição, categoria), visibilidade pública/unlisted, comentários, likes, frontend de vídeo.

**Deliverables:** Upload de até 10GB funcional via presigned URL; processamento automático (FFmpeg/ffprobe); thumbnail gerada automaticamente; streaming e download via redirect a MinIO; URLs únicas por vídeo.

**Affected subprojects:** `nestjs-project/` — new module `videos/`, new shared modules `storage/` and `queue/`, new `worker/` service, updated `compose.yaml`.

**Sequencing notes:** Depends on Fase 01 (config, migrations, Docker) and Fase 02 (channels entity — videos belong to a channel).

**Neighbors (for boundary detection only):** Fase 02 (prior — channels, users, auth), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend + Infra | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.x, bullmq@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend + Client | Upload Strategy for 10GB Files | decided | B (Presigned PUT URL) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend + Infra | Video Worker Architecture | decided | B (Separate Worker Docker Service) | fluent-ffmpeg@^2.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | B (NanoID, 11 chars) | nanoid@^5.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend + Infra | Streaming Strategy | decided | A (Presigned GET URL + 302 Redirect) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (draft → processing → ready \| error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho | phase-03-videos/TD-06 |
| Processamento automático: extração de duração e metadados | phase-03-videos/TD-03 |
| Geração automática de thumbnail | phase-03-videos/TD-03 |
| URL única por vídeo | phase-03-videos/TD-04 |
| Reprodução via streaming | phase-03-videos/TD-05 |
| Download do vídeo | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — First-class NestJS integration via `@nestjs/bullmq`, built-in retry with exponential backoff, atomic Redis operations for job durability. Redis is lightweight in Docker Compose. RabbitMQ is overkill for one queue; PostgreSQL polling has correctness edge cases.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Presigned PUT URL — Client uploads directly to MinIO, API is never in the upload data path. Time-limited presigned URL scoped to one object key. Standard S3-compatible pattern. API triggers processing separately after upload completes. Multipart presigned upload (Option C) is Phase 04+ complexity.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Separate Worker Docker Service — CPU-intensive FFmpeg work must not compete with the API event loop. Worker runs in its own container with FFmpeg installed. Shares `.env`, connects to same Redis and PostgreSQL. Entry point: `nestjs-project/worker/`.

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

### phase-03-videos/TD-04

**Recommendation:** NanoID at 11 characters — Short (11 chars), URL-safe, ~4.4×10¹⁹ possible values. Effectively collision-free at video-platform scale. DB unique constraint on `slug` handles the theoretical collision. Extra dependency is minimal.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-05

**Recommendation:** Presigned GET URL + 302 Redirect — API generates a presigned MinIO URL with TTL, returns 302. Client follows redirect to MinIO, which natively handles `Range` headers (206 Partial Content) for streaming. Same mechanism for download with `ResponseContentDisposition: attachment`. API is never in the video data path.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** draft → processing → ready | error — Four states covering the lifecycle: draft (upload URL issued, upload pending/in-progress), processing (job enqueued, FFmpeg running), ready (processing successful), error (FFmpeg failed). Simple, covers all Phase 03 requirements.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended for new projects. Already in use.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only. JWT guard is global APP_GUARD; `@Public()` decorator exempts open endpoints.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — `{ statusCode, error, message }` shape. Domain error codes are explicit and typed.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config with `registerAs()` factories — one file per domain in `src/config/`.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared `registerAs` factory for TypeORM data source.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables validated by Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Global JWT guard (`JwtAuthGuard` as `APP_GUARD`); `@Public()` decorator exempts open endpoints. _(from phase 02)_
- Domain exceptions extend `DomainException`; filter returns `{ statusCode, error, message }`. _(from phase 02)_
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. _(from phase 02)_
- Migration generated via `npm run migration:generate`, never hand-written. _(from phase 01)_
- Docker Compose service names used as hostnames — never `localhost`. _(from CLAUDE.md)_
- Test types: `*.spec.ts` (unit), `*.integration-spec.ts` (integration with real DB), `*.e2e-spec.ts` (E2E via supertest in `test/`). _(from phase 02)_
- Integration and E2E tests run with `--runInBand` to avoid FK violations. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities from Phase 02._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Edição de metadados do vídeo (título, descrição, categoria, thumbnail customizada) | deferred | Phase 04 scope. | — |
| Visibilidade do vídeo (público/unlisted) | deferred | Phase 04 scope. | — |
| Frontend de player de vídeo | deferred | Phase 05 scope. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` skill for layer requirements. Phase 03 introduces: StorageModule (unit + integration), QueueModule (unit), VideosModule (unit + integration + e2e), Video entity (integration), Worker (unit with mocked FFmpeg + integration). Each SI must have its test suite green before advancing.
