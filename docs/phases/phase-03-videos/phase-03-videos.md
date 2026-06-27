---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-27T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-27T00:00:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the full video upload and processing pipeline: presigned URL upload (up to 10GB without blocking the API), automatic FFmpeg processing in a separate worker, thumbnail generation, unique slug URLs, streaming and download via MinIO redirect — with all infrastructure (MinIO, Redis, worker) running via Docker Compose.

---

## Technical Specifications

### Data Model

**Table: `videos`**

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, generated | Internal ID |
| `slug` | varchar(11) | UNIQUE, NOT NULL | NanoID public identifier |
| `title` | varchar(200) | NOT NULL | Video title (set at upload initiation) |
| `status` | enum | NOT NULL, default 'draft' | draft \| processing \| ready \| error |
| `storage_key` | varchar(500) | nullable | MinIO object key for the video file |
| `thumbnail_key` | varchar(500) | nullable | MinIO object key for the thumbnail |
| `duration_seconds` | integer | nullable | Duration in seconds (set after processing) |
| `metadata` | jsonb | nullable | Raw ffprobe metadata (codec, resolution, etc.) |
| `error_message` | varchar(1000) | nullable | Last processing error message |
| `channel_id` | uuid | FK → channels.id, NOT NULL | Owning channel |
| `created_at` | timestamptz | auto | |
| `updated_at` | timestamptz | auto | |

**Status enum:** `draft`, `processing`, `ready`, `error`

**Relationships:**
- `videos.channel_id` → `channels.id` (ManyToOne: one channel has many videos)
- `channels` entity gains `@OneToMany(() => Video, v => v.channel) videos: Video[]`

### API Contracts

#### POST /videos
- **Auth:** Required (JWT)
- **Body:** `{ title: string }` (1–200 chars)
- **Response 201:**
  ```json
  {
    "id": "uuid",
    "slug": "abc12345678",
    "title": "My Video",
    "status": "draft",
    "uploadUrl": "https://minio:9000/videos/...",
    "storageKey": "videos/channel-id/slug.mp4"
  }
  ```
- **Errors:** 401 (unauthenticated), 400 (validation)

#### POST /videos/:id/trigger-processing
- **Auth:** Required (JWT, must be video owner)
- **Body:** none
- **Response 200:** `{ id, slug, status: "processing" }`
- **Errors:** 401, 403 (not owner), 404 (not found), 409 (status not draft — `VIDEO_NOT_IN_DRAFT`)
- **Side effect:** Verifies object exists in MinIO, enqueues BullMQ job, updates status → processing

#### GET /videos/:slug
- **Auth:** Public
- **Response 200:** `{ id, slug, title, status, durationSeconds, channelId, createdAt }`
- **Errors:** 404 (not found)

#### GET /videos/:slug/stream
- **Auth:** Public (presigned URL is time-limited)
- **Response:** 302 redirect to MinIO presigned GET URL (1h TTL)
- **Errors:** 404, 422 (status not ready — `VIDEO_NOT_READY`)

#### GET /videos/:slug/download
- **Auth:** Public (presigned URL is time-limited)
- **Response:** 302 redirect to MinIO presigned GET URL with `ResponseContentDisposition: attachment` (1h TTL)
- **Errors:** 404, 422 (status not ready — `VIDEO_NOT_READY`)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | — | ✓ | ✓ |
| POST /videos/:id/trigger-processing | — | — | ✓ |
| GET /videos/:slug | ✓ | ✓ | ✓ |
| GET /videos/:slug/stream | ✓ | ✓ | ✓ |
| GET /videos/:slug/download | ✓ | ✓ | ✓ |

### Error Catalog

| Error Code | HTTP | Thrown when |
|------------|------|-------------|
| `VIDEO_NOT_FOUND` | 404 | Video with given id/slug does not exist |
| `VIDEO_NOT_IN_DRAFT` | 409 | trigger-processing called when status ≠ draft |
| `VIDEO_NOT_READY` | 422 | stream/download called when status ≠ ready |
| `VIDEO_FORBIDDEN` | 403 | trigger-processing called by non-owner |
| `STORAGE_OBJECT_NOT_FOUND` | 422 | trigger-processing called but no object in MinIO for storageKey |

