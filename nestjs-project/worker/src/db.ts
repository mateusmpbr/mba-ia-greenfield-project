import { DataSource } from 'typeorm';
import { Video } from './entities/video.entity';

export function createWorkerDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'streamtube',
    password: process.env.DB_PASSWORD || 'streamtube',
    database: process.env.DB_NAME || 'streamtube',
    entities: [Video],
    synchronize: false,
  });
}
