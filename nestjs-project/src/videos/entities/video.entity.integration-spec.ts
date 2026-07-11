import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  const baseVideo = () => ({
    channel_id: channelId,
    title: 'My first video',
    public_id: `pub${Date.now().toString(36)}`.slice(0, 11),
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: '1048576',
    storage_key: 'videos/x/original.mp4',
  });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const userRepository = dataSource.getRepository(User);
    const channelRepository = dataSource.getRepository(Channel);
    const user = await userRepository.save(
      userRepository.create({
        email: `owner-${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'owner',
        nickname: `owner_${Date.now().toString(36)}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  it('should auto-generate uuid, timestamps, and default status draft', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo()),
    );

    expect(saved.id).toBeDefined();
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id constraint', async () => {
    const data = baseVideo();
    await videoRepository.save(videoRepository.create(data));

    await expect(
      videoRepository.save(videoRepository.create({ ...data })),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" (channel_id, title, public_id, status, original_filename, mime_type, size_bytes, storage_key)
         VALUES ($1, 't', 'unique000ab', 'published', 'a.mp4', 'video/mp4', 1, 'k')`,
        [channelId],
      ),
    ).rejects.toThrow();
  });

  it('should enforce the foreign key to channels', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          ...baseVideo(),
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should round-trip jsonb metadata and bigint size', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      codec: 'h264',
      format: 'mp4',
    };
    const saved = await videoRepository.save(
      videoRepository.create({
        ...baseVideo(),
        size_bytes: '10737418240',
        metadata,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
    expect(found.size_bytes).toBe('10737418240');
  });

  it('should default worker-owned columns to null', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(baseVideo()),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_error).toBeNull();
    expect(found.upload_id).toBeNull();
  });
});
