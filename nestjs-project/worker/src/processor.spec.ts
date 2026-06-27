import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// No nanoid import needed here — slug.util is not used in worker

jest.mock('fluent-ffmpeg', () => {
  const mockFfprobe = jest.fn((filePath: string, cb: Function) => {
    cb(null, {
      format: { duration: 120, bit_rate: '5000000' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
        },
      ],
    });
  });

  const mockScreenshots = jest.fn().mockImplementation(function (
    this: any,
    _opts: any,
  ) {
    return this;
  });

  const mockOn = jest.fn().mockImplementation(function (
    this: any,
    event: string,
    handler: Function,
  ) {
    if (event === 'end') {
      process.nextTick(() => handler());
    }
    return this;
  });

  const mockFfmpeg: any = jest.fn().mockImplementation(() => ({
    on: mockOn,
    screenshots: mockScreenshots,
  }));
  mockFfmpeg.ffprobe = mockFfprobe;
  return mockFfmpeg;
});

jest.mock('./storage', () => ({
  downloadObject: jest.fn().mockImplementation(
    async (_s3: any, _bucket: string, _key: string, destPath: string) => {
      fs.writeFileSync(destPath, 'fake-video-data');
    },
  ),
  uploadFile: jest.fn().mockResolvedValue(undefined),
}));

import { processVideo } from './processor';
import { VideoStatus } from './entities/video.entity';
import { downloadObject, uploadFile } from './storage';

const mockVideoRepo = {
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  query: jest.fn().mockResolvedValue([]),
};

const mockDataSource = {
  getRepository: jest.fn().mockReturnValue(mockVideoRepo),
};

const mockS3 = {} as any;

const mockJobData = {
  videoId: 'test-video-uuid',
  storageKey: 'videos/channel/testslug.mp4',
  slug: 'testslug1234',
};

describe('processVideo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataSource.getRepository.mockReturnValue(mockVideoRepo);

    const ffmpeg = jest.requireMock('fluent-ffmpeg');
    ffmpeg.ffprobe.mockImplementation((_fp: string, cb: Function) => {
      cb(null, {
        format: { duration: 120, bit_rate: '5000000' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        ],
      });
    });

    const mockFfmpegInstance = {
      on: jest.fn().mockImplementation(function (this: any, event: string, handler: Function) {
        if (event === 'end') process.nextTick(() => handler());
        return this;
      }),
      screenshots: jest.fn().mockReturnThis(),
    };
    ffmpeg.mockReturnValue(mockFfmpegInstance);

    const { downloadObject: dl, uploadFile: ul } = jest.requireMock('./storage');
    (dl as jest.Mock).mockImplementation(
      async (_s3: any, _bucket: string, _key: string, destPath: string) => {
        fs.writeFileSync(destPath, 'fake-video-data');
      },
    );
    (ul as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    const tmpDir = os.tmpdir();
    const videoTmpPath = path.join(tmpDir, `video-${mockJobData.videoId}.mp4`);
    const thumbTmpPath = path.join(tmpDir, `thumb-${mockJobData.videoId}.jpg`);
    for (const f of [videoTmpPath, thumbTmpPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('downloads video, extracts metadata, uploads thumbnail, and updates DB to ready', async () => {
    await processVideo(mockJobData, mockDataSource as any, mockS3);

    expect(downloadObject).toHaveBeenCalledWith(
      mockS3,
      'videos',
      mockJobData.storageKey,
      expect.stringContaining(mockJobData.videoId),
    );

    expect(uploadFile).toHaveBeenCalledWith(
      mockS3,
      'videos',
      `thumbnails/${mockJobData.slug}.jpg`,
      expect.any(String),
      'image/jpeg',
    );

    expect(mockVideoRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE videos'),
      expect.arrayContaining([
        VideoStatus.READY,
        `thumbnails/${mockJobData.slug}.jpg`,
        120,
        expect.stringContaining('h264'),
        mockJobData.videoId,
      ]),
    );
  });

  it('cleans up temp files even when processing succeeds', async () => {
    const tmpDir = os.tmpdir();
    const videoTmpPath = path.join(tmpDir, `video-${mockJobData.videoId}.mp4`);

    await processVideo(mockJobData, mockDataSource as any, mockS3);

    expect(fs.existsSync(videoTmpPath)).toBe(false);
  });

  it('throws and still cleans temp files when download fails', async () => {
    const { downloadObject: dl } = jest.requireMock('./storage');
    (dl as jest.Mock).mockRejectedValue(new Error('Download failed'));

    await expect(
      processVideo(mockJobData, mockDataSource as any, mockS3),
    ).rejects.toThrow('Download failed');

    const tmpDir = os.tmpdir();
    const videoTmpPath = path.join(tmpDir, `video-${mockJobData.videoId}.mp4`);
    expect(fs.existsSync(videoTmpPath)).toBe(false);
  });
});
