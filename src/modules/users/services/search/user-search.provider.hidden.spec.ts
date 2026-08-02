import { PostgresUserSearchProvider } from './user-search.provider';

/**
 * Search is the most direct way an ordinary user could stumble onto a staff
 * account, so the exclusion is the default and opting in is explicit.
 */
describe('PostgresUserSearchProvider — hidden accounts', () => {
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
    userVerification: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const media = { resolve: jest.fn(), resolveMany: jest.fn().mockReturnValue([]) } as any;
  let provider: PostgresUserSearchProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new PostgresUserSearchProvider(prisma, media);
  });

  it('excludes hidden accounts by default', async () => {
    await provider.search('nas', {});
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isHiddenAccount: false }) }),
    );
  });

  it('applies the same exclusion to the total count, so paging stays consistent', async () => {
    await provider.search('nas', {});
    expect(prisma.user.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isHiddenAccount: false }) }),
    );
  });

  it('includes hidden accounts when a privileged caller opts in', async () => {
    await provider.search('nas', { includeHidden: true });
    const { where } = prisma.user.findMany.mock.calls[0][0];
    expect(where.isHiddenAccount).toBeUndefined();
  });

  it('still honours excludeIds alongside the hidden filter', async () => {
    await provider.search('nas', { excludeIds: ['blocked-1'] });
    const { where } = prisma.user.findMany.mock.calls[0][0];
    expect(where.isHiddenAccount).toBe(false);
    expect(where.id).toEqual({ notIn: ['blocked-1'] });
  });
});
