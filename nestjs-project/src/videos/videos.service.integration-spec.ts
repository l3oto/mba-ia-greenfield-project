import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { BullModule } from '@nestjs/bullmq';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import type { TestingModule } from '@nestjs/testing';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let userId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, storageConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: dbConfig.host,
            port: dbConfig.port,
            username: dbConfig.username,
            password: dbConfig.password,
            database: dbConfig.name,
            entities: [User, Channel, Video],
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([Video, Channel]),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await queue.drain(true);
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');

    const [user] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "users" (email, password) VALUES ($1, 'hashed') RETURNING id`,
      [`owner-${Date.now()}@example.com`],
    );
    userId = user.id;
    await dataSource.query(
      `INSERT INTO "channels" (name, nickname, user_id) VALUES ('owner', $1, $2)`,
      [`owner_${Date.now().toString(36)}`, userId],
    );
  });

  it('should persist a draft with upload_id on initiate', async () => {
    const result = await service.initiateUpload(userId, {
      filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
    });

    const video = await videoRepository.findOneByOrFail({
      id: result.video_id,
    });
    expect(video.status).toBe(VideoStatus.UPLOADING);
    expect(video.upload_id).toBe(result.upload_id);
    expect(video.storage_key).toBe(`videos/${video.id}/original.mp4`);
    expect(video.public_id).toHaveLength(11);
    expect(result.part_count).toBe(1);
  });

  it('should complete the handshake after a real part upload and enqueue processing', async () => {
    const initiated = await service.initiateUpload(userId, {
      filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 64,
    });

    const partUrl = await service.getUploadPartUrl(
      userId,
      initiated.video_id,
      1,
    );
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.alloc(64, 1),
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') as string;

    const video = await service.completeUpload(userId, initiated.video_id, {
      parts: [{ part_number: 1, etag }],
    });

    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();

    const job = await queue.getJob(initiated.video_id);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ videoId: initiated.video_id });
  });

  it('should abort the upload and remove the draft row', async () => {
    const initiated = await service.initiateUpload(userId, {
      filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
    });

    await service.abortUpload(userId, initiated.video_id);

    const video = await videoRepository.findOneBy({
      id: initiated.video_id,
    });
    expect(video).toBeNull();
  });
});
