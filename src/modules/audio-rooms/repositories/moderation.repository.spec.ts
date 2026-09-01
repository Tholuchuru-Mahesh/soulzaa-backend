import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { RedisClient } from 'src/infra/redis/redis.constants';
import { ModerationRepository } from './moderation.repository';

describe('ModerationRepository.resolveUserSummaries', () => {
  let prisma: any;
  let repo: ModerationRepository;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn() },
      userProfile: { findMany: jest.fn() },
    };
    const redis = {
      sadd: jest.fn(),
      srem: jest.fn(),
      sismember: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      get: jest.fn(),
    } as unknown as RedisClient;
    repo = new ModerationRepository(prisma as unknown as PrismaService, redis);
  });

  it('returns empty map if userIds is empty', async () => {
    const result = await repo.resolveUserSummaries([]);
    expect(result.size).toBe(0);
  });

  it('sanitizes email addresses to clean username handles without @domain', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-1', username: 'alice@example.com', fullName: null, email: 'alice@example.com' },
      { id: 'u-2', username: 'bob', fullName: 'Bob Builder', email: 'bob@example.com' },
      { id: 'u-3', username: null, fullName: null, email: 'charlie@example.com' },
    ]);
    prisma.userProfile.findMany.mockResolvedValue([
      { userId: 'u-1', avatarKey: 'avatars/a.png' },
      { userId: 'u-2', avatarKey: null },
    ]);

    const result = await repo.resolveUserSummaries(['u-1', 'u-2', 'u-3']);
    expect(result.get('u-1')).toEqual({
      username: 'alice',
      avatarKey: 'avatars/a.png',
    });
    expect(result.get('u-2')).toEqual({
      username: 'Bob Builder',
      avatarKey: null,
    });
    expect(result.get('u-3')).toEqual({
      username: 'charlie',
      avatarKey: null,
    });
  });
});
