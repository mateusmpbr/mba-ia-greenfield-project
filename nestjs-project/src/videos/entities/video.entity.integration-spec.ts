import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video } from './video.entity';
import { VideoStatus } from './video-status.enum';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    // Remove stale rows before applying schema so the videos→channels FK can be
    // added without violating existing orphaned data from previous test runs.
    await dataSource.query('DELETE FROM "videos"').catch(() => undefined);
    await dataSource.synchronize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannelWithUser(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Test Channel',
        nickname: `testchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should create a video with draft status by default', async () => {
    const channel = await createChannelWithUser();
    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'abc12345678',
        title: 'Test Video',
        channel_id: channel.id,
        storage_key: 'videos/channel/abc12345678.mp4',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.duration_seconds).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannelWithUser();
    await videoRepository.save(
      videoRepository.create({
        slug: 'uniqueslug1',
        title: 'Video 1',
        channel_id: channel.id,
        storage_key: 'videos/c/uniqueslug1.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'uniqueslug1',
          title: 'Video 2',
          channel_id: channel.id,
          storage_key: 'videos/c/uniqueslug1b.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should fail when channel_id does not exist (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'fktest12345',
          title: 'FK Test',
          channel_id: '00000000-0000-0000-0000-000000000000',
          storage_key: 'videos/c/fktest.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should cascade delete videos when channel is deleted', async () => {
    const channel = await createChannelWithUser();
    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'cascade12345',
        title: 'Cascade Video',
        channel_id: channel.id,
        storage_key: 'videos/c/cascade.mp4',
      }),
    );

    await channelRepository.delete({ id: channel.id });

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).toBeNull();
  });

  it('should update status correctly', async () => {
    const channel = await createChannelWithUser();
    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'statusupd123',
        title: 'Status Test',
        channel_id: channel.id,
        storage_key: 'videos/c/status.mp4',
      }),
    );

    video.status = VideoStatus.PROCESSING;
    const updated = await videoRepository.save(video);
    expect(updated.status).toBe(VideoStatus.PROCESSING);
  });
});
