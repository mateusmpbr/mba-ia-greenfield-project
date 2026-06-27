import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://minio/presigned-url'),
}));

const mockStorageConfig = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  accessKey: 'test-key',
  secretKey: 'test-secret',
  bucket: 'videos',
  uploadUrlTtlSeconds: 7200,
  accessUrlTtlSeconds: 3600,
};

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: storageConfig.KEY, useValue: mockStorageConfig },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  describe('generateUploadUrl', () => {
    it('returns a presigned URL for the given key', async () => {
      const url = await service.generateUploadUrl('videos/channel-1/slug.mp4');
      expect(url).toBe('https://minio/presigned-url');
    });
  });

  describe('generateAccessUrl', () => {
    it('returns a presigned GET URL without Content-Disposition when no filename given', async () => {
      const url = await service.generateAccessUrl('videos/channel-1/slug.mp4');
      expect(url).toBe('https://minio/presigned-url');
    });

    it('returns a presigned GET URL with Content-Disposition when filename provided', async () => {
      const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3');
      const url = await service.generateAccessUrl(
        'videos/channel-1/slug.mp4',
        'video.mp4',
      );
      expect(url).toBe('https://minio/presigned-url');
      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ResponseContentDisposition: 'attachment; filename="video.mp4"',
        }),
      );
    });
  });

  describe('objectExists', () => {
    it('returns true when HeadObject succeeds', async () => {
      const { S3Client } = jest.requireMock('@aws-sdk/client-s3');
      S3Client.mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StorageService,
          { provide: storageConfig.KEY, useValue: mockStorageConfig },
        ],
      }).compile();
      const svc = module.get<StorageService>(StorageService);

      const exists = await svc.objectExists('videos/channel-1/slug.mp4');
      expect(exists).toBe(true);
    });

    it('returns false when HeadObject throws', async () => {
      const { S3Client } = jest.requireMock('@aws-sdk/client-s3');
      S3Client.mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
      }));

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StorageService,
          { provide: storageConfig.KEY, useValue: mockStorageConfig },
        ],
      }).compile();
      const svc = module.get<StorageService>(StorageService);

      const exists = await svc.objectExists('videos/channel-1/missing.mp4');
      expect(exists).toBe(false);
    });
  });
});
