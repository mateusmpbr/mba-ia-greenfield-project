import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import * as fs from 'fs';

export function createS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
    },
    forcePathStyle: true,
  });
}

export async function downloadObject(
  s3: S3Client,
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  await new Promise<void>((resolve, reject) => {
    const stream = response.Body as Readable;
    const writeStream = fs.createWriteStream(destPath);
    stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    stream.on('error', reject);
  });
}

export async function uploadFile(
  s3: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  contentType = 'image/jpeg',
): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const stat = fs.statSync(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentLength: stat.size,
      ContentType: contentType,
    }),
  );
}
