import { AgencyMemberPerformanceService } from './agency-member-performance.service';

describe('AgencyMemberPerformanceService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  const RANKED = new Map([
    [
      MEMBER,
      {
        userId: MEMBER,
        score: 72,
        rank: 7,
        totalMembers: 7541,
        topPercent: 1,
        grade: { min: 60, code: 'GOOD', label: 'Good', caption: 'nearly there' },
        inputs: { loginDays: 12, roomsJoined: 18, giftsSent: 50, giftsReceived: 50 },
      },
    ],
  ]);

  function build(overrides: Record<string, unknown> = {}) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue([]) },
      roomMember: { findMany: jest.fn().mockResolvedValue([]) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue([]) },
      giftTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: new Date() }) };
    const scores = { rankAgency: jest.fn().mockResolvedValue(RANKED) };
    const service = new AgencyMemberPerformanceService(prisma, members as never, scores as never);
    return { service, prisma, members, scores };
  }

  it('proves membership before reading anything', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getPerformance(AGENCY, MEMBER, 'month')).rejects.toThrow('not a member');
    expect(prisma.sessionHistory.findMany).not.toHaveBeenCalled();
  });

  it('carries rank, grade and engagement from the ranking', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.rank).toEqual({ position: 7, totalMembers: 7541, topPercent: 1 });
    expect(result.grade.code).toBe('GOOD');
    expect(result.engagement).toEqual({ score: 72, outOf: 100, topPercent: 1 });
  });

  it('plots one point per day for each range', async () => {
    const { service } = build();

    expect((await service.getPerformance(AGENCY, MEMBER, 'week')).chart.points).toHaveLength(7);
    expect((await service.getPerformance(AGENCY, MEMBER, 'month')).chart.points).toHaveLength(30);
    expect((await service.getPerformance(AGENCY, MEMBER, 'quarter')).chart.points).toHaveLength(90);
  });

  it('keeps every chart point on the 0-100 axis', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    for (const point of result.chart.points) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(100);
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('reads far enough back that the first rolling points have a full window', async () => {
    // A 7-day range needs 6 warm-up days before it, or its first point is
    // scored against a window that is mostly missing.
    const { service, prisma } = build();

    await service.getPerformance(AGENCY, MEMBER, 'week');

    const where = prisma.sessionHistory.findMany.mock.calls[0][0].where;
    const spanDays = Math.round(
      (where.createdAt.lt.getTime() - where.createdAt.gte.getTime()) / 86_400_000,
    );
    expect(spanDays).toBeGreaterThanOrEqual(13);
  });

  it('returns the four detail metrics as whole percentages of the window', async () => {
    const { service } = build();

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.metrics.map((m) => m.key)).toEqual([
      'ENGAGEMENT_RATE',
      'VIDEO_ROOM',
      'AUDIO_ROOM',
      'DAYS_ACTIVE',
    ]);
    // Engagement rate is the score itself, so the two can never disagree.
    expect(result.metrics[0].percent).toBe(72);
    for (const metric of result.metrics) {
      expect(metric.percent).toBeGreaterThanOrEqual(0);
      expect(metric.percent).toBeLessThanOrEqual(100);
    }
  });

  it('derives days-active from distinct login days over the 30-day window', async () => {
    // 12 distinct days inside the last 30 is 40%.
    const now = Date.now();
    const logins = Array.from({ length: 12 }, (_, i) => ({
      id: `l${i}`,
      createdAt: new Date(now - i * 86_400_000),
    }));
    const { service } = build({
      sessionHistory: { findMany: jest.fn().mockResolvedValue(logins) },
    });

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.metrics.find((m) => m.key === 'DAYS_ACTIVE')!.percent).toBe(40);
  });

  it('returns nulls rather than inventing a rank for an unranked member', async () => {
    const { service, scores } = build();
    scores.rankAgency.mockResolvedValue(new Map());

    const result = await service.getPerformance(AGENCY, MEMBER, 'month');

    expect(result.rank).toBeNull();
    expect(result.engagement.score).toBe(0);
  });
});
