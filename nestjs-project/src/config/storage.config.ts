import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
  bucket: process.env.STORAGE_BUCKET || 'videos',
  uploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS || '7200',
    10,
  ),
  accessUrlTtlSeconds: parseInt(
    process.env.STORAGE_ACCESS_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
