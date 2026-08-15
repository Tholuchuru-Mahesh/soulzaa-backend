import { AgencyTaskService } from './agency-task.service';

/**
 * Task progress is what an agency is judged on, so the properties that matter
 * are that every metric is filtered to the calling agency and to the task's
 * own window, and that a target with nothing to measure reports nothing rather
 * than zero.
 */
describe('AgencyTaskService', () => {
  const AGENCY = 'agency-1';
  const START = new Date('2026-08-01T00:00:00Z');
  const END = new Date('2026-08-31T23:59:59Z');

  function build() {
    const prisma: any = {
      agencyTask: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      agencyRelationship: { count: jest.fn().mockResolvedValue(0) },
      userSession: { findMany: jest.fn().mockResolvedValue([]) },
      coinSellerUserSaleTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { coinAmount: null } }),
      },
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCoinValue: null } }),
      },
      agencyRewardDistribution: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }),
      },
    };
    const community = { getActiveHostIds: jest.fn().mockResolvedValue(['m1', 'm2']) };
    return { service: new AgencyTaskService(prisma, community as never), prisma, community };
  }

  function task(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1',
      title: 'Maintain 50 active users',
      description: null,
      metric: 'ACTIVE_MEMBERS',
      targetValue: BigInt(50),
      periodStart: START,
      periodEnd: END,
      status: 'ACTIVE',
      priority: 'HIGH',
      completedAt: null,
      createdAt: START,
      ...overrides,
    };
  }

  it('measures NEW_MEMBERS against this agency inside the task window', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ metric: 'NEW_MEMBERS', targetValue: BigInt(20) }),
    );
    prisma.agencyRelationship.count.mockResolvedValue(13);

    const res = await service.get(AGENCY, 'task-1');

    // Both filters matter: without the agency it measures the platform,
    // without the window it counts progress made before the target was set.
    expect(prisma.agencyRelationship.count).toHaveBeenCalledWith({
      where: { agencyId: AGENCY, effectiveFrom: { gte: START, lte: END } },
    });
    expect(res.progress).toEqual({ current: '13', target: '20', percent: 65 });
  });

  it('measures COIN_SALES from the agency’s own completed sales', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ metric: 'COIN_SALES', targetValue: BigInt(100000) }),
    );
    prisma.coinSellerUserSaleTransaction.aggregate.mockResolvedValue({
      _sum: { coinAmount: BigInt(25000) },
    });

    const res = await service.get(AGENCY, 'task-1');

    expect(prisma.coinSellerUserSaleTransaction.aggregate.mock.calls[0][0].where).toMatchObject({
      sellerId: AGENCY,
      status: 'COMPLETED',
    });
    expect(res.progress.percent).toBe(25);
  });

  it('reports nothing measurable for a MANUAL task', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(task({ metric: 'MANUAL', targetValue: null }));

    const res = await service.get(AGENCY, 'task-1');

    // Null, not zero: "nothing to measure" and "measured zero" are different
    // statements about an agency.
    expect(res.progress).toEqual({ current: null, target: null, percent: null });
  });

  it('caps progress at 100 when the target is exceeded', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ metric: 'NEW_MEMBERS', targetValue: BigInt(10) }),
    );
    prisma.agencyRelationship.count.mockResolvedValue(45);

    const res = await service.get(AGENCY, 'task-1');

    expect(res.progress.percent).toBe(100);
    expect(res.progress.current).toBe('45');
  });

  it('reads an active task past its deadline as expired', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ periodEnd: new Date('2020-01-01'), status: 'ACTIVE' }),
    );

    const res = await service.get(AGENCY, 'task-1');

    // Derived rather than stored, so an unmet target does not sit as ACTIVE
    // forever waiting for a job to sweep it.
    expect(res.status).toBe('EXPIRED');
  });

  it('does not re-open a completed task whose window has passed', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ periodEnd: new Date('2020-01-01'), status: 'COMPLETED' }),
    );

    const res = await service.get(AGENCY, 'task-1');

    expect(res.status).toBe('COMPLETED');
  });

  it('scopes the detail read to the calling agency', async () => {
    const { service, prisma } = build();

    await expect(service.get(AGENCY, 'task-1')).rejects.toThrow();
    expect(prisma.agencyTask.findFirst).toHaveBeenCalledWith({
      where: { id: 'task-1', agencyId: AGENCY },
    });
  });

  it('measures nothing for a metric it does not recognise', async () => {
    const { service, prisma } = build();
    prisma.agencyTask.findFirst.mockResolvedValue(
      task({ metric: 'SOMETHING_NEW', targetValue: BigInt(10) }),
    );

    const res = await service.get(AGENCY, 'task-1');

    // Better a visible zero than a figure borrowed from the wrong ledger.
    expect(res.progress.current).toBe('0');
  });
});
