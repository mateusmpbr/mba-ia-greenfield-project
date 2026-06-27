import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

// slug.util uses Node's crypto.randomBytes — no mock needed

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    const storageService = moduleFixture.get(StorageService);
    jest
      .spyOn(storageService, 'generateUploadUrl')
      .mockResolvedValue('https://minio/presigned-upload');
    jest
      .spyOn(storageService, 'generateAccessUrl')
      .mockResolvedValue('https://minio/presigned-access');
    jest.spyOn(storageService, 'objectExists').mockResolvedValue(true);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return loginRes.body.access_token as string;
  }

  describe('POST /videos', () => {
    it('returns 201 with draft video and presigned upload URL', async () => {
      const accessToken = await registerConfirmAndLogin('vid1@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'My Test Video' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.title).toBe('My Test Video');
      expect(res.body.uploadUrl).toBe('https://minio/presigned-upload');
      expect(res.body.slug).toHaveLength(11);
      expect(res.body.storageKey).toContain('.mp4');
    });

    it('returns 401 without access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'Test' });

      expect(res.status).toBe(401);
    });

    it('returns 400 when title is missing', async () => {
      const accessToken = await registerConfirmAndLogin('vid2@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when title exceeds 200 chars', async () => {
      const accessToken = await registerConfirmAndLogin('vid3@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'a'.repeat(201) });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /videos/:slug', () => {
    it('returns 200 with video metadata for an existing slug', async () => {
      const accessToken = await registerConfirmAndLogin('vid4@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Find Me Video' });

      const slug = createRes.body.slug as string;

      const res = await request(app.getHttpServer()).get(`/videos/${slug}`);

      expect(res.status).toBe(200);
      expect(res.body.slug).toBe(slug);
      expect(res.body.title).toBe('Find Me Video');
      expect(res.body.status).toBe('draft');
      expect(res.body.uploadUrl).toBeUndefined();
    });

    it('returns 404 for an unknown slug', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/unknownslug1',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /videos/:id/trigger-processing', () => {
    it('returns 200 and transitions status to processing', async () => {
      const accessToken = await registerConfirmAndLogin('vid5@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Process Me' });

      const videoId = createRes.body.id as string;

      const triggerRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(triggerRes.status).toBe(200);
      expect(triggerRes.body.status).toBe('processing');
    });

    it('returns 401 without access token', async () => {
      const res = await request(app.getHttpServer()).post(
        '/videos/some-id/trigger-processing',
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when triggered by a different user', async () => {
      const token1 = await registerConfirmAndLogin('vid6a@example.com');
      const token2 = await registerConfirmAndLogin('vid6b@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token1}`)
        .send({ title: 'Owned Video' });

      const videoId = createRes.body.id as string;

      const triggerRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${token2}`);

      expect(triggerRes.status).toBe(403);
      expect(triggerRes.body.error).toBe('VIDEO_FORBIDDEN');
    });

    it('returns 409 when video is already processing', async () => {
      const accessToken = await registerConfirmAndLogin('vid7@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Double Trigger' });

      const videoId = createRes.body.id as string;

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${accessToken}`);

      const triggerRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(triggerRes.status).toBe(409);
      expect(triggerRes.body.error).toBe('VIDEO_NOT_IN_DRAFT');
    });
  });

  describe('GET /videos/:slug/stream', () => {
    async function createReadyVideo(accessToken: string): Promise<string> {
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Stream Test' });

      const videoId = createRes.body.id as string;
      const slug = createRes.body.slug as string;

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${accessToken}`);

      await dataSource.query(
        `UPDATE videos SET status = 'ready', storage_key = 'videos/test.mp4' WHERE id = $1`,
        [videoId],
      );

      return slug;
    }

    it('returns 302 redirect for a ready video', async () => {
      const accessToken = await registerConfirmAndLogin('vid8@example.com');
      const slug = await createReadyVideo(accessToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://minio/presigned-access');
    });

    it('returns 422 when video is not ready', async () => {
      const accessToken = await registerConfirmAndLogin('vid9@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Not Ready' });

      const slug = createRes.body.slug as string;

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}/stream`,
      );
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 404 for unknown slug', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/unknownslug2/stream',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('returns 302 redirect with attachment for a ready video', async () => {
      const accessToken = await registerConfirmAndLogin('vid10@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Download Test' });

      const videoId = createRes.body.id as string;
      const slug = createRes.body.slug as string;

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/trigger-processing`)
        .set('Authorization', `Bearer ${accessToken}`);

      await dataSource.query(
        `UPDATE videos SET status = 'ready', storage_key = 'videos/test.mp4' WHERE id = $1`,
        [videoId],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('https://minio/presigned-access');
    });

    it('returns 422 when video is not ready', async () => {
      const accessToken = await registerConfirmAndLogin('vid11@example.com');

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Not Ready Download' });

      const slug = createRes.body.slug as string;

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}/download`,
      );
      expect(res.status).toBe(422);
    });
  });
});