### Events / Messages

**Queue name:** `video-processing`

**Job: `process-video`**

Payload:
```typescript
interface VideoProcessingJobData {
  videoId: string;    // UUID — internal video ID
  storageKey: string; // MinIO object key for the video file
  slug: string;       // for thumbnail key naming
}
```

Published by: `VideosService.triggerProcessing()` via `@InjectQueue('video-processing')`

Consumed by: `VideoWorkerProcessor` in the `worker/` service

Job options:
- `attempts: 3` — retry up to 3 times on failure
- `backoff: { type: 'exponential', delay: 5000 }` — 5s, 10s, 20s
- `removeOnComplete: true`
- `removeOnFail: false` — keep failed jobs for inspection

**Worker lifecycle:**
1. `active` → downloads video from MinIO to `/tmp/video-<id>`
2. Runs `ffprobe` → extracts `{ durationSeconds, width, height, codec, bitrate }`
3. Runs `ffmpeg` → extracts thumbnail at 10% of duration → `/tmp/thumb-<id>.jpg`
4. Uploads thumbnail to MinIO as `thumbnails/<slug>.jpg`
5. Updates video in DB: `status=ready`, `durationSeconds`, `metadata`, `thumbnailKey`
6. Cleans up temp files
7. `completed` → job done

**On failure (after all attempts):**
- Updates video in DB: `status=error`, `errorMessage=<last error message>`

---

## Step Implementations

### SI-03.1 — Infrastructure: MinIO, Redis, Docker Compose, and Config Namespaces

**Description:** Add MinIO (object storage) and Redis (queue broker) services to `compose.yaml`. Add the `video-worker` service placeholder (pointing to worker Dockerfile). Create storage and Redis config namespaces following the `registerAs` pattern. Extend the Joi env validation schema with new variables.

**Technical actions:**

- Add to `nestjs-project/compose.yaml`:
  - `minio` service: image `minio/minio:RELEASE.2025-01-20T22-04-24Z`, ports `9000:9000` (API) + `9001:9001` (console), command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, healthcheck
  - `redis` service: image `redis:7-alpine`, port `6379:6379`, healthcheck
  - `video-worker` service: build from `./worker/Dockerfile.dev`, `depends_on: [db, redis, minio]`, same `.env` volume
  - Update `nestjs-api` `depends_on` to include `minio` and `redis`
- Create `nestjs-project/src/config/storage.config.ts` — `registerAs('storage', ...)` reading: `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET` (default `videos`), `STORAGE_UPLOAD_URL_TTL_SECONDS` (number, default `7200`), `STORAGE_ACCESS_URL_TTL_SECONDS` (number, default `3600`)
- Create `nestjs-project/src/config/redis.config.ts` — `registerAs('redis', ...)` reading: `REDIS_HOST` (default `redis`), `REDIS_PORT` (number, default `6379`)
- Update `nestjs-project/src/config/env.validation.ts` — add all new env variables to Joi schema
- Update `.env.example` with new variables and Docker-compatible defaults
- Create `nestjs-project/worker/Dockerfile.dev` — FROM `node:22-bookworm`, install `ffmpeg` via `apt-get`, working dir `/home/node/app`, CMD `npx ts-node -r tsconfig-paths/register worker/src/main.ts`

**Tests:** None (infrastructure only)

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts all services without error
- MinIO console reachable at `localhost:9001`
- Redis responds to PING: `docker compose exec redis redis-cli ping` → `PONG`
- `nestjs-api` starts without env validation errors when all new vars are set

---

### SI-03.2 — StorageModule

**Description:** Create a `StorageModule` that wraps the AWS SDK v3 S3Client configured for MinIO. Expose a `StorageService` with: generate presigned upload URL, generate presigned access URL, check object existence.

**Technical actions:**

