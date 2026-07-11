import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideoResponseDto } from './dto/video-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService, type InitiateUploadResult } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a multipart video upload',
    description:
      'Pre-registers the video as a draft on the caller channel and opens ' +
      'a multipart upload. The file bytes are sent directly to the object ' +
      'storage via presigned part URLs — never through this API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        video_id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string', example: 'dQw4w9WgXcQ' },
        upload_id: { type: 'string' },
        part_size: { type: 'number', example: 104857600 },
        part_count: { type: 'number', example: 100 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (non-video mime type, size over 10GB)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Get(':id/upload/parts/:partNumber/url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign the upload URL for one part',
    description:
      'Returns a presigned PUT URL for the given part number. The client ' +
      'sends the raw part bytes to this URL and collects the ETag header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress for this video',
    schema: errorSchema,
  })
  async getUploadPartUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) videoId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getUploadPartUrl(
      user.sub,
      videoId,
      partNumber,
    );
    return { url };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Finalizes the object in storage, flips the video to processing and ' +
      'enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (empty or malformed parts)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress for this video',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.completeUpload(
      user.sub,
      videoId,
      dto,
    );
    return VideoResponseDto.fromEntity(video);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort the upload and discard the draft',
    description:
      'Aborts the multipart upload in storage and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress for this video',
    schema: errorSchema,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) videoId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, videoId);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get public video metadata',
    description:
      'Public watch-page metadata for a ready video, including a presigned ' +
      'thumbnail URL. Anonymous access — non-ready videos behave as not found.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        public_id: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'number', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
        channel: {
          type: 'object',
          properties: {
            nickname: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown public id or video not ready',
    schema: errorSchema,
  })
  async getPublicMetadata(@Param('publicId') publicId: string): Promise<{
    public_id: string;
    title: string;
    duration_seconds: number | null;
    thumbnail_url: string | null;
    created_at: Date;
    channel: { nickname: string; name: string };
  }> {
    return this.videosService.getPublicMetadata(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream the video',
    description:
      'Redirects (302) to a presigned storage URL. The player follows the ' +
      'redirect and issues Range requests directly against the object ' +
      'storage, which answers 206 Partial Content — no full download needed.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: errorSchema,
  })
  async streamVideo(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getStreamUrl(publicId);
    return { url };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download the video',
    description:
      'Redirects (302) to a presigned storage URL carrying an attachment ' +
      'content disposition with the original filename.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: errorSchema,
  })
  async downloadVideo(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getDownloadUrl(publicId);
    return { url };
  }
}
