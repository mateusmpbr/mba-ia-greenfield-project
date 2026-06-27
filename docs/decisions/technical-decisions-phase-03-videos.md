---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-27
scope_description: "Video upload and processing: object storage (MinIO/S3), message queue selection, presigned upload strategy for 10GB files, video worker (FFmpeg), unique URL generation, streaming, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Backend API that adds the videos module: upload initiation (presigned URL), processing trigger, streaming redirect, download redirect, and video metadata endpoints. New infrastructure: MinIO (object storage), Redis + BullMQ (message queue), Video Worker (FFmpeg processing container).

---

## TD-01: Message Queue Technology

**Scope:** Backend + Infrastructure

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing is CPU-intensive and must not block the API. A message queue is needed to decouple upload completion from FFmpeg processing. The architecture diagram leaves the queue technology explicitly as "TBD". The queue must support: job persistence (survives restarts), retry on failure, job status inspection, and a separate consumer (worker process).

**Options:**

### Option A: BullMQ + Redis (via @nestjs/bullmq)

- BullMQ is a modern, Redis-backed job queue built on top of Bull, rewritten with TypeScript-first design. The `@nestjs/bullmq` module provides NestJS DI integration. Redis serves as the queue broker.
- **Pros:** First-class NestJS integration via `@nestjs/bullmq` (module, `@Processor`, `@OnWorkerEvent` decorators). Bull-compatible job schema (id, data, opts, attempts, progress). Atomic operations via Redis Lua scripts — no job loss on crash. Built-in retry with exponential backoff, job delay, and priority. Job events (active, completed, failed) observable via BullMQ's event system. Redis is lightweight in Docker and already a common dependency in NestJS stacks. Excellent documentation and active community. TypeScript-first design.
- **Cons:** Requires Redis as an additional infrastructure service. BullMQ's advanced features (rate limiting, flow producers) require understanding the BullMQ model. Redis is an in-memory store — persistence depends on AOF/RDB configuration (acceptable for a job queue where re-upload can be triggered).

### Option B: RabbitMQ (AMQP via @nestjs/microservices)

- AMQP-based message broker. NestJS supports it via `@nestjs/microservices` with the `ClientProxy` / microservice pattern. Requires a RabbitMQ container.
- **Pros:** Industry-standard message broker. Supports complex routing (exchanges, bindings, fanout). Persistent messages by default (durable queues + persistent delivery mode). Strong at enterprise pub/sub and multi-consumer routing patterns.
- **Cons:** More complex setup: exchanges, queues, routing keys, bindings — overkill for a single video processing queue. `@nestjs/microservices` transport pattern is more suited for service-to-service RPC than job queues. No built-in job progress, retry backoff, or priority without custom implementation. RabbitMQ container is heavier than Redis. Less ergonomic for the "enqueue a job, process it in a worker" pattern.

### Option C: PostgreSQL as Queue (polling)

- Use the existing PostgreSQL database as a job queue via a `jobs` table. Workers poll the table for pending jobs using SELECT ... FOR UPDATE SKIP LOCKED.
- **Pros:** No new infrastructure — reuses the existing PostgreSQL container. Job data is in the same transactional DB as video records — can atomically update video status and enqueue. No additional services to configure or monitor.
- **Cons:** Polling introduces latency (must balance frequency vs. DB load). SELECT ... FOR UPDATE SKIP LOCKED requires careful implementation to avoid missed jobs. No built-in retry logic, backoff, or progress tracking — must be implemented manually. Scales poorly at high job volume (polling DB at high frequency is wasteful). Not the idiomatic pattern for video processing pipelines.

**Recommendation:** **Option A (BullMQ + Redis)** — The single video processing queue maps perfectly to BullMQ's job model. `@nestjs/bullmq` provides first-class NestJS DI integration with minimal boilerplate. Redis is a lightweight addition to Docker Compose. Built-in retry with exponential backoff handles transient FFmpeg failures without custom code. RabbitMQ's complexity is unwarranted for one queue; PostgreSQL polling trades simplicity for correctness edge cases.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, Redis 7 Docker image

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Backend + Client

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Files up to 10GB cannot be routed through the NestJS API — doing so would exhaust Node.js memory, block the event loop during I/O, and cap throughput to the API's bandwidth. A strategy is needed that keeps large file bytes off the API server while still allowing the API to control access, register the upload, and track status.