- Install: `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`
- Create `src/storage/storage.module.ts` — `@Module` importing `ConfigModule`, provides `StorageService`, exports `StorageService`
- Create `src/storage/storage.service.ts`:
  - Constructor injects `storageConfig` via `@Inject(storageConfig.KEY)`, creates `S3Client` with `{ endpoint, credentials, region: 'us-east-1', forcePathStyle: true }`
  - `generateUploadUrl(key: string): Promise<string>` — `getSignedUrl(s3, new PutObjectCommand({ Bucket, Key }), { expiresIn: UPLOAD_TTL })`
  - `generateAccessUrl(key: string, filename?: string): Promise<string>` — `getSignedUrl(s3, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition }), { expiresIn: ACCESS_TTL })`
  - `objectExists(key: string): Promise<boolean>` — `HeadObjectCommand`, returns true/false (catches NoSuchKey)
- Register `StorageModule` in `AppModule` imports

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | `generateUploadUrl` / `generateAccessUrl` / `objectExists` with mocked `S3Client` |
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: generate presigned URL, upload via HTTP PUT, verify object exists |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Unit tests pass with mocked S3Client
- Integration test: generate presigned PUT URL → upload a small file → `objectExists` returns true

---

### SI-03.3 — QueueModule

**Description:** Create a `QueueModule` that registers the BullMQ `video-processing` queue and exports it for use by `VideosModule`.

**Technical actions:**

- Install: `@nestjs/bullmq@^11.x`, `bullmq@^5.x`
- Create `src/queue/queue.constants.ts` — `export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const`
- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` injecting `redisConfig`, configures connection `{ host, port }`; `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`. Exports `BullModule` so `VideosModule` can inject the queue.
- Register `QueueModule` in `AppModule` imports

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles, BullModule.forRootAsync wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `QueueModule` compiles without errors
- API starts without BullMQ connection errors when Redis is up

---

### SI-03.4 — Video Entity, Status Enum, and Migration

**Description:** Create the `Video` entity with all columns as per the Data Model. Add the `@OneToMany` side to `Channel`. Generate the migration.

**Technical actions:**

- Install: `nanoid@^5.x`
- Create `src/videos/entities/video-status.enum.ts` — `enum VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', ERROR = 'error' }`
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with all columns per Data Model. `@ManyToOne(() => Channel, (c) => c.videos) @JoinColumn({ name: 'channel_id' }) channel: Channel`
- Update `src/channels/entities/channel.entity.ts` — add `@OneToMany(() => Video, (v) => v.channel) videos: Video[]`
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` in imports; exports `TypeOrmModule`
- Register `VideosModule` in `AppModule`
- Run `npm run migration:generate -- src/database/migrations/CreateVideos` inside the container
- Review migration SQL for correct columns, FK, indexes, enum type

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique slug constraint, status defaults to 'draft', FK to channel, nullable columns |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- Migration creates `videos` table with all columns and enum type
- Duplicate `slug` violates unique constraint
- `status` defaults to `draft`
- Inserting a video with a non-existent `channel_id` fails with FK violation

---

### SI-03.5 — VideosService: Upload Initiation and Video Queries

**Description:** Implement `POST /videos` (create draft + return presigned URL) and `GET /videos/:slug` (fetch video info). Wire `VideosController` and `VideosService` with the required dependencies.

**Technical actions:**

- Install: `nanoid@^5.x` (already from SI-03.4)
- Create `src/videos/dto/create-video.dto.ts` — `{ title: string }` with `@IsString()`, `@MinLength(1)`, `@MaxLength(200)`
- Create `src/videos/dto/video-response.dto.ts` — maps entity to public response shape (excludes `storage_key`, `thumbnail_key`, `error_message`; includes `durationSeconds`, `channelId`)
- Create `src/videos/videos.service.ts`:
  - `createDraft(channelId: string, title: string): Promise<{ video: Video; uploadUrl: string; storageKey: string }>` — generates slug via `nanoid(11)`, generates `storageKey = videos/<channelId>/<slug>`, inserts draft video, calls `StorageService.generateUploadUrl(storageKey)`, returns all three
  - `findBySlug(slug: string): Promise<Video>` — throws `VideoNotFoundException` if not found
  - `findById(id: string): Promise<Video>` — throws `VideoNotFoundException` if not found
- Create `src/videos/videos.controller.ts`:
  - `POST /videos` — `@UseGuards(JwtAuthGuard)` (or relies on global guard), calls service, returns 201 with presigned URL
  - `GET /videos/:slug` — `@Public()`, returns 200 with video info
- Create domain exceptions in `src/common/exceptions/`: `VideoNotFoundException`, `VideoNotInDraftException`, `VideoNotReadyException`, `VideoForbiddenException`, `StorageObjectNotFoundException`
- Update `src/videos/videos.module.ts` — import `StorageModule`, `QueueModule`, `ChannelsModule` (for channel repository access)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `createDraft` creates record + calls StorageService; `findBySlug` throws on not found |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB: create draft video, find by slug, unique slug collision retry |
| `test/videos.e2e-spec.ts` | E2E | POST /videos (201, 401); GET /videos/:slug (200, 404) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` returns 201 with `{ id, slug, title, status: 'draft', uploadUrl, storageKey }`
- `POST /videos` returns 401 without JWT
- `GET /videos/:slug` returns 200 with video details (no uploadUrl, no storageKey)
- `GET /videos/:slug` returns 404 for unknown slug

