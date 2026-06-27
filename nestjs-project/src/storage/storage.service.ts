import { Inject, Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly uploadTtl: number;
  private readonly accessTtl: number;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
    this.bucket = config.bucket;
    this.uploadTtl = config.uploadUrlTtlSeconds;
    this.accessTtl = config.accessUrlTtlSeconds;
  }

  async generateUploadUrl(key: string): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: this.uploadTtl });
  }

  async generateAccessUrl(key: string, filename?: string): Promise<string> {
    const params: ConstructorParameters<typeof GetObjectCommand>[0] = {
      Bucket: this.bucket,
      Key: key,
    };
    if (filename) {
      params.ResponseContentDisposition = `attachment; filename="${filename}"`;
    }
    const command = new GetObjectCommand(params);
    return getSignedUrl(this.s3, command, { expiresIn: this.accessTtl });
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