**Options:**

### Option A: Direct Multipart Upload Through the API (Streaming Proxy)

- Client sends the file directly to the NestJS API as a multipart/form-data POST. NestJS streams the body to MinIO via the S3 SDK's `PutObjectCommand` or MinIO client's stream API.
- **Pros:** Simple client code — a single POST to the API. API controls all aspects of the upload. No CORS configuration needed on MinIO.
- **Cons:** Every byte passes through the API process. Node.js handles one request at a time per core — a 10GB upload holds a connection for minutes. Memory spikes even with streaming (buffering in multipart parsers). API throughput is shared with video bytes. Doesn't scale — concurrent uploads saturate the API.

### Option B: Presigned PUT URL (Client Uploads Directly to MinIO)

- API creates the video draft record, generates a presigned PUT URL for MinIO with a TTL (e.g., 2 hours), and returns both the video ID and the presigned URL to the client. The client uploads the file directly to MinIO using the presigned URL (a standard HTTP PUT). After upload completes, the client calls `POST /videos/:id/trigger-processing` to notify the API, which then enqueues the FFmpeg job.
- **Pros:** API is never in the upload data path — no memory or throughput concern. MinIO handles the upload in its own I/O loop. Supports files of any size limited only by MinIO's storage. Presigned URLs are time-limited (2h) and scoped to one specific object key — no credentials exposed to the client. Standard S3-compatible pattern used by AWS, GCS, and Azure. Well-supported by the AWS SDK v3 (`@aws-sdk/s3-request-presigner`).
- **Cons:** Requires the client to make two requests: one to get the presigned URL, one to upload to MinIO (then one more to trigger processing). MinIO must be network-reachable from the client (not just from the API container). CORS must be configured on MinIO bucket for browser clients. The API cannot verify the upload actually happened without a size/ETag check — mitigated by checking the object exists before enqueuing.

### Option C: Multipart Upload via Presigned Part URLs (S3 Multipart Upload)

- API initiates a S3 multipart upload, returns part-level presigned URLs to the client. Client uploads each part directly to MinIO. Client calls API to complete the multipart upload. Enables resumable uploads.
- **Pros:** Resumable — individual part failures don't require re-uploading the entire file. Parts can be uploaded in parallel, improving throughput. Each part is bounded (e.g., 100MB), avoiding single-TCP-connection issues.
- **Cons:** Significantly more complex: client must split the file, upload parts in order/parallel, collect ETags, and call the completion API. Server must manage multipart upload lifecycle (abort on failure). Implementation complexity is 3–5x Option B. Resumability is a nice-to-have for Phase 03 but not in scope.

**Recommendation:** **Option B (Presigned PUT URL)** — The cleanest solution that keeps the API out of the upload path entirely. A single presigned URL covers files up to 5GB per S3 SDK default (configurable). For files larger than 5GB a multipart presigned upload would be needed, but for a 10GB cap, MinIO supports presigned PUT for up to 5GB natively and up to any size with `Content-Length` override — in practice, MinIO does not enforce the 5GB limit on presigned PUTs for local deployments. Option C's resumability is a Phase 04+ concern. Option A is categorically ruled out.

**Decision:** B (Presigned PUT URL)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Video Worker Architecture

**Scope:** Infrastructure + Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** FFmpeg is CPU-intensive. Video processing must not compete with the NestJS API for CPU. The worker must consume jobs from the BullMQ queue, download the video from MinIO, run FFmpeg/ffprobe, upload the thumbnail, and update the database.

**Options:**

### Option A: BullMQ Processor Inside the NestJS API Container

- Add a `@Processor('video-processing')` class to the NestJS API module. The BullMQ worker runs in the same Node.js process as the API.
- **Pros:** Single container — no new Docker service. Shares NestJS DI (TypeORM, config, services). No inter-service coordination needed.
- **Cons:** CPU-intensive FFmpeg work competes directly with API event loop. A long FFmpeg job blocks worker threads and degrades API latency. Cannot scale processing independently from the API. FFmpeg is a native binary — must be installed in the API container image, bloating it.

