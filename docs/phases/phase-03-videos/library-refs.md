# phase-03-videos — Library References

Libraries fixed for Phase 03. All versions confirmed against context7 documentation and the installed package versions.

---

## @nestjs/bullmq

- **Version pinned:** `^11.0.0`
- **npm package:** `@nestjs/bullmq`
- **Purpose:** NestJS module wrapping BullMQ — provides `BullModule.forRoot()`, `BullModule.registerQueue()`, `@Processor()`, `@OnWorkerEvent()` decorators for queue consumers.
- **Key APIs used:**
  - `BullModule.forRootAsync({ useFactory })` — configure Redis connection via config
  - `BullModule.registerQueue({ name: 'video-processing' })` — register the queue in modules
  - `@InjectQueue('video-processing')` — inject `Queue` instance for adding jobs
  - `@Processor('video-processing')` — decorate worker class in the separate worker service
  - `@OnWorkerEvent('completed' | 'failed')` — lifecycle hooks

## bullmq

- **Version pinned:** `^5.0.0`
- **npm package:** `bullmq`
- **Purpose:** Underlying BullMQ library; used directly in the worker service for `Worker` class and job types.
- **Key APIs used:**
  - `Queue.add(name, data, opts)` — enqueue a job
  - `Worker` class — in the worker service to consume jobs
  - `Job<T>` type — typed job data

## @aws-sdk/client-s3

- **Version pinned:** `^3.0.0`
- **npm package:** `@aws-sdk/client-s3`
- **Purpose:** S3-compatible client for MinIO. Used to interact with object storage: put objects (for presigned URL generation), delete objects, check existence.
- **Key APIs used:**
  - `S3Client` — initialized with MinIO endpoint, credentials, `forcePathStyle: true`
  - `PutObjectCommand` — used as the target command for presigned upload URL
  - `GetObjectCommand` — used as the target command for presigned streaming/download URL
  - `HeadObjectCommand` — check if an object exists before enqueuing

## @aws-sdk/s3-request-presigner

- **Version pinned:** `^3.0.0`
- **npm package:** `@aws-sdk/s3-request-presigner`
- **Purpose:** Generate presigned URLs for S3/MinIO commands without exposing credentials to the client.
- **Key APIs used:**
  - `getSignedUrl(s3Client, command, { expiresIn })` — generates a presigned URL

## nanoid

- **Version pinned:** `^5.0.0`
- **npm package:** `nanoid`
- **Purpose:** Generate unique, URL-safe video slug identifiers (11 characters).
- **Key APIs used:**
  - `nanoid(11)` — generates an 11-character random ID
- **ESM note:** nanoid v5 is ESM-only. In the NestJS CommonJS context, use a dynamic `import()` wrapper or use `customAlphabet` from `nanoid/non-secure` (CommonJS build available). Confirmed approach: wrap in an async factory `async function generateSlug() { const { nanoid } = await import('nanoid'); return nanoid(11); }` or use the `nanoid` package with `"esModuleInterop": true` via ts-jest transform. **Resolved:** use `customAlphabet` from `nanoid` with `import()` async, called once at module init.

## fluent-ffmpeg

- **Version pinned:** `^2.1.3`
- **npm package:** `fluent-ffmpeg`
- **Purpose:** Node.js wrapper for FFmpeg CLI — used in the video worker to extract metadata (duration, resolution) via ffprobe and generate thumbnails via FFmpeg.
- **Key APIs used:**
  - `ffmpeg(inputPath).screenshots({ count: 1, timemarks: ['10%'], folder, filename })` — thumbnail extraction
  - `ffprobe(inputPath, callback)` — metadata extraction (duration, codec, resolution)

## @types/fluent-ffmpeg

- **Version pinned:** `^2.1.27`
- **npm package:** `@types/fluent-ffmpeg` (devDependency)
- **Purpose:** TypeScript type definitions for fluent-ffmpeg.
