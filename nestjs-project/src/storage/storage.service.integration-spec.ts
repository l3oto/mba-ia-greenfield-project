import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let tempDir: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
    await service.ensureBucket();
    tempDir = await mkdtemp(join(tmpdir(), 'storage-spec-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should be idempotent when ensuring the bucket', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('should complete a multipart round-trip and serve the exact bytes', async () => {
    const key = `videos/it-${Date.now()}/original.bin`;
    const payload = Buffer.from('streamtube-multipart-payload'.repeat(10));

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: payload,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const getUrl = await service.presignGetObject(key);
    const getResponse = await fetch(getUrl);
    expect(getResponse.status).toBe(200);
    const body = Buffer.from(await getResponse.arrayBuffer());
    expect(body.equals(payload)).toBe(true);
  });

  it('should serve Range requests with 206 Partial Content', async () => {
    const key = `videos/it-${Date.now()}/ranged.bin`;
    const payload = Buffer.alloc(1024, 7);
    await service.putObject(key, payload, 'application/octet-stream');

    const url = await service.presignGetObject(key);
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-99' },
    });

    expect(response.status).toBe(206);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(100);
  });

  it('should set attachment disposition for downloads', async () => {
    const key = `videos/it-${Date.now()}/download.bin`;
    await service.putObject(key, Buffer.from('abc'), 'video/mp4');

    const url = await service.presignGetObject(key, {
      downloadFilename: 'meu video.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="meu video.mp4"',
    );
  });

  it('should download an object to a local file', async () => {
    const key = `videos/it-${Date.now()}/tofile.bin`;
    const payload = Buffer.from('download-to-file-payload');
    await service.putObject(key, payload, 'application/octet-stream');

    const destPath = join(tempDir, 'downloaded.bin');
    await service.downloadToFile(key, destPath);

    const written = await readFile(destPath);
    expect(written.equals(payload)).toBe(true);
  });

  it('should abort a multipart upload', async () => {
    const key = `videos/it-${Date.now()}/aborted.bin`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    // Completing an aborted upload must fail — the upload no longer exists.
    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"x"' },
      ]),
    ).rejects.toThrow();
  });
});