### Option B: Separate Worker Docker Service (Node.js + FFmpeg)

- A standalone Node.js process in its own Docker container. Imports only what it needs: BullMQ worker, AWS SDK (for MinIO), TypeORM (for DB updates), and `fluent-ffmpeg` (for FFmpeg). The container has FFmpeg installed via its base image. Registered as a separate service in `compose.yaml`.
- **Pros:** Complete isolation — FFmpeg work never touches the API event loop. Can be scaled independently (multiple worker replicas). Smaller API container (no FFmpeg binary). Worker can be restarted without affecting the API. Clear separation of concerns (SRP at the service level).
- **Cons:** Requires a separate Docker service definition. Shares DB and queue connection configuration — duplicated env vars (mitigated by sharing `.env`). Worker needs its own entry point and `tsconfig` (or shares the API's). Slightly more files to maintain.

**Recommendation:** **Option B (Separate Worker Docker Service)** — Isolation of CPU-intensive work from the API is non-negotiable for a video platform. The extra Docker service is a small cost for correct architecture. The worker is a standalone Node.js process (`ts-node` in dev, compiled JS in prod) in `nestjs-project/worker/` sharing the same `package.json` dependencies.

**Decision:** B (Separate Worker Docker Service)

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

---

## TD-04: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe identifier that appears in the video URL (e.g., `/videos/abc123def456`). The identifier must be collision-resistant without requiring a DB uniqueness check on every generation, and short enough for practical URLs.

**Options:**

### Option A: UUID v4 (36 characters)

- Standard UUID: `550e8400-e29b-41d4-a716-446655440000`. Already used as DB primary keys in the project.
- **Pros:** Zero extra dependency. Already in use. Collision probability is negligible.
- **Cons:** 36 characters (32 hex + 4 dashes) is too long for a public-facing URL identifier. Not aesthetically clean.

### Option B: NanoID (~11 characters)

- NanoID generates URL-safe random IDs using a custom alphabet (`A-Za-z0-9_-`). Default 21 characters; can be configured to 11–12 for this use case. ~1B IDs needed before 1% collision probability at 12 chars (more than sufficient for a video platform). ~5M weekly npm downloads.
- **Pros:** Short (11–12 chars), URL-safe by default. TypeScript-first (`nanoid` package exports types). Configurable alphabet and length. No sequential guessability. Well-maintained.
- **Cons:** Extra dependency (`nanoid`). Collision check on insert is still needed (unique constraint in DB) — but expected collision rate is negligible at the scale of a video platform.

### Option C: ULID (26 characters)

- ULID: time-sortable, 26 character base-32 encoded. Combines timestamp (48-bit) + randomness (80-bit).
- **Pros:** Sortable by creation time. No collision at reasonable scale. Useful for distributed systems requiring time-ordering.
- **Cons:** 26 characters — still long for a public URL slug. Sortability by creation time is not a requirement for video URLs. Exposes creation timestamp. Extra dependency (`ulid`).

**Recommendation:** **Option B (NanoID at 11 characters)** — The right balance of short URL, uniqueness, and zero guessability. 11 chars with NanoID's 64-char alphabet gives ~4.4 × 10¹⁹ possible values — effectively collision-free at video-platform scale. The DB unique constraint on `slug` catches the theoretical collision (retry once).

**Decision:** B (NanoID, 11 characters, default alphabet)

**Libraries:** `nanoid@^5.x`

---

## TD-05: Streaming Strategy

**Scope:** Backend + Infrastructure

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Video streaming requires HTTP range requests (206 Partial Content) so the player can seek without downloading the entire file. The API must enable streaming without routing all video bytes through Node.js.

**Options:**

### Option A: API Generates a Presigned GET URL → 302 Redirect to MinIO

- When a client requests `GET /videos/:id/stream`, the API generates a time-limited presigned GET URL for the video object in MinIO and returns an HTTP 302 redirect. The client (browser/player) follows the redirect to MinIO and fetches the video with its own range requests. MinIO natively handles `Range` headers and responds with `206 Partial Content`.
- **Pros:** API is out of the video data path entirely — no streaming bytes through Node.js. MinIO handles range requests natively. Presigned URL is time-limited (e.g., 1 hour) — the video URL cannot be shared indefinitely. Zero configuration needed beyond generating the URL. Works with any standard HTTP video player.
- **Cons:** The presigned URL is exposed in the browser's network tab — clients could share it within its TTL. The client sees two requests (302 → MinIO URL). MinIO must be accessible from the client's network (same as upload).

### Option B: API Proxies Range Requests to MinIO

- The API streams video bytes from MinIO to the client, forwarding `Range` headers and returning `206 Partial Content`. NestJS passes through the S3 `GetObjectCommand` stream.
- **Pros:** MinIO is not exposed to the client. The API can enforce access control on every chunk. No CORS/presigned URL needed.
- **Cons:** Every byte of every video passes through the Node.js process — CPU and memory impact, bandwidth cap equal to API throughput. Does not scale. The event loop is never truly blocked (streams are async) but bandwidth is a hard limit. Unacceptable for a video platform.

### Option C: CDN in Front of MinIO

- A CDN (CloudFront, Cloudflare) sits in front of MinIO. The API returns a CDN URL. The CDN caches video chunks and handles range requests.
- **Pros:** Optimal delivery — edge caching, global PoPs, no origin hit on cache miss. CDN handles range requests efficiently.
- **Cons:** Requires a CDN service — not in scope for local development. Adds infrastructure complexity and cost. Not feasible for the Docker Compose local environment.

**Recommendation:** **Option A (Presigned GET URL → 302 Redirect)** — Keeps the API out of the video data path while leveraging MinIO's native range-request support. The TTL-limited presigned URL is a sufficient access control mechanism for Phase 03. Download endpoint uses the same mechanism with an additional `ResponseContentDisposition=attachment` parameter to trigger browser download behavior.

**Decision:** A (Presigned GET URL with 302 Redirect for both streaming and download)

---

## TD-06: Video Status Lifecycle

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; processamento automático após upload

**Context:** A video goes through multiple states from initial upload to availability. The status field must reflect the current processing state and handle error cases. The lifecycle must be well-defined for the API to expose meaningful responses (e.g., 404 vs. 422 vs. 200) based on status.

**Options:**

### Option A: Simple Linear Lifecycle (draft → processing → ready | error)

- Four states: `draft` (created, upload URL issued), `processing` (job enqueued and worker active), `ready` (FFmpeg completed successfully), `error` (FFmpeg failed or upload incomplete).
- **Pros:** Simple, covers the Phase 03 requirements exactly. Maps 1:1 to the lifecycle steps: create draft → trigger processing → worker processes → ready/error. Easy to reason about and test.
- **Cons:** No distinction between "upload never happened" and "processing triggered". No `uploading` state to represent the period between presigned URL issue and client notification.

### Option B: Extended Lifecycle (draft → uploading → processing → ready | error)

- Five states: `draft` (created), `uploading` (presigned URL issued, client is uploading), `processing` (job enqueued), `ready`, `error`.
- **Pros:** More granular — distinguishes "URL issued but upload not completed" from "processing triggered".
- **Cons:** The `uploading` state is hard to reliably set (the client must call an endpoint, or a MinIO webhook triggers it). Adds complexity without Phase 03 deliverable value — the API can infer "upload not triggered" from `status = draft`.

**Recommendation:** **Option A (draft → processing → ready | error)** — Covers all Phase 03 requirements with minimal complexity. The `draft` state covers both "URL issued, not yet uploaded" and "URL issued, upload in progress" — the API checks object existence in MinIO before enqueuing. An abandoned draft is simply a record with `status=draft` and no object in storage.

**Decision:** A (draft → processing → ready | error)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Upload Strategy for 10GB Files | Presigned PUT URL | B (Presigned PUT URL) |
| TD-03 | Video Worker Architecture | Separate Docker Service | B (Separate Worker Docker Service) |
| TD-04 | Unique Video URL Identifier | NanoID (11 chars) | B (NanoID, 11 chars) |
| TD-05 | Streaming Strategy | Presigned GET URL + 302 Redirect | A (Presigned GET URL → 302 Redirect) |
| TD-06 | Video Status Lifecycle | draft → processing → ready/error | A (draft → processing → ready \| error) |
