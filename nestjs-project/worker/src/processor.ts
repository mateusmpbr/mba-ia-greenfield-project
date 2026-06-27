import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { downloadObject, uploadFile } from './storage';
import type { VideoProcessingJobData } from './queue.types';

const BUCKET = process.env.STORAGE_BUCKET || 'videos';

interface FfprobeMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
}

function extractMetadata(filePath: string): Promise<FfprobeMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      const videoStream = metadata.streams?.find(
        (s) => s.codec_type === 'video',
      );
      const duration = metadata.format?.duration ?? 0;
      resolve({
        durationSeconds: Math.round(duration),
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        codec: videoStream?.codec_name ?? null,
        bitrate: metadata.format?.bit_rate
          ? parseInt(metadata.format.bit_rate.toString(), 10)
          : null,
      });
    });
  });
}

function extractThumbnail(
  videoPath: string,
  outputPath: string,
  durationSeconds: number,
): Promise<void> {
  const timemark = Math.max(1, Math.floor(durationSeconds * 0.1));
  const dir = path.dirname(outputPath);
  const filename = path.basename(outputPath);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .screenshots({
        count: 1,
        timemarks: [timemark.toString()],
        folder: dir,
        filename,
        size: '1280x720',
      });
  });
}

export async function processVideo(
  data: VideoProcessingJobData,
  dataSource: DataSource,
  s3: S3Client,
): Promise<void> {
  const { videoId, storageKey, slug } = data;
  const videoRepo = dataSource.getRepository(Video);
  const tmpDir = os.tmpdir();
  const videoTmpPath = path.join(tmpDir, `video-${videoId}.mp4`);
  const thumbTmpPath = path.join(tmpDir, `thumb-${videoId}.jpg`);
  const thumbnailKey = `thumbnails/${slug}.jpg`;

  try {
    await downloadObject(s3, BUCKET, storageKey, videoTmpPath);

    const meta = await extractMetadata(videoTmpPath);

    await extractThumbnail(videoTmpPath, thumbTmpPath, meta.durationSeconds);

    await uploadFile(s3, BUCKET, thumbnailKey, thumbTmpPath, 'image/jpeg');

    const newMetadata: Record<string, unknown> = {
      width: meta.width,
      height: meta.height,
      codec: meta.codec,
      bitrate: meta.bitrate,
    };

    await videoRepo.query(
      `UPDATE videos SET status = $1, thumbnail_key = $2, duration_seconds = $3, metadata = $4, error_message = NULL, updated_at = NOW() WHERE id = $5`,
      [VideoStatus.READY, thumbnailKey, meta.durationSeconds, JSON.stringify(newMetadata), videoId],
    );
  } finally {
    for (const tmpFile of [videoTmpPath, thumbTmpPath]) {
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
