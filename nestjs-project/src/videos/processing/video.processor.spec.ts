import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/video-processing-x'),
  readFile: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
  rm: jest.fn().mockResolvedValue(undefined),
}));

describe('VideoProcessor', () => {
  let processor: VideoProcessor;

  const videoRepository = {
    findOneBy: jest.fn(),
    save: jest.fn((video: Video) => Promise.resolve(video)),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const storageService = {
    downloadToFile: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const ffmpegService = {
    probe: jest.fn().mockResolvedValue({
      durationSeconds: 42,
      width: 1920,
      height: 1080,
      codec: 'h264',
      format: 'mp4',
    }),
    captureFrame: jest.fn().mockResolvedValue(undefined),
  };

  const processingVideo = (): Video =>
    ({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/video-1/original.mp4',
    }) as Video;

  const jobFor = (
    videoId: string,
    overrides: Partial<Job<ProcessVideoJobData>> = {},
  ): Job<ProcessVideoJobData> =>
    ({
      data: { videoId },
      attemptsMade: 1,
      opts: { attempts: 3 },
      ...overrides,
    }) as Job<ProcessVideoJobData>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  it('should process the video: download, probe, thumbnail, and mark ready', async () => {
    const video = processingVideo();
    videoRepository.findOneBy.mockResolvedValue(video);

    await processor.process(jobFor('video-1'));

    expect(storageService.downloadToFile).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
      expect.stringContaining('original.mp4'),
    );
    expect(ffmpegService.probe).toHaveBeenCalled();
    expect(ffmpegService.captureFrame).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining('thumbnail.jpg'),
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    const saved = videoRepository.save.mock.calls[0][0];
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBe(42);
    expect(saved.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
      format: 'mp4',
    });
    expect(saved.thumbnail_key).toBe('videos/video-1/thumbnail.jpg');
  });

  it('should skip when the video no longer exists', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await processor.process(jobFor('missing'));

    expect(storageService.downloadToFile).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should be idempotent for already-ready videos', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      ...processingVideo(),
      status: VideoStatus.READY,
    });

    await processor.process(jobFor('video-1'));

    expect(storageService.downloadToFile).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should keep the video processing on non-final failed attempts', async () => {
    await processor.onFailed(
      jobFor('video-1', { attemptsMade: 1 }),
      new Error('boom'),
    );

    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed with the error detail on the last attempt', async () => {
    await processor.onFailed(
      jobFor('video-1', { attemptsMade: 3 }),
      new Error('ffprobe exited with code 1'),
    );

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      {
        status: VideoStatus.FAILED,
        processing_error: 'ffprobe exited with code 1',
      },
    );
  });
});
