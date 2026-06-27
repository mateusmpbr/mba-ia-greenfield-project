import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import type { Channel } from '../channels/entities/channel.entity';
import {
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
  VideoForbiddenException,
  StorageObjectNotFoundException,
} from '../common/exceptions/domain.exception';

jest.mock('./slug.util', () => ({
  generateSlug: jest.fn().mockReturnValue('testslug123'),
}));

const mockVideoRepository = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
};

const mockStorageService = {
  generateUploadUrl: jest.fn().mockResolvedValue('https://minio/upload-url'),
  generateAccessUrl: jest.fn().mockResolvedValue('https://minio/access-url'),
  objectExists: jest.fn().mockResolvedValue(true),
};

const mockChannelsService = {
  findByUserId: jest.fn(),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

const mockChannel: Partial<Channel> = {
  id: 'channel-uuid',
  user_id: 'user-uuid',
  nickname: 'testchannel',
  name: 'Test Channel',
};

const mockVideo: Partial<Video> = {
  id: 'video-uuid',
  slug: 'testslug123',
  title: 'Test Video',
  status: VideoStatus.DRAFT,
  storage_key: 'videos/channel-uuid/testslug123.mp4',
  channel_id: 'channel-uuid',
  thumbnail_key: null,
  duration_seconds: null,
  metadata: null,
  error_message: null,
};

describe('VideosService', () => {
  let service: VideosService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockChannelsService.findByUserId.mockResolvedValue({ ...mockChannel });
    mockVideoRepository.create.mockReturnValue({ ...mockVideo });
    mockVideoRepository.save.mockImplementation(async (v: Partial<Video>) => v);
    mockVideoRepository.findOne.mockImplementation(async () => ({ ...mockVideo }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: mockVideoRepository,
        },
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: ChannelsService,
          useValue: mockChannelsService,
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('createDraft', () => {
    it('creates a draft video and returns upload URL', async () => {
      const result = await service.createDraft('user-uuid', 'Test Video');

      expect(mockChannelsService.findByUserId).toHaveBeenCalledWith('user-uuid');
      expect(mockVideoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Video',
          status: VideoStatus.DRAFT,
          channel_id: 'channel-uuid',
        }),
      );
      expect(mockStorageService.generateUploadUrl).toHaveBeenCalled();
      expect(result.uploadUrl).toBe('https://minio/upload-url');
      expect(result.video).toBeDefined();
    });

    it('throws VideoNotFoundException when channel not found', async () => {
      mockChannelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft('user-uuid', 'Test')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('findBySlug', () => {
    it('returns the video when found', async () => {
      const result = await service.findBySlug('testslug123');
      expect(result).toEqual(mockVideo);
    });

    it('throws VideoNotFoundException when not found', async () => {
      mockVideoRepository.findOne.mockResolvedValue(null);

      await expect(service.findBySlug('notfound')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('findById', () => {
    it('returns the video when found', async () => {
      const result = await service.findById('video-uuid');
      expect(result).toEqual(mockVideo);
    });

    it('throws VideoNotFoundException when not found', async () => {
      mockVideoRepository.findOne.mockResolvedValue(null);

      await expect(service.findById('notfound')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('triggerProcessing', () => {
    it('transitions status to processing and enqueues a job', async () => {
      const result = await service.triggerProcessing('video-uuid', 'user-uuid');

      expect(mockVideoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({ videoId: 'video-uuid' }),
        expect.objectContaining({ attempts: 3 }),
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('throws VideoForbiddenException when channel does not match', async () => {
      mockChannelsService.findByUserId.mockResolvedValue({
        id: 'other-channel-uuid',
      });

      await expect(
        service.triggerProcessing('video-uuid', 'other-user'),
      ).rejects.toThrow(VideoForbiddenException);
    });

    it('throws VideoForbiddenException when channel not found', async () => {
      mockChannelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.triggerProcessing('video-uuid', 'user-uuid'),
      ).rejects.toThrow(VideoForbiddenException);
    });

    it('throws VideoNotInDraftException when status is not draft', async () => {
      mockVideoRepository.findOne.mockImplementation(async () => ({
        ...mockVideo,
        status: VideoStatus.PROCESSING,
      }));

      await expect(
        service.triggerProcessing('video-uuid', 'user-uuid'),
      ).rejects.toThrow(VideoNotInDraftException);
    });

    it('throws StorageObjectNotFoundException when object does not exist in storage', async () => {
      mockStorageService.objectExists.mockResolvedValue(false);

      await expect(
        service.triggerProcessing('video-uuid', 'user-uuid'),
      ).rejects.toThrow(StorageObjectNotFoundException);
    });
  });

  describe('getStreamUrl', () => {
    it('returns the presigned access URL for a ready video', async () => {
      mockVideoRepository.findOne.mockResolvedValue({
        ...mockVideo,
        status: VideoStatus.READY,
      });

      const url = await service.getStreamUrl('testslug123');
      expect(url).toBe('https://minio/access-url');
    });

    it('throws VideoNotReadyException when status is not ready', async () => {
      await expect(service.getStreamUrl('testslug123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('returns the presigned download URL with Content-Disposition for a ready video', async () => {
      mockVideoRepository.findOne.mockResolvedValue({
        ...mockVideo,
        status: VideoStatus.READY,
        title: 'My Test Video',
      });

      const url = await service.getDownloadUrl('testslug123');
      expect(mockStorageService.generateAccessUrl).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('.mp4'),
      );
      expect(url).toBe('https://minio/access-url');
    });

    it('throws VideoNotReadyException when status is not ready', async () => {
      await expect(service.getDownloadUrl('testslug123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });
});