---

### SI-03.6 — VideosService: Processing Trigger, Streaming, and Download

**Description:** Implement `POST /videos/:id/trigger-processing`, `GET /videos/:slug/stream`, and `GET /videos/:slug/download`. These complete the video lifecycle from "uploaded" to "streamable".

**Technical actions:**

- Add to `VideosService`:
  - `triggerProcessing(videoId: string, requestingChannelId: string): Promise<Video>` — loads video, checks `channel_id === requestingChannelId` (throws `VideoForbiddenException`), checks `status === draft` (throws `VideoNotInDraftException`), checks MinIO object exists (throws `StorageObjectNotFoundException`), sets `status = processing`, saves, enqueues BullMQ job `{ videoId, storageKey, slug }`
  - `getStreamUrl(slug: string): Promise<string>` — loads video by slug, checks `status === ready` (throws `VideoNotReadyException`), calls `StorageService.generateAccessUrl(storageKey)`
  - `getDownloadUrl(slug: string): Promise<string>` — same as getStreamUrl but with `filename` param → `ResponseContentDisposition: attachment; filename="<title>.mp4"`
- Add to `VideosController`:
  - `POST /videos/:id/trigger-processing` — requires JWT (via global guard), injects current user's channelId, calls service, returns 200
  - `GET /videos/:slug/stream` — `@Public()`, calls service, returns 302 redirect
  - `GET /videos/:slug/download` — `@Public()`, calls service, returns 302 redirect
