import { AgencyMemberActivityService } from './agency-member-activity.service';

/**
 * The rules these cover: nothing is read before membership is proven, and the
 * six sources are merged before they are paged rather than after.
 */
describe('AgencyMemberActivityService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function at(day: number, hour = 0): Date {
    return new Date(Date.UTC(2026, 7, day, hour));
  }

  function build(
    rows: {
      logins?: any[];
      sent?: any[];
      received?: any[];
      audio?: any[];
      video?: any[];
      events?: any[];
    } = {},
  ) {
    const prisma: any = {
      sessionHistory: { findMany: jest.fn().mockResolvedValue(rows.logins ?? []) },
      giftTransaction: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(where.senderId ? (rows.sent ?? []) : (rows.received ?? [])),
          ),
      },
      roomMember: { findMany: jest.fn().mockResolvedValue(rows.audio ?? []) },
      videoRoomMember: { findMany: jest.fn().mockResolvedValue(rows.video ?? []) },
      eventParticipant: { findMany: jest.fn().mockResolvedValue(rows.events ?? []) },
    };
    const members = { assertMember: jest.fn().mockResolvedValue({ effectiveFrom: at(1) }) };
    const service = new AgencyMemberActivityService(prisma, members as never);
    return { service, prisma, members };
  }

  it('proves membership before reading any activity', async () => {
    const { service, prisma, members } = build();
    members.assertMember.mockRejectedValue(new Error('not a member'));

    await expect(service.getActivity(AGENCY, MEMBER)).rejects.toThrow('not a member');
    expect(prisma.sessionHistory.findMany).not.toHaveBeenCalled();
  });

  it('merges all six sources into one timeline, newest first', async () => {
    const { service } = build({
      logins: [{ id: 'l1', createdAt: at(3, 9) }],
      sent: [{ id: 'g1', createdAt: at(3, 11), totalCoinValue: BigInt(500) }],
      audio: [{ id: 'a1', joinedAt: at(3, 10) }],
      video: [{ id: 'v1', joinedAt: at(3, 12) }],
      received: [{ id: 'g2', createdAt: at(3, 8), totalCoinValue: BigInt(100) }],
      events: [{ id: 'e1', joinedAt: at(3, 7), event: { name: 'Quiz challenge' } }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.timeline.items.map((i) => i.kind)).toEqual([
      'VIDEO_ROOM_JOINED',
      'GIFT_SENT',
      'ROOM_JOINED',
      'LOGIN',
      'GIFT_RECEIVED',
      'EVENT_JOINED',
    ]);
  });

  it('reverses the order on sort=oldest', async () => {
    const { service } = build({
      logins: [{ id: 'l1', createdAt: at(1) }],
      sent: [{ id: 'g1', createdAt: at(5), totalCoinValue: BigInt(1) }],
    });

    const result = await service.getActivity(AGENCY, MEMBER, { sort: 'oldest' });

    expect(result.timeline.items.map((i) => i.id)).toEqual(['l1', 'g1']);
  });

  it('pages the merged list, not each source separately', async () => {
    // Trimming per source before merging would drop the newest entries of a
    // busy source in favour of older entries of a quiet one.
    const { service } = build({
      logins: Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, createdAt: at(i + 1) })),
      sent: Array.from({ length: 5 }, (_, i) => ({
        id: `g${i}`,
        createdAt: at(i + 10),
        totalCoinValue: BigInt(1),
      })),
    });

    const result = await service.getActivity(AGENCY, MEMBER, { page: 1, limit: 3 });

    expect(result.timeline.items.map((i) => i.id)).toEqual(['g4', 'g3', 'g2']);
    expect(result.timeline.total).toBe(10);
    expect(result.timeline.totalPages).toBe(4);
  });

  it('counts distinct login days and totals the five counters', async () => {
    const { service } = build({
      logins: [
        { id: 'l1', createdAt: at(3, 9) },
        { id: 'l2', createdAt: at(3, 18) },
        { id: 'l3', createdAt: at(4, 9) },
      ],
      sent: [{ id: 'g1', createdAt: at(3), totalCoinValue: BigInt(1) }],
      events: [{ id: 'e1', joinedAt: at(3), event: { name: 'Quiz' } }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.counters.loginDays).toBe(2);
    expect(result.counters.giftsSent).toBe(1);
    expect(result.counters.eventsJoined).toBe(1);
    // 2 login days + 1 sent + 0 received + 0 rooms + 1 event
    expect(result.counters.totalActivities).toBe(4);
  });

  it('defaults to the last 30 days and passes the window to every source', async () => {
    const { service, prisma } = build();

    const result = await service.getActivity(AGENCY, MEMBER);

    const spanMs = result.range.to.getTime() - result.range.from.getTime();
    expect(Math.round(spanMs / 86_400_000)).toBe(30);
    expect(prisma.sessionHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: result.range.from, lt: result.range.to },
        }),
      }),
    );
  });

  it('honours an explicit date range', async () => {
    const { service } = build();

    const result = await service.getActivity(AGENCY, MEMBER, { from: at(1), to: at(3) });

    expect(result.range.from).toEqual(at(1));
    expect(result.range.to).toEqual(at(3));
  });

  it('describes a gift with its coin value, as a string', async () => {
    const { service } = build({
      sent: [{ id: 'g1', createdAt: at(3), totalCoinValue: BigInt('9007199254740993') }],
    });

    const result = await service.getActivity(AGENCY, MEMBER);

    expect(result.timeline.items[0].detail).toContain('9007199254740993');
  });
});
