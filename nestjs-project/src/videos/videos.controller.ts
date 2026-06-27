import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  VideoResponseDto,
  CreateVideoResponseDto,
} from './dto/video-response.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft',
    description:
      'Creates a video record in draft status and returns a presigned URL for the client to upload the video file directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and presigned upload URL returned',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        uploadUrl: { type: 'string' },
        storageKey: { type: 'string' },
        channelId: { type: 'string', format: 'uuid' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @Body() dto: CreateVideoDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CreateVideoResponseDto> {
    const { video, uploadUrl, storageKey } = await this.videosService.createDraft(
      user.sub,
      dto.title,
    );
    return CreateVideoResponseDto.fromWithUploadUrl(video, uploadUrl, storageKey);
  }

  @Post(':id/trigger-processing')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Trigger video processing',
    description:
      'Signals that the upload is complete and enqueues the video for FFmpeg processing. The video must be in draft status and the file must exist in storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video file not found in storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async triggerProcessing(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.triggerProcessing(id, user.sub);
    return VideoResponseDto.from(video);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get video details',
    description: 'Returns the public metadata for a video by its slug.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'processing', 'ready', 'error'] },
        durationSeconds: { type: 'integer', nullable: true },
        channelId: { type: 'string', format: 'uuid' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(@Param('slug') slug: string): Promise<VideoResponseDto> {
    const video = await this.videosService.findBySlug(slug);
    return VideoResponseDto.from(video);
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream video',
    description:
      'Redirects to a presigned MinIO URL for video streaming. The client follows the redirect and MinIO handles range requests (206 Partial Content).',
  })
  @ApiResponse({ status: 302, description: 'Redirect to presigned stream URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video is not ready for streaming',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getStreamUrl(slug);
    res.redirect(302, url);
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Download video',
    description:
      'Redirects to a presigned MinIO URL that triggers a file download (Content-Disposition: attachment).',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(slug);
    res.redirect(302, url);
  }
}