- Create `src/videos/decorators/current-channel.decorator.ts` — extracts `channelId` from `req.user.channelId` (set by JWT guard) or loads channel from DB for the authenticated user

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `triggerProcessing` ownership check, status check, object existence check, enqueue call; `getStreamUrl` / `getDownloadUrl` status check |
| `src/videos/videos.service.integration-spec.ts` | Integration | `triggerProcessing` with real DB: status transitions draft→processing, FK check |
| `test/videos.e2e-spec.ts` | E2E | POST trigger (200, 401, 403, 409); GET stream (302, 404, 422); GET download (302, 422) |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/trigger-processing` returns 200 and sets status to `processing`
- Returns 403 when called by a different user's channel
- Returns 409 when video is not in `draft` status
- Returns 422 when MinIO object does not exist for the storage key
- `GET /videos/:slug/stream` returns 302 redirect to MinIO presigned URL
- `GET /videos/:slug/download` returns 302 with Content-Disposition: attachment

---

### SI-03.7 — Video Worker Service

**Description:** Create the standalone Node.js worker in `nestjs-project/worker/`. It connects to BullMQ, processes video jobs via FFmpeg, updates the database, and uploads thumbnails to MinIO.

**Technical actions:**

- Create `nestjs-project/worker/` directory with:
  - `worker/Dockerfile.dev` — `FROM node:22-bookworm`, `RUN apt-get update && apt-get install -y ffmpeg`, working dir shared with main app, CMD `npx ts-node -r tsconfig-paths/register worker/src/main.ts`
  - `worker/src/main.ts` — entry point: creates `Worker` from `bullmq`, imports processor function
  - `worker/src/processor.ts` — main job processor:
    1. Downloads video from MinIO to `/tmp/video-<jobId>`
    2. Runs `ffprobe` via `fluent-ffmpeg.ffprobe()` → extracts `{ durationSeconds, format, streams }`
    3. Runs `ffmpeg` via `fluent-ffmpeg` → extracts thumbnail at `Math.floor(duration * 0.1)` seconds → `/tmp/thumb-<jobId>.jpg`
    4. Uploads thumbnail to MinIO as `thumbnails/<slug>.jpg`
    5. Updates video in DB via TypeORM: `status=ready, duration_seconds, metadata (jsonb), thumbnail_key`
    6. Cleans up temp files
  - `worker/src/db.ts` — creates TypeORM DataSource for the worker (reuses `src/database/data-source.ts` pattern)
  - `worker/src/storage.ts` — creates S3Client for MinIO (reuses storageConfig pattern)
- Install dev dependencies: `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`
- **On job failure (after all retries):** worker's `failed` event handler updates `video.status = error`, `video.error_message = error.message`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `worker/src/processor.spec.ts` | Unit | `processVideo` with mocked ffprobe, ffmpeg, MinIO client, TypeORM — correct sequence, DB update on success, DB update on failure |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- Worker starts and connects to BullMQ without errors (when Redis is up)
- End-to-end: upload a test video → trigger processing → worker processes → `status=ready` in DB, thumbnail exists in MinIO
- Failed job (bad file) → `status=error`, `error_message` set in DB

---

### SI-03.8 — Tests Completion and Definition of Done

**Description:** Run the full test suite, fix any failures, run `tsc --noEmit`, run lint, and verify all Definition of Done criteria.

**Technical actions:**

- Run `npm test -- --runInBand` inside container — all unit + integration tests must pass
- Run `npm run test:e2e` inside container — all E2E tests must pass
- Run `npx tsc --noEmit` — must exit 0
- Run `npm run lint` — must exit 0
- Update `progress.md` with final test counts per SI

**Tests:** Full suite

**Dependencies:** SI-03.1 through SI-03.7

**Acceptance criteria:**

- All tests green (unit + integration + e2e)
- TypeScript compilation clean
- Lint clean
- progress.md reflects correct SI status and test counts

---

## Dependency Map

```
SI-03.1 (infra, config)
    ↓
SI-03.2 (StorageModule)    SI-03.3 (QueueModule)
    ↓                          ↓
SI-03.4 (Video entity + migration)
    ↓
SI-03.5 (upload initiation, video queries)
    ↓
SI-03.6 (processing trigger, streaming, download)
    ↓
SI-03.7 (Video Worker)
    ↓
SI-03.8 (Full suite + DoD)
```

---

## Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| MinIO + Redis + Worker in compose.yaml | `nestjs-project/compose.yaml` | pending |
| StorageModule | `src/storage/` | pending |
| QueueModule | `src/queue/` | pending |
| Video entity | `src/videos/entities/video.entity.ts` | pending |
| CreateVideos migration | `src/database/migrations/<ts>-CreateVideos.ts` | pending |
| VideosModule (controller + service) | `src/videos/` | pending |
| Video Worker | `nestjs-project/worker/` | pending |
| All tests green (unit + integration + e2e) | — | pending |
| tsc --noEmit exit 0 | — | pending |
| npm run lint exit 0 | — | pending |
| CLAUDE.md updated | `nestjs-project/CLAUDE.md`, root `CLAUDE.md` | pending |
