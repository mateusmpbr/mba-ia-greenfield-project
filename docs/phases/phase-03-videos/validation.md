# phase-03-videos — Validation

**Status:** clean

**Date:** 2026-06-27

---

## Checklist

### Decisions Coverage

- [x] All capabilities in scope have at least one TD covering them
- [x] The open decision (queue technology) is closed: TD-01 → BullMQ + Redis
- [x] Upload strategy is decided: TD-02 → Presigned PUT URL
- [x] Worker architecture is decided: TD-03 → Separate Docker Service
- [x] URL uniqueness is decided: TD-04 → NanoID (11 chars)
- [x] Streaming strategy is decided: TD-05 → Presigned GET URL + 302
- [x] Status lifecycle is decided: TD-06 → draft → processing → ready | error

### Dependency Gaps

- [x] Phase 02 `Channel` entity exists — videos reference `channel_id` (FK)
- [x] Phase 01 migration infrastructure (`data-source.ts`, TypeORM CLI) in place
- [x] Phase 01 config pattern (`registerAs`) available for new storage/queue/redis config namespaces
- [x] Phase 02 global JWT guard in place — video endpoints that require auth inherit it automatically
- [x] Phase 02 `DomainException` pattern in place — new video domain exceptions extend it
- [x] Docker Compose service name convention confirmed (`db`, `redis`, `minio`, `video-worker`)

### Context Completeness

- [x] All 6 TDs in context.md decisions index, all with status `decided`
- [x] Inherited conventions from phases 01 and 02 listed
- [x] Deferred capabilities table present
- [x] Library versions pinned in decisions (prefixed with `^` for minor-compatible)
- [x] Worker entry point location decided: `nestjs-project/worker/`

### Potential Risks (noted, not blocking)

- MinIO presigned URL TTL (2h for upload, 1h for streaming) must be set in config — not hard-coded
- NanoID v5 uses ESM-only export; NestJS/ts-jest uses CommonJS — must use dynamic `import()` or wrap in a factory function
- Worker container needs FFmpeg binary installed — base image must include it (`node:22-bookworm` + `apt-get install ffmpeg`)
- BullMQ worker in the separate service must share the same `.env` as the API for DB and Redis credentials

---

**Verdict:** clean — proceed to plan-build.
