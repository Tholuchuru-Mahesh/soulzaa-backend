import { VideoRoomMessageType } from '@prisma/client';
import { VideoRoomChatRepository } from './video-room-chat.repository';

describe('VideoRoomChatRepository', () => {
  let prisma: {
    videoRoomMessage: Record<string, jest.Mock>;
    videoRoomMessagePin: Record<string, jest.Mock>;
    videoRoomChatCursor: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let repo: VideoRoomChatRepository;

  beforeEach(() => {
    prisma = {
      videoRoomMessage: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
      },
      videoRoomMessagePin: {
        create: jest.fn().mockResolvedValue({ id: 'p1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      videoRoomChatCursor: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = new VideoRoomChatRepository(prisma as never);
  });

  it('creates a message with normalised nullable fields', async () => {
    await repo.createMessage({
      roomId: 'r1',
      senderId: 'u1',
      type: VideoRoomMessageType.TEXT,
      content: 'hello',
      mentions: ['u2'],
    });

    expect(prisma.videoRoomMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        roomId: 'r1',
        content: 'hello',
        mentions: ['u2'],
        mentionScope: null,
        replyToId: null,
        forwardedFromId: null,
      }),
    });
  });

  it('hides deleted and recalled rows from non-moderators', async () => {
    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: false });

    const where = prisma.$transaction.mock.calls[0][0];
    expect(prisma.videoRoomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: 'r1', deletedAt: null, recalledAt: null }),
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(where).toBeDefined();
  });

  it('recalled rows stay hidden even for moderators', async () => {
    // Delete is moderator-visible; recall is the sender's unsend and is
    // withheld from EVERYONE, including moderators.
    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: true });

    expect(prisma.videoRoomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: 'r1', recalledAt: null }),
      }),
    );
    expect(prisma.videoRoomMessage.findMany.mock.calls[0][0].where.deletedAt).toBeUndefined();
  });

  it('uses keyset pagination when a before-cursor is supplied', async () => {
    prisma.videoRoomMessage.findUnique.mockResolvedValue({ createdAt: new Date('2026-07-21') });

    await repo.listMessages('r1', { skip: 0, take: 20, includeDeleted: false, before: 'm9' });

    const call = prisma.videoRoomMessage.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ lt: new Date('2026-07-21') });
    // Keyset and offset are mutually exclusive — skip must not be applied.
    expect(call.skip).toBeUndefined();
  });

  it('advances a cursor via upsert', async () => {
    const at = new Date('2026-07-21T10:00:00Z');
    await repo.upsertCursor({ roomId: 'r1', userId: 'u1', readMessageId: 'm5', readAt: at });

    expect(prisma.videoRoomChatCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId_userId: { roomId: 'r1', userId: 'u1' } },
        create: expect.objectContaining({ lastReadMessageId: 'm5', lastReadAt: at }),
        update: expect.objectContaining({ lastReadMessageId: 'm5', lastReadAt: at }),
      }),
    );
  });

  it('lists readers as cursors at or past a message timestamp', async () => {
    const since = new Date('2026-07-21T10:00:00Z');
    await repo.listReaders('r1', since);

    expect(prisma.videoRoomChatCursor.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', lastReadAt: { gte: since } },
    });
  });

  it('deactivates a pin rather than deleting it', async () => {
    await repo.deactivatePin('p1', 'u1');

    expect(prisma.videoRoomMessagePin.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ isActive: false, unpinnedBy: 'u1' }),
    });
  });

  it('counts active pins across every room', async () => {
    prisma.videoRoomMessagePin.count.mockResolvedValue(7);

    await expect(repo.countAllActivePins()).resolves.toBe(7);
    expect(prisma.videoRoomMessagePin.count).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('finds a projected message by announcement id via metadata path', async () => {
    await repo.findByAnnouncementId('r1', 'a1');
    expect(prisma.videoRoomMessage.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        roomId: 'r1',
        metadata: { path: ['announcementId'], equals: 'a1' },
      }),
    });
  });

  // ---- GAP 6 (VR-9.1b): pinnedOnly / announcementsOnly search filters ----

  describe('searchMessages', () => {
    it('restricts to ANNOUNCEMENT-type rows when announcementsOnly is set', async () => {
      await repo.searchMessages('r1', { skip: 0, take: 20, announcementsOnly: true });

      const where = prisma.videoRoomMessage.findMany.mock.calls[0][0].where;
      expect(where.type).toBe(VideoRoomMessageType.ANNOUNCEMENT);
    });

    it('announcementsOnly wins over an explicit conflicting type', async () => {
      await repo.searchMessages('r1', {
        skip: 0,
        take: 20,
        type: VideoRoomMessageType.TEXT,
        announcementsOnly: true,
      });

      const where = prisma.videoRoomMessage.findMany.mock.calls[0][0].where;
      expect(where.type).toBe(VideoRoomMessageType.ANNOUNCEMENT);
    });

    it('restricts to messages with an active pin when pinnedOnly is set', async () => {
      prisma.videoRoomMessagePin.findMany.mockResolvedValue([
        { messageId: 'm1' },
        { messageId: 'm2' },
      ]);

      await repo.searchMessages('r1', { skip: 0, take: 20, pinnedOnly: true });

      expect(prisma.videoRoomMessagePin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roomId: 'r1', isActive: true } }),
      );
      const where = prisma.videoRoomMessage.findMany.mock.calls[0][0].where;
      expect(where.id).toEqual({ in: ['m1', 'm2'] });
    });

    it('returns an empty page (not an unfiltered one) when pinnedOnly has no active pins', async () => {
      prisma.videoRoomMessagePin.findMany.mockResolvedValue([]);

      await repo.searchMessages('r1', { skip: 0, take: 20, pinnedOnly: true });

      const where = prisma.videoRoomMessage.findMany.mock.calls[0][0].where;
      // The classic bug: omitting the filter here would silently return every
      // message instead of none.
      expect(where.id).toEqual({ in: [] });
    });

    it('does not touch the pin table when pinnedOnly is not set', async () => {
      await repo.searchMessages('r1', { skip: 0, take: 20 });

      expect(prisma.videoRoomMessagePin.findMany).not.toHaveBeenCalled();
      const where = prisma.videoRoomMessage.findMany.mock.calls[0][0].where;
      expect(where.id).toBeUndefined();
    });
  });
});
