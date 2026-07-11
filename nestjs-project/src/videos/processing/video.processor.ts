import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      this.logger.warn(`Video ${job.data.videoId} no longer exists — skipping`);
      return;
    }
    // At-least-once delivery: a redelivered job for an already processed
    // video must be a no-op.
    if (video.status === VideoStatus.READY) {
      return;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    try {
      const inputPath = join(
        tempDir,
        `original${extname(video.storage_key) || '.bin'}`,
      );
      await this.storageService.downloadToFile(video.storage_key, inputPath);

      const probe = await this.ffmpegService.probe(inputPath);

      const thumbnailPath = join(tempDir, 'thumbnail.jpg');
      const frameAt = Math.min(1, probe.durationSeconds / 2);
      await this.ffmpegService.captureFrame(inputPath, frameAt, thumbnailPath);

      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      video.duration_seconds = probe.durationSeconds;
      video.metadata = {
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        format: probe.format,
      };
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.processing_error = null;
      await this.videoRepository.save(video);

      this.logger.log(
        `Video ${video.id} processed (${probe.durationSeconds}s)`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      // BullMQ will retry with backoff — keep the video in processing.
      return;
    }
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.FAILED, processing_error: error.message },
    );
    this.logger.error(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
  }
}
