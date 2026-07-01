import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_JOB,
} from '../queue/queue.constants';
import type { VideoProcessingJobData } from '../queue/queue.types';
import { generateSlug } from './slug.util';
import {
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
  VideoForbiddenException,
  StorageObjectNotFoundException,
} from '../common/exceptions/domain.exception';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<VideoProcessingJobData>,
  ) {}

  async createDraft(
    userId: string,
    title: string,
  ): Promise<{ video: Video; uploadUrl: string; storageKey: string }> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const slug = generateSlug();
    const storageKey = `videos/${channel.id}/${slug}.mp4`;

    const video = this.videoRepository.create({
      slug,
      title,
      status: VideoStatus.DRAFT,
      storage_key: storageKey,
      channel_id: channel.id,
    });

    await this.videoRepository.save(video);

    const uploadUrl = await this.storageService.generateUploadUrl(storageKey);

    return { video, uploadUrl, storageKey };
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findById(id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async triggerProcessing(videoId: string, userId: string): Promise<Video> {
    const video = await this.findById(videoId);

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new VideoForbiddenException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    if (!video.storage_key) {
      throw new StorageObjectNotFoundException();
    }

    const objectExists = await this.storageService.objectExists(
      video.storage_key,
    );
    if (!objectExists) {
      throw new StorageObjectNotFoundException();
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const jobData: VideoProcessingJobData = {
      videoId: video.id,
      storageKey: video.storage_key,
      slug: video.slug,
    };

    await this.videoQueue.add(VIDEO_PROCESSING_JOB, jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    return video;
  }

  async getStreamUrl(slug: string): Promise<string> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return this.storageService.generateAccessUrl(video.storage_key!);
  }

  async getDownloadUrl(slug: string): Promise<string> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    const filename = `${video.title.replace(/[^a-z0-9_\-. ]/gi, '_')}.mp4`;
    return this.storageService.generateAccessUrl(video.storage_key!, filename);
  }
}
