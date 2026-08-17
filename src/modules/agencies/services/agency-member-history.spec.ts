import { AgencyMemberHistoryService } from './agency-member-history.service';

describe('AgencyMemberHistoryService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function build(rewards: any[] = [], events: any[] = []) {
    const prisma: any = {
      agencyRewardDistribution: {
        findMany: jest.fn().mockResolvedValue(rewards),
        count: jest.fn().mockResolvedValue(rewards.length),
      },
      eventParticipant: {
        findMany: jest.fn().mockResolvedValue(events),
        count: jest.fn().mockResolvedValue(events.length),
      },
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: new Date() }) };
    const service = new AgencyMemberHistoryService(prisma, members as never);
    return { service, prisma, members };
  }

  it('proves membership before reading rewards', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getRewards(AGENCY, MEMBER)).rejects.toThrow('not a member');
    expect(prisma.agencyRewardDistribution.findMany).not.toHaveBeenCalled();
  });

  it("shows only the rewards this agency sent, never another agency's", async () => {
    // An agency must not learn what a rival gave the same member.
    const { service, prisma } = build();

    await service.getRewards(AGENCY, MEMBER);

    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agencyId: AGENCY, recipientId: MEMBER },
      }),
    );
  });

  it('maps a reward to its screen shape', async () => {
    const { service } = build([
      {
        id: 'r1',
        name: 'Premium medal',
        itemType: 'MEDAL',
        kind: 'ASSIGNED',
        note: 'For top performance',
        quantity: 1,
        createdAt: new Date('2026-06-20T00:00:00Z'),
      },
    ]);

    const result = await service.getRewards(AGENCY, MEMBER);

    expect(result.items[0]).toEqual({
      id: 'r1',
      name: 'Premium medal',
      itemType: 'MEDAL',
      kind: 'ASSIGNED',
      note: 'For top performance',
      quantity: 1,
      receivedAt: new Date('2026-06-20T00:00:00Z'),
    });
  });

  it('reports an event as completed only when it actually completed', async () => {
    const { service } = build(
      [],
      [
        {
          eventId: 'e1',
          status: 'PARTICIPATING',
          completedAt: null,
          event: {
            name: 'Quiz challenge',
            thumbnail: 'q.png',
            startTime: new Date('2026-05-21T18:10:00Z'),
          },
        },
        {
          eventId: 'e2',
          status: 'PARTICIPATING',
          completedAt: new Date('2026-05-20T14:00:00Z'),
          event: {
            name: 'Singing battle',
            thumbnail: null,
            startTime: new Date('2026-05-20T14:00:00Z'),
          },
        },
      ],
    );

    const result = await service.getEvents(AGENCY, MEMBER);

    expect(result.items[0].status).toBe('PARTICIPATING');
    expect(result.items[1].status).toBe('COMPLETED');
    expect(result.items[1].thumbnailUrl).toBeNull();
  });

  it('pages both lists', async () => {
    const { service, prisma } = build();
    prisma.agencyRewardDistribution.count.mockResolvedValue(45);

    const result = await service.getRewards(AGENCY, MEMBER, { page: 2, limit: 20 });

    expect(result.page).toBe(2);
    expect(result.total).toBe(45);
    expect(result.totalPages).toBe(3);
    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
  });

  it('clamps an absurd page size', async () => {
    const { service, prisma } = build();

    await service.getRewards(AGENCY, MEMBER, { limit: 100_000 });

    expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});
