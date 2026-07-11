import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import databaseConfig from '../../config/database.config';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let tempDir: string;
  let clipBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'processor-spec-'));
    const clipPath = join(tempDir, 'clip.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      clipPath,
    ]);
    clipBuffer = await readFile(clipPath);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
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
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessor, FfmpegService],
    }).compile();

    processor = module.get(VideoProcessor);
    storageService = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    await storageService.ensureBucket();
  }, 30000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await module.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
  });

  async function seedProcessingVideo(): Promise<Video> {
    const [user] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "users" (email, password) VALUES ($1, 'hashed') RETURNING id`,
      [`worker-${Date.now()}@example.com`],
    );
    const [channel] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO "channels" (name, nickname, user_id) VALUES ('w', $1, $2) RETURNING id`,
      [`worker_${Date.now().toString(36)}`, user.id],
    );

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'clip',
        public_id: `w${Date.now().toString(36)}`.padEnd(11, '0').slice(0, 11),
        status: VideoStatus.PROCESSING,
        original_filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size_bytes: String(clipBuffer.length),
        storage_key: '',
      }),
    );
    video.storage_key = `videos/${video.id}/original.mp4`;
    await videoRepository.save(video);
    await storageService.putObject(video.storage_key, clipBuffer, 'video/mp4');
    return video;
  }

  it('should process a real clip end-to-end: metadata, thumbnail, ready', async () => {
    const video = await seedProcessingVideo();

    await processor.process({
      data: { videoId: video.id },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBe(2);
    expect(processed.metadata).toMatchObject({ width: 320, height: 240 });
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(processed.processing_error).toBeNull();

    const thumbnailUrl = await storageService.presignGetObject(
      processed.thumbnail_key as string,
    );
    const response = await fetch(thumbnailUrl);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 30000);

  it('should be a no-op when reprocessing a ready video', async () => {
    const video = await seedProcessingVideo();
    const job = {
      data: { videoId: video.id },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>;

    await processor.process(job);
    const afterFirst = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(job);
    const afterSecond = await videoRepository.findOneByOrFail({ id: video.id });

    expect(afterSecond.updated_at).toEqual(afterFirst.updated_at);
  }, 30000);
});
