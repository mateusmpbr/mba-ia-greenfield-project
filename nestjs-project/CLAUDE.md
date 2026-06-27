# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos Module (Phase 03)

### Infrastructure Services

| Service        | Compose name    | Port  | Purpose                                |
|----------------|-----------------|-------|----------------------------------------|
| MinIO          | `minio`         | 9000  | Object storage for videos/thumbnails   |
| MinIO Console  | `minio`         | 9001  | Web UI for bucket management           |
| Redis          | `redis`         | 6379  | BullMQ queue backend                   |
| Video Worker   | `video-worker`  | —     | FFmpeg processing container            |

### Key Design Decisions

- **Upload strategy:** presigned PUT URL — client uploads directly to MinIO; API never proxies video bytes.
- **Streaming:** presigned GET URL + HTTP 302 redirect; MinIO handles range requests natively.
- **Slug:** 11-char URL-safe ID generated with `crypto.randomBytes` (not nanoid — ESM-only, Jest-incompatible).
- **Worker:** separate Docker container (`worker/`) sharing the same `package.json`; communicates via BullMQ.
- **Status lifecycle:** `draft → processing → ready | error`

### Config Namespaces

- `storage.*` — MinIO endpoint, credentials, bucket, TTL values (`src/config/storage.config.ts`)
- `redis.*` — host and port for BullMQ (`src/config/redis.config.ts`)

### API Endpoints

| Method | Path                              | Auth     | Description                                    |
|--------|-----------------------------------|----------|------------------------------------------------|
| POST   | `/videos`                         | Required | Create draft + return presigned upload URL     |
| GET    | `/videos/:slug`                   | Public   | Get video metadata                             |
| POST   | `/videos/:id/trigger-processing`  | Required | Validate upload and enqueue processing job     |
| GET    | `/videos/:slug/stream`            | Public   | 302 redirect to presigned streaming URL        |
| GET    | `/videos/:slug/download`          | Public   | 302 redirect to presigned download URL         |

### Domain Exceptions

| Code                        | HTTP | Thrown when                                        |
|-----------------------------|------|----------------------------------------------------|
| `VIDEO_NOT_FOUND`           | 404  | Slug or ID not found                               |
| `VIDEO_NOT_IN_DRAFT`        | 409  | Trigger-processing called on non-draft video       |
| `VIDEO_NOT_READY`           | 422  | Stream/download called on non-ready video          |
| `VIDEO_FORBIDDEN`           | 403  | User's channel does not own the video              |
| `STORAGE_OBJECT_NOT_FOUND`  | 422  | Video file missing from MinIO before processing    |

### Worker

The worker (`worker/src/`) is a standalone Node process, not a NestJS app:

1. Downloads video from MinIO to a tmp file
2. Runs `ffprobe` for duration and codec metadata
3. Generates a thumbnail with `ffmpeg screenshots`
4. Uploads thumbnail to MinIO at `thumbnails/<slug>.jpg`
5. Updates the `videos` row (status=ready, duration_seconds, metadata, thumbnail_key) via raw SQL
6. On error: sets status=error in DB

Tmp files are cleaned up in `try/finally` regardless of outcome.

### MinIO Bucket Setup

The `videos` bucket must exist before any upload. For local development, create it via the MinIO Console at `http://localhost:9001` (credentials from `.env`) or via the `mc` CLI:

```bash
docker compose exec minio mc alias set local http://localhost:9000 $STORAGE_ACCESS_KEY $STORAGE_SECRET_KEY
docker compose exec minio mc mb local/videos
docker compose exec minio mc anonymous set download local/videos
```

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
