import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

const execFileAsync = promisify(execFile);

/**
 * Full-pipeline E2E. Processing is executed by the real video-worker
 * container from the Compose stack, consuming the same Redis queue —
 * nothing is mocked below the HTTP surface.
 */
describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let tempDir: string;
  let clipBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'videos-e2e-'));
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

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await rm(tempDir, { recursive: true, force: true });
    await app.close();
  });

  beforeEach(async () => {
    await queue.drain(true);
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
  ): Promise<{ access_token: string }> {
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          confirmationToken = token;
          return Promise.resolve();
        },
      );

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    expect(authService).toBeDefined();
    return {
      access_token: (login.body as { access_token: string }).access_token,
    };
  }

  async function initiateUpload(
    accessToken: string,
    sizeBytes: number,
  ): Promise<{
    video_id: string;
    public_id: string;
    upload_id: string;
    part_size: number;
    part_count: number;
  }> {
    const response = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'ferias-na-praia.mp4',
        mime_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return response.body as {
      video_id: string;
      public_id: string;
      upload_id: string;
      part_size: number;
      part_count: number;
    };
  }

  async function uploadPartAndComplete(
    accessToken: string,
    videoId: string,
  ): Promise<void> {
    const partUrlResponse = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload/parts/1/url`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const { url } = partUrlResponse.body as { url: string };

    const putResponse = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(clipBuffer),
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') as string;

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);
  }

  async function waitUntilReady(publicId: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await request(app.getHttpServer()).get(
        `/videos/${publicId}`,
      );
      if (response.status === 200) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Video ${publicId} did not become ready in time`);
  }

  describe('upload orchestration', () => {
    it('rejects unauthenticated initiation', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload')
        .send({
          filename: 'clip.mp4',
          mime_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(401);
    });

    it('rejects non-video mime types and >10GB sizes without creating drafts', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'uploader1@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'doc.pdf',
          mime_type: 'application/pdf',
          size_bytes: 10,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'huge.mp4',
          mime_type: 'video/mp4',
          size_bytes: 10 * 1024 ** 3 + 1,
        })
        .expect(400);

      const rows = await dataSource.query<{ count: string }[]>(
        'SELECT COUNT(*)::text AS count FROM "videos"',
      );
      expect(rows[0].count).toBe('0');
    });

    it('initiates with draft pre-registration and 100MB part plan', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'uploader2@example.com',
      );

      const initiated = await initiateUpload(access_token, 250 * 1024 * 1024);

      expect(initiated.public_id).toMatch(/^[0-9A-Za-z_-]{11}$/);
      expect(initiated.part_size).toBe(100 * 1024 * 1024);
      expect(initiated.part_count).toBe(3);

      const [row] = await dataSource.query<
        { status: string; upload_id: string }[]
      >('SELECT status, upload_id FROM "videos" WHERE id = $1', [
        initiated.video_id,
      ]);
      expect(row.status).toBe('uploading');
      expect(row.upload_id).toBeTruthy();
    });

    it('blocks part URLs for non-owners with NOT_VIDEO_OWNER', async () => {
      const owner = await registerConfirmAndLogin('owner@example.com');
      const intruder = await registerConfirmAndLogin('intruder@example.com');
      const initiated = await initiateUpload(owner.access_token, 1024);

      const response = await request(app.getHttpServer())
        .get(`/videos/${initiated.video_id}/upload/parts/1/url`)
        .set('Authorization', `Bearer ${intruder.access_token}`)
        .expect(403);
      expect((response.body as { error: string }).error).toBe(
        'NOT_VIDEO_OWNER',
      );
    });

    it('aborts an upload and discards the draft', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'aborter@example.com',
      );
      const initiated = await initiateUpload(access_token, 1024);

      await request(app.getHttpServer())
        .delete(`/videos/${initiated.video_id}/upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      const rows = await dataSource.query<{ count: string }[]>(
        'SELECT COUNT(*)::text AS count FROM "videos"',
      );
      expect(rows[0].count).toBe('0');
    });
  });

  describe('full pipeline: upload → worker processing → delivery', () => {
    it('processes a real clip and serves metadata, 206 streaming, and download', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'pipeline@example.com',
      );
      const initiated = await initiateUpload(access_token, clipBuffer.length);

      // While still uploading, playback reports VIDEO_NOT_READY (409).
      const notReady = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}/stream`)
        .expect(409);
      expect((notReady.body as { error: string }).error).toBe(
        'VIDEO_NOT_READY',
      );
      // ...and the public metadata surface hides it entirely (404).
      await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}`)
        .expect(404);

      await uploadPartAndComplete(access_token, initiated.video_id);

      // The real video-worker container consumes the queue and processes.
      await waitUntilReady(initiated.public_id);

      // Public metadata without authentication.
      const metadata = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}`)
        .expect(200);
      const metadataBody = metadata.body as {
        title: string;
        duration_seconds: number;
        thumbnail_url: string;
        channel: { nickname: string };
      };
      expect(metadataBody.title).toBe('ferias-na-praia');
      expect(metadataBody.duration_seconds).toBe(2);
      expect(metadataBody.thumbnail_url).toContain('thumbnail.jpg');
      expect(metadataBody.channel.nickname).toContain('pipeline');

      const thumbnailResponse = await fetch(metadataBody.thumbnail_url);
      expect(thumbnailResponse.status).toBe(200);

      // Streaming: 302 to presigned URL, storage answers Range with 206.
      const stream = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}/stream`)
        .expect(302);
      const streamUrl = stream.headers.location;
      const ranged = await fetch(streamUrl, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect((await ranged.arrayBuffer()).byteLength).toBe(100);

      // Download: 302 whose target carries the attachment disposition.
      const download = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}/download`)
        .expect(302);
      const downloadResponse = await fetch(download.headers.location);
      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get('content-disposition')).toBe(
        'attachment; filename="ferias-na-praia.mp4"',
      );

      // Completing twice is an invalid upload state.
      const doubleComplete = await request(app.getHttpServer())
        .post(`/videos/${initiated.video_id}/upload/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] })
        .expect(409);
      expect((doubleComplete.body as { error: string }).error).toBe(
        'INVALID_UPLOAD_STATE',
      );
    }, 90000);

    it('returns 404 for unknown public ids and generates distinct ids per upload', async () => {
      await request(app.getHttpServer()).get('/videos/aaaaaaaaaaa').expect(404);

      const { access_token } = await registerConfirmAndLogin(
        'twouploads@example.com',
      );
      const first = await initiateUpload(access_token, 1024);
      const second = await initiateUpload(access_token, 1024);

      expect(first.public_id).not.toBe(second.public_id);
    });
  });
});
