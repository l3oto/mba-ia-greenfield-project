import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidUploadStateException,
  NotVideoOwnerException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import {
  PROCESS_VIDEO_JOB,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

const OWNER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: OWNER_ID };

describe('VideosService', () => {
  let service: VideosService;

  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => data as Video),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const channelRepository = {
    findOneByOrFail: jest.fn().mockResolvedValue(CHANNEL as Channel),
  };
  const storageService = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn().mockResolvedValue('https://signed/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
  const processingQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const uploadingVideo = (): Video =>
    ({
      id: 'video-1',
      channel_id: CHANNEL.id,
      channel: CHANNEL,
      status: VideoStatus.UPLOADING,
      upload_id: 'upload-1',
      storage_key: 'videos/video-1/original.mp4',
      size_bytes: String(250 * 1024 * 1024),
    }) as Video;

  beforeEach(async () => {
    jest.clearAllMocks();
    channelRepository.findOneByOrFail.mockResolvedValue(CHANNEL as Channel);
    videoRepository.save.mockImplementation((video: Video) =>
      Promise.resolve({ ...video, id: video.id ?? 'video-1' }),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: processingQueue,
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    const dto = {
      filename: 'ferias na praia.mp4',
      mime_type: 'video/mp4',
      size_bytes: 250 * 1024 * 1024,
    };

    it('should create a draft, open the multipart upload, and flip to uploading', async () => {
      const result = await service.initiateUpload(OWNER_ID, dto);

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: CHANNEL.id,
          title: 'ferias na praia',
          public_id: expect.stringMatching(/^[0-9A-Za-z_-]{11}$/) as string,
        }),
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'video/mp4',
      );
      const lastCall = videoRepository.save.mock.calls.at(-1) as [Video];
      const lastSave = lastCall[0];
      expect(lastSave.status).toBe(VideoStatus.UPLOADING);
      expect(lastSave.upload_id).toBe('upload-1');
      expect(result).toEqual({
        video_id: 'video-1',
        public_id: expect.any(String) as string,
        upload_id: 'upload-1',
        part_size: UPLOAD_PART_SIZE_BYTES,
        part_count: 3,
      });
    });

    it('should retry once with a fresh public_id on unique violation', async () => {
      const uniqueViolation = Object.assign(
        new QueryFailedError('insert', [], new Error('duplicate')),
        { code: '23505' },
      );
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation)
        .mockImplementation((video: Video) =>
          Promise.resolve({ ...video, id: 'video-1' }),
        );

      await service.initiateUpload(OWNER_ID, dto);

      const publicIds = videoRepository.create.mock.calls.map(
        (call) => (call[0] as Video).public_id,
      );
      expect(publicIds).toHaveLength(2);
      expect(publicIds[0]).not.toBe(publicIds[1]);
    });
  });

  describe('getUploadPartUrl', () => {
    it('should presign the requested part for the owner', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      const url = await service.getUploadPartUrl(OWNER_ID, 'video-1', 2);

      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        2,
      );
      expect(url).toBe('https://signed/part');
    });

    it('should throw when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getUploadPartUrl(OWNER_ID, 'missing', 1),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw when the caller does not own the video', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...uploadingVideo(),
        channel: { id: 'channel-2', user_id: 'user-2' },
      });

      await expect(
        service.getUploadPartUrl(OWNER_ID, 'video-1', 1),
      ).rejects.toThrow(NotVideoOwnerException);
    });

    it('should throw when the video is not uploading', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...uploadingVideo(),
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      await expect(
        service.getUploadPartUrl(OWNER_ID, 'video-1', 1),
      ).rejects.toThrow(InvalidUploadStateException);
    });

    it('should reject a part number beyond the part count', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      await expect(
        service.getUploadPartUrl(OWNER_ID, 'video-1', 4),
      ).rejects.toThrow(InvalidUploadStateException);
    });
  });

  describe('completeUpload', () => {
    it('should finalize storage, flip to processing, and enqueue the job', async () => {
      videoRepository.findOne.mockResolvedValue(uploadingVideo());

      const result = await service.completeUpload(OWNER_ID, 'video-1', {
        parts: [
          { part_number: 2, etag: '"b"' },
          { part_number: 1, etag: '"a"' },
        ],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        [
          { partNumber: 2, etag: '"b"' },
          { partNumber: 1, etag: '"a"' },
        ],
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.upload_id).toBeNull();
      expect(processingQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'video-1' },
        expect.objectContaining({
          jobId: 'video-1',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    });
  });

  describe('playback', () => {
    const readyVideo = (): Video =>
      ({
        id: 'video-1',
        public_id: 'abc123def45',
        title: 'clip',
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/original.mp4',
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        original_filename: 'clip.mp4',
        duration_seconds: 42,
        created_at: new Date(),
        channel: { nickname: 'owner', name: 'Owner' },
      }) as Video;

    const storageWithPresign = () =>
      Object.assign(storageService, {
        presignGetObject: jest.fn().mockResolvedValue('https://signed/get'),
      });

    it('should return public metadata with a presigned thumbnail', async () => {
      const storage = storageWithPresign();
      videoRepository.findOne.mockResolvedValue(readyVideo());

      const metadata = await service.getPublicMetadata('abc123def45');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
      expect(metadata).toMatchObject({
        public_id: 'abc123def45',
        title: 'clip',
        duration_seconds: 42,
        thumbnail_url: 'https://signed/get',
        channel: { nickname: 'owner', name: 'Owner' },
      });
    });

    it('should treat non-ready videos as not found on the metadata surface', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...readyVideo(),
        status: VideoStatus.PROCESSING,
      });

      await expect(service.getPublicMetadata('abc123def45')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should presign the stream URL for a ready video', async () => {
      const storage = storageWithPresign();
      const findOneBy = jest.fn().mockResolvedValue(readyVideo());
      Object.assign(videoRepository, { findOneBy });

      const url = await service.getStreamUrl('abc123def45');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
      );
      expect(url).toBe('https://signed/get');
    });

    it('should throw VIDEO_NOT_READY when streaming an unprocessed video', async () => {
      Object.assign(videoRepository, {
        findOneBy: jest.fn().mockResolvedValue({
          ...readyVideo(),
          status: VideoStatus.PROCESSING,
        }),
      });

      await expect(service.getStreamUrl('abc123def45')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('should pass the original filename to the download presign', async () => {
      const storage = storageWithPresign();
      Object.assign(videoRepository, {
        findOneBy: jest.fn().mockResolvedValue(readyVideo()),
      });

      await service.getDownloadUrl('abc123def45');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        { downloadFilename: 'clip.mp4' },
      );
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and remove the row', async () => {
      const video = uploadingVideo();
      videoRepository.findOne.mockResolvedValue(video);

      await service.abortUpload(OWNER_ID, 'video-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });
  });
});
