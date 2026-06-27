import type { Video } from '../entities/video.entity';
import type { VideoStatus } from '../entities/video-status.enum';

export class VideoResponseDto {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  channelId: string;
  createdAt: Date;
  updatedAt: Date;

  static from(video: Video): VideoResponseDto {
    const dto = new VideoResponseDto();
    dto.id = video.id;
    dto.slug = video.slug;
    dto.title = video.title;
    dto.status = video.status;
    dto.durationSeconds = video.duration_seconds;
    dto.channelId = video.channel_id;
    dto.createdAt = video.created_at;
    dto.updatedAt = video.updated_at;
    return dto;
  }
}

export class CreateVideoResponseDto extends VideoResponseDto {
  uploadUrl: string;
  storageKey: string;

  static fromWithUploadUrl(
    video: Video,
    uploadUrl: string,
    storageKey: string,
  ): CreateVideoResponseDto {
    const dto = new CreateVideoResponseDto();
    Object.assign(dto, VideoResponseDto.from(video));
    dto.uploadUrl = uploadUrl;
    dto.storageKey = storageKey;
    return dto;
  }
}
