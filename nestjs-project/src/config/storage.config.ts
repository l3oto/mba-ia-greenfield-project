import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY,
  secretKey: process.env.STORAGE_SECRET_KEY,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  presignExpiresSeconds: parseInt(
    process.env.STORAGE_PRESIGN_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
