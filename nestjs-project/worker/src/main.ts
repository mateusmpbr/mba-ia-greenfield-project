import 'dotenv/config';
import { Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { createWorkerDataSource } from './db';
import { createS3Client } from './storage';
import { processVideo } from './processor';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import type { VideoProcessingJobData } from './queue.types';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

let dataSource: DataSource;

async function bootstrap(): Promise<void> {
  dataSource = createWorkerDataSource();
  await dataSource.initialize();
  console.log('Video worker: database connected');

  const s3 = createS3Client();

  const worker = new Worker<VideoProcessingJobData>(
    VIDEO_PROCESSING_QUEUE,
    async (job) => {
      console.log(`Processing job ${job.id}: video ${job.data.videoId}`);
      await processVideo(job.data, dataSource, s3);
    },
    {
      connection: { host: redisHost, port: redisPort },
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed: video ${job.data.videoId}`);
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    console.error(`Job ${job.id} failed: ${err.message}`);

    try {
      const videoRepo = dataSource.getRepository(Video);
      await videoRepo.update(
        { id: job.data.videoId },
        {
          status: VideoStatus.ERROR,
          error_message: err.message.slice(0, 1000),
        },
      );
    } catch (updateErr) {
      console.error('Failed to update video error status:', updateErr);
    }
  });

  console.log(
    `Video worker listening on queue "${VIDEO_PROCESSING_QUEUE}" (Redis ${redisHost}:${redisPort})`,
  );

  process.on('SIGTERM', async () => {
    console.log('Worker shutting down...');
    await worker.close();
    await dataSource.destroy();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
