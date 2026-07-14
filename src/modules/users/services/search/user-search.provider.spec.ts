import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { PostgresUserSearchProvider } from './user-search.provider';

describe('PostgresUserSearchProvider', () => {
  let prisma: {
    user: { findMany: jest.Mock; count: jest.Mock };
    userProfile: { findMany: jest.Mock };
    userStatistics: { findMany: jest.Mock };
    userVerification: { findMany: jest.Mock };
  };
  let media: jest.Mocked<Pick<MediaUrlResolver, 'resolve'>>;
  let provider: PostgresUserSearchProvider;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn(), count: jest.fn() },
      userProfile: { findMany: jest.fn().mockResolvedValue([]) },
      userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
      userVerification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    media = { resolve: jest.fn().mockResolvedValue(null) };
    provider = new PostgresUserSearchProvider(
      prisma as unknown as PrismaService,
      media as unknown as MediaUrlResolver,
    );
  });

  it('builds a case-insensitive active-only query and paginates', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    const result = await provider.search('adi', { page: 2, limit: 10, country: 'IN' });

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.deletedAt).toBeNull();
    expect(where.country).toBe('IN');
    expect(where.OR).toEqual([
      { username: { contains: 'adi', mode: 'insensitive' } },
      { fullName: { contains: 'adi', mode: 'insensitive' } },
    ]);
    expect(prisma.user.findMany.mock.calls[0][0].skip).toBe(10); // (page 2 - 1) * 10
    expect(where.id).toBeUndefined(); // no exclude set → no id filter
    expect(result).toMatchObject({ items: [], total: 0, page: 2, limit: 10 });
  });

  it('applies a notIn filter when excludeIds are given', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await provider.search('adi', { excludeIds: ['b1', 'b2'] });

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ notIn: ['b1', 'b2'] });
  });

  it('omits the notIn filter for an empty exclude set', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await provider.search('adi', { excludeIds: [] });

    expect(prisma.user.findMany.mock.calls[0][0].where.id).toBeUndefined();
  });

  it('hydrates cards with avatar/level/verified for the page', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', username: 'adi', fullName: 'Adi', country: 'IN' },
    ]);
    prisma.user.count.mockResolvedValue(1);
    prisma.userStatistics.findMany.mockResolvedValue([{ userId: 'u1', level: 7, vipLevel: 3 }]);
    prisma.userVerification.findMany.mockResolvedValue([{ userId: 'u1', verified: true }]);
    prisma.userProfile.findMany.mockResolvedValue([{ userId: 'u1', avatarKey: 'k' }]);
    media.resolve.mockResolvedValue('https://cdn/k.jpg');

    const result = await provider.search('adi', {});
    expect(result.items[0]).toMatchObject({
      id: 'u1',
      username: 'adi',
      level: 7,
      vipLevel: 3,
      verified: true,
      avatarUrl: 'https://cdn/k.jpg',
    });
  });
});
