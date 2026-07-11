import { extname, basename } from 'path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadStateException,
  NotVideoOwnerException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  MAX_UPLOAD_PARTS,
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_TITLE_MAX_LENGTH,
  type ProcessVideoJobData,
} from './videos.constants';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';

export interface InitiateUploadResult {
  video_id: string;
  public_id: string;
  upload_id: string;
  part_size: number;
  part_count: number;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelRepository.findOneByOrFail({
      user_id: userId,
    });

    const extension = extname(dto.filename).toLowerCase();
    const title =
      basename(dto.filename, extname(dto.filename)).slice(
        0,
        VIDEO_TITLE_MAX_LENGTH,
      ) || 'Untitled video';

    const video = await this.saveDraftWithUniquePublicId({
      channel_id: channel.id,
      title,
      original_filename: dto.filename,
      mime_type: dto.mime_type,
      size_bytes: String(dto.size_bytes),
    });

    const storageKey = `videos/${video.id}/original${extension}`;
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.mime_type,
    );

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    video.status = VideoStatus.UPLOADING;
    await this.videoRepository.save(video);

    const partCount = Math.ceil(dto.size_bytes / UPLOAD_PART_SIZE_BYTES);
    return {
      video_id: video.id,
      public_id: video.public_id,
      upload_id: uploadId,
      part_size: UPLOAD_PART_SIZE_BYTES,
      part_count: partCount,
    };
  }

  async getUploadPartUrl(
    userId: string,
    videoId: string,
    partNumber: number,
  ): Promise<string> {
    const video = await this.findOwnedUploadingVideo(userId, videoId);

    const partCount = Math.ceil(
      Number(video.size_bytes) / UPLOAD_PART_SIZE_BYTES,
    );
    if (partNumber < 1 || partNumber > Math.min(partCount, MAX_UPLOAD_PARTS)) {
      throw new InvalidUploadStateException();
    }

    return this.storageService.presignUploadPart(
      video.storage_key,
      video.upload_id as string,
      partNumber,
    );
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.findOwnedUploadingVideo(userId, videoId);

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id as string,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    const saved = await this.videoRepository.save(video);

    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: saved.id },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: saved.id },
    );

    return saved;
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedUploadingVideo(userId, videoId);

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id as string,
    );
    await this.videoRepository.remove(video);
  }

  async getPublicMetadata(publicId: string): Promise<{
    public_id: string;
    title: string;
    status: VideoStatus;
    duration_seconds: number | null;
    thumbnail_url: string | null;
    created_at: Date;
    channel: { nickname: string; name: string };
  }> {
    const video = await this.findReadyVideoByPublicId(publicId);

    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(video.thumbnail_key)
      : null;

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: thumbnailUrl,
      created_at: video.created_at,
      channel: {
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
    };
  }

  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findPlayableVideoByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key);
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findPlayableVideoByPublicId(publicId);
    return this.storageService.presignGetObject(video.storage_key, {
      downloadFilename: video.original_filename,
    });
  }

  /**
   * Public metadata surface: non-ready videos are not publicly addressable
   * in this phase, so they behave as not found.
   */
  private async findReadyVideoByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Playback surface: an existing but unprocessed video is a distinct,
   * actionable state (409) — different from an unknown id (404).
   */
  private async findPlayableVideoByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findOwnedUploadingVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new NotVideoOwnerException();
    }
    if (video.status !== VideoStatus.UPLOADING || !video.upload_id) {
      throw new InvalidUploadStateException();
    }
    return video;
  }

  private async saveDraftWithUniquePublicId(
    draft: Pick<
      Video,
      'channel_id' | 'title' | 'original_filename' | 'mime_type' | 'size_bytes'
    >,
  ): Promise<Video> {
    try {
      return await this.videoRepository.save(
        this.videoRepository.create({
          ...draft,
          public_id: generatePublicId(),
          storage_key: '',
        }),
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code ===
          PG_UNIQUE_VIOLATION
      ) {
        // Astronomically rare nanoid collision — retry once with a fresh id.
        return this.videoRepository.save(
          this.videoRepository.create({
            ...draft,
            public_id: generatePublicId(),
            storage_key: '',
          }),
        );
      }
      throw error;
    }
  }
}
