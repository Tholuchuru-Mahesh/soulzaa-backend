import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GeographicScopeResolver } from 'src/modules/authorization/services/geographic-scope-resolver.service';
import { MobileWorkforceService } from './mobile-workforce.service';
import { WorkforceScopeService } from './workforce-scope.service';

/**
 * The scope filter is an `OR`. Any query that adds its own `OR` must compose
 * with `AND` rather than spreading, or the second `OR` replaces the first and
 * the scope silently disappears.
 */
describe('MobileWorkforceService scope composition', () => {
  let service: MobileWorkforceService;

  const prisma = {
    user: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    roomReport: { findMany: jest.fn().mockResolvedValue([]) },
    videoRoomReport: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scope = { userScopeFilter: jest.fn(), describeScope: jest.fn() };
  const scopes = { getUserScopes: jest.fn().mockResolvedValue([]) };

  const SCOPE_FILTER = { OR: [{ stateId: 's-ka' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    scope.userScopeFilter.mockResolvedValue(SCOPE_FILTER);
    service = new MobileWorkforceService(
      prisma as unknown as PrismaService,
      scope as unknown as WorkforceScopeService,
      scopes as unknown as GeographicScopeResolver,
    );
  });

  it('keeps the scope filter when a search term is supplied', async () => {
    await service.users('official-1', 'alice');

    const where = prisma.user.findMany.mock.calls[0][0].where;
    // The scope clause must survive alongside the search clause.
    expect(where.AND).toContainEqual(SCOPE_FILTER);
    expect(JSON.stringify(where)).toContain('alice');
  });

  it('applies the scope filter with no search term', async () => {
    await service.users('official-1');

    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([SCOPE_FILTER]);
  });

  it('counts against the same filter it lists with', async () => {
    await service.users('official-1', 'alice');

    const listWhere = prisma.user.findMany.mock.calls[0][0].where;
    const countWhere = prisma.user.count.mock.calls[0][0].where;
    // A count that disagrees with the list produces broken pagination.
    expect(countWhere).toEqual(listWhere);
  });

  it('narrows the moderation queue to reporters in scope', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }, { id: 'u-2' }]);

    await service.moderationQueue('official-1');

    const where = prisma.roomReport.findMany.mock.calls[0][0].where;
    expect(where.reporterId).toEqual({ in: ['u-1', 'u-2'] });
  });

  it('does not filter the moderation queue by reporter when unrestricted', async () => {
    scope.userScopeFilter.mockResolvedValue({});

    await service.moderationQueue('admin-1');

    const where = prisma.roomReport.findMany.mock.calls[0][0].where;
    expect(where.reporterId).toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
