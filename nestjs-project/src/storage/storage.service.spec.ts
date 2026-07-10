import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(() => Promise.resolve('https://signed.example/url')),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    process.env.STORAGE_ACCESS_KEY = 'test-key';
    process.env.STORAGE_SECRET_KEY = 'test-secret';
    process.env.STORAGE_ENDPOINT = 'http://internal:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://public:9000';

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
    jest.clearAllMocks();
  });

  it('should presign against the public endpoint client', async () => {
    await service.presignGetObject('videos/x/original.mp4');

    const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
      typeof getSignedUrl
    >;
    const presignClient = mockedGetSignedUrl.mock.calls[0][0] as unknown as {
      config: { endpoint: () => Promise<{ hostname: string }> };
    };
    const endpoint = await presignClient.config.endpoint();
    expect(endpoint.hostname).toBe('public');
  });

  it('should sort parts by partNumber when completing a multipart upload', async () => {
    const sendSpy = jest
      .spyOn(
        (service as unknown as { internal: { send: jest.Mock } }).internal,
        'send',
      )
      .mockResolvedValue({} as never);

    await service.completeMultipartUpload('key', 'upload-1', [
      { partNumber: 3, etag: 'c' },
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' },
    ]);

    const command = sendSpy.mock.calls[0][0] as CompleteMultipartUploadCommand;
    expect(command.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: 'a' },
      { PartNumber: 2, ETag: 'b' },
      { PartNumber: 3, ETag: 'c' },
    ]);
  });

  it('should create the bucket only when the head check fails', async () => {
    const sendSpy = jest
      .spyOn(
        (service as unknown as { internal: { send: jest.Mock } }).internal,
        'send',
      )
      .mockImplementation((command: unknown) => {
        if (command instanceof HeadBucketCommand) {
          return Promise.reject(
            Object.assign(new Error('NotFound'), { name: 'NotFound' }),
          );
        }
        return Promise.resolve({});
      });

    await service.ensureBucket();

    const commandTypes = sendSpy.mock.calls.map(
      (call) => (call[0] as object).constructor.name,
    );
    expect(commandTypes).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
  });

  it('should not create the bucket when it already exists', async () => {
    const sendSpy = jest
      .spyOn(
        (service as unknown as { internal: { send: jest.Mock } }).internal,
        'send',
      )
      .mockResolvedValue({} as never);

    await service.ensureBucket();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(
      sendSpy.mock.calls.some((call) => call[0] instanceof CreateBucketCommand),
    ).toBe(false);
  });
});
