import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { createTestDataSource } from '../test/create-test-data-source';
import {
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoForbiddenException,
  StorageObjectNotFoundException,
} from '../common/exceptions/domain.exception';

// slug.util uses Node's crypto.randomBytes — no mock needed

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const mockStorageService = {
  generateUploadUrl: jest.fn().mockResolvedValue('https://minio/upload'),
  generateAccessUrl: jest.fn().mockResolvedValue('https://minio/access'),
  objectExists: jest.fn().mockResolvedValue(true),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let channelsService: ChannelsService;

  let userCounter = 0;

  async function createChannelWithUser(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = await userRepo.save(
      userRepo.create({
        email: `vidsi_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Test Channel',
        nickname: `vidsi_chan${userCounter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function cleanVideos(): Promise<void> {
    await dataSource.query('DELETE FROM "videos"');
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres',
            host: process.env.DB_HOST ?? 'db',
            port: Number(process.env.DB_PORT ?? 5432),
            username: process.env.DB_USERNAME ?? 'streamtube',
            password: process.env.DB_PASSWORD ?? 'streamtube',
            database: process.env.DB_DATABASE ?? 'streamtube',
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([Video, Channel]),
      ],
      providers: [
        VideosService,
        ChannelsService,
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
    channelsService = module.get<ChannelsService>(ChannelsService);
  });

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStorageService.objectExists.mockResolvedValue(true);
    await cleanVideos();
  });

  describe('createDraft', () => {
    it('creates a video in draft status and returns presigned URL', async () => {
      const { user } = await createChannelWithUser();

      const result = await service.createDraft(user.id, 'My Video');

      expect(result.video.status).toBe(VideoStatus.DRAFT);
      expect(result.video.title).toBe('My Video');
      expect(result.uploadUrl).toBe('https://minio/upload');
      expect(result.storageKey).toContain('.mp4');
    });

    it('throws VideoNotFoundException when user has no channel', async () => {
      await expect(
        service.createDraft('00000000-0000-0000-0000-000000000000', 'Video'),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('findBySlug', () => {
    it('finds a video by slug', async () => {
      const { user } = await createChannelWithUser();
      const { video } = await service.createDraft(user.id, 'Find Me');

      const found = await service.findBySlug(video.slug);
      expect(found.id).toBe(video.id);
    });

    it('throws VideoNotFoundException for unknown slug', async () => {
      await expect(service.findBySlug('unknownslug')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('triggerProcessing', () => {
    it('transitions draft → processing and enqueues job', async () => {
      const { user } = await createChannelWithUser();
      const { video } = await service.createDraft(user.id, 'Process Me');

      const updated = await service.triggerProcessing(video.id, user.id);

      expect(updated.status).toBe(VideoStatus.PROCESSING);
      expect(mockQueue.add).toHaveBeenCalled();
    });

    it('throws VideoForbiddenException when wrong user', async () => {
      const { user: user1 } = await createChannelWithUser();
      const { user: user2 } = await createChannelWithUser();
      const { video } = await service.createDraft(user1.id, 'Owned Video');

      await expect(
        service.triggerProcessing(video.id, user2.id),
      ).rejects.toThrow(VideoForbiddenException);
    });

    it('throws VideoNotInDraftException when already processing', async () => {
      const { user } = await createChannelWithUser();
      const { video } = await service.createDraft(user.id, 'Status Test');
      await service.triggerProcessing(video.id, user.id);

      await expect(
        service.triggerProcessing(video.id, user.id),
      ).rejects.toThrow(VideoNotInDraftException);
    });

    it('throws StorageObjectNotFoundException when object missing', async () => {
      mockStorageService.objectExists.mockResolvedValue(false);
      const { user } = await createChannelWithUser();
      const { video } = await service.createDraft(user.id, 'Missing File');

      await expect(
        service.triggerProcessing(video.id, user.id),
      ).rejects.toThrow(StorageObjectNotFoundException);
    });
  });
});
