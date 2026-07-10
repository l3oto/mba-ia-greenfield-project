import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  /** Client bound to the internal endpoint — used for data commands. */
  private readonly internal: S3Client;
  /**
   * Client bound to the public endpoint — used exclusively for presigning.
   * The signature covers the Host header, so URLs must be signed against
   * the host the consumer actually reaches.
   */
  private readonly presigner: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const clientOptions = {
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey ?? '',
        secretAccessKey: this.config.secretKey ?? '',
      },
    };
    this.internal = new S3Client({
      ...clientOptions,
      endpoint: this.config.endpoint,
    });
    this.presigner = new S3Client({
      ...clientOptions,
      endpoint: this.config.publicEndpoint,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket }));
    } catch {
      try {
        await this.internal.send(new CreateBucketCommand({ Bucket }));
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === 'BucketAlreadyOwnedByYou' ||
            error.name === 'BucketAlreadyExists')
        ) {
          return;
        }
        throw error;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async presignGetObject(
    key: string,
    options?: { downloadFilename?: string },
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options?.downloadFilename !== undefined && {
          ResponseContentDisposition: `attachment; filename="${options.downloadFilename}"`,
        }),
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const result = await this.internal.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`Storage object ${key} has no body`);
    }
    await pipeline(result.Body as Readable, createWriteStream(destPath));
  }
}
