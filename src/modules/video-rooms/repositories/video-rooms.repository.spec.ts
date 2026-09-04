import { HttpStatus } from '@nestjs/common';
import {
  VideoRoomCreationSource,
  VideoRoomLogAction,
  VideoRoomMemberRole,
  VideoRoomSeatType,
  VideoRoomStatus,
  VideoRoomVisibility,
} from '@prisma/client';
import type { CacheService } from 'src/infra/redis/cache.service';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import type { RedisClient } from 'src/infra/redis/redis.constants';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VIDEO_ROOM_DEFAULT_HOST_SEATS, VIDEO_ROOM_TRENDING_KEY } from '../constants/video-room.constants';
import { CreateVideoRoomData, VideoRoomsRepository } from './video-rooms.repository';

/** A tx double whose model methods echo enough to assert on. */
function makeTx() {
  return {
    videoRoom: { create: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }) },
    videoRoomSettings: { create: jest.fn().mockResolvedValue(undefined) },
    videoRoomSeat: { createMany: jest.fn().mockResolvedValue({ count: 10 }) },
    videoRoomStatistics: { create: jest.fn().mockResolvedValue(undefined) },
    videoRoomMember: { create: jest.fn().mockResolvedValue(undefined) },
    videoRoomRole: { create: jest.fn().mockResolvedValue(undefined) },
    videoRoomLog: { create: jest.fn().mockResolvedValue(undefined) },
  };
}

function createData(overrides: Partial<CreateVideoRoomData> = {}): CreateVideoRoomData {
  return {
    ownerId: 'owner',
    name: 'My Room',
    description: null,
    imageKey: null,
    categoryId: null,
    language: null,
    country: null,
    tags: [],
    visibility: VideoRoomVisibility.PUBLIC,
    isLocked: false,
    passwordHash: null,
    isDiscoverable: true,
    maxParticipants: 12,
    maxViewers: 500,
    creationSource: VideoRoomCreationSource.APP,
    ...overrides,
  };
}

describe('VideoRoomsRepository', () => {
  let prisma: any;
  let cache: any;
  let tx: ReturnType<typeof makeTx>;
  let repo: VideoRoomsRepository;

  beforeEach(() => {
    tx = makeTx();
    prisma = {
      videoRoom: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'r1' }),
      },
      videoRoomSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ roomId: 'r1' }),
      },
      videoRoomStatistics: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      videoRoomMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'm1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      videoRoomLog: { create: jest.fn().mockResolvedValue(undefined) },
      videoRoomPresence: {
        upsert: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'owner', username: 'host', fullName: 'Host User' }),
      },
      userProfile: {
        findUnique: jest.fn().mockResolvedValue({ avatarKey: 'avatar.png' }),
      },
      $transaction: jest.fn((arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
    };
    cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      addScore: jest.fn().mockResolvedValue(1),
      sortedRemove: jest.fn().mockResolvedValue(1),
      top: jest.fn().mockResolvedValue([]),
    };
    repo = new VideoRoomsRepository(
      prisma as unknown as PrismaService,
      cache as unknown as CacheService,
      {} as unknown as RedisClient,
    );
  });

  // ---- Existing reads (unchanged behaviour) ----

  it('findById excludes soft-deleted rooms', async () => {
    await repo.findById('r1');
    expect(prisma.videoRoom.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', deletedAt: null },
    });
  });

  it('updateStatus stamps endedAt when moving to ENDED', async () => {
    await repo.updateStatus('r1', VideoRoomStatus.ENDED, 'actor');
    const data = prisma.videoRoom.update.mock.calls[0][0].data;
    expect(data.status).toBe(VideoRoomStatus.ENDED);
    expect(data.endedAt).toBeInstanceOf(Date);
    expect(data.updatedBy).toBe('actor');
  });

  // ---- VR-2 create transaction ----

  it('createRoomTx writes room + settings + statistics + owner member + owner grant + CREATED log', async () => {
    const room = await repo.createRoomTx(createData({ ownerId: 'owner' }));

    expect(room).toEqual({ id: 'r1', ownerId: 'owner' });
    // Room row created with owner audit.
    const roomArg = tx.videoRoom.create.mock.calls[0][0].data;
    expect(roomArg).toMatchObject({ ownerId: 'owner', name: 'My Room', createdBy: 'owner' });
    // Sibling rows keyed by the new room id.
    expect(tx.videoRoomSettings.create).toHaveBeenCalledWith({
      data: { roomId: 'r1', hostSeatCount: VIDEO_ROOM_DEFAULT_HOST_SEATS, guestSeatCount: 0 },
    });
    expect(tx.videoRoomStatistics.create).toHaveBeenCalledWith({ data: { roomId: 'r1' } });
    // Owner membership + authoritative OWNER grant.
    expect(tx.videoRoomMember.create.mock.calls[0][0].data).toMatchObject({
      roomId: 'r1',
      userId: 'owner',
      role: VideoRoomMemberRole.OWNER,
      isActive: true,
    });
    expect(tx.videoRoomRole.create.mock.calls[0][0].data).toMatchObject({
      roomId: 'r1',
      userId: 'owner',
      role: VideoRoomMemberRole.OWNER,
      grantedBy: 'owner',
    });
    // CREATED audit log.
    expect(tx.videoRoomLog.create.mock.calls[0][0].data).toMatchObject({
      roomId: 'r1',
      actorId: 'owner',
      action: VideoRoomLogAction.CREATED,
    });
  });

  it('createRoomTx materialises the declared seat layout (owner + default hosts) in the same tx', async () => {
    await repo.createRoomTx(createData({ ownerId: 'owner' }));

    const arg = tx.videoRoomSeat.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(1 + VIDEO_ROOM_DEFAULT_HOST_SEATS);
    expect(arg.data[0]).toMatchObject({
      roomId: 'r1',
      seatIndex: 0,
      seatType: VideoRoomSeatType.OWNER,
      createdBy: 'owner',
    });
    expect(arg.data.slice(1).map((s: { seatIndex: number }) => s.seatIndex)).toEqual(
      Array.from({ length: VIDEO_ROOM_DEFAULT_HOST_SEATS }, (_, i) => i + 1),
    );
    expect(
      arg.data.slice(1).every((s: { seatType: string }) => s.seatType === VideoRoomSeatType.HOST),
    ).toBe(true);
    // Same counts the settings row declares — one source, so they cannot diverge.
    const settings = tx.videoRoomSettings.create.mock.calls[0][0].data;
    expect(arg.data).toHaveLength(1 + settings.hostSeatCount + settings.guestSeatCount);
  });

  it('createRoomTx persists an explicit metadata payload (access policy)', async () => {
    await repo.createRoomTx(createData({ metadata: { accessPolicy: 'VIP_ONLY' } }));
    const roomArg = tx.videoRoom.create.mock.calls[0][0].data;
    expect(roomArg.metadata).toEqual({ accessPolicy: 'VIP_ONLY' });
  });

  // ---- VR-2 mutations ----

  it('updateRoom stamps auditUpdate and forwards the data', async () => {
    await repo.updateRoom(
      'r1',
      { name: 'New', status: VideoRoomStatus.LIVE, endedAt: null },
      'actor',
    );
    const arg = prisma.videoRoom.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'r1' });
    expect(arg.data).toMatchObject({
      name: 'New',
      status: VideoRoomStatus.LIVE,
      endedAt: null,
      updatedBy: 'actor',
    });
  });

  it('softDelete sets deletedAt and updatedBy', async () => {
    await repo.softDelete('r1', 'actor');
    const data = prisma.videoRoom.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.updatedBy).toBe('actor');
  });

  it('restore clears deletedAt and resets to OFFLINE with no endedAt', async () => {
    await repo.restore('r1', 'actor');
    const data = prisma.videoRoom.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeNull();
    expect(data.status).toBe(VideoRoomStatus.OFFLINE);
    expect(data.endedAt).toBeNull();
    expect(data.updatedBy).toBe('actor');
  });

  it('countActiveByOwner counts only non-deleted rooms for the owner', async () => {
    prisma.videoRoom.count.mockResolvedValue(2);
    const n = await repo.countActiveByOwner('owner');
    expect(n).toBe(2);
    expect(prisma.videoRoom.count).toHaveBeenCalledWith({
      where: { ownerId: 'owner', deletedAt: null },
    });
  });

  it('findDeletedById finds a soft-deleted room for restore', async () => {
    await repo.findDeletedById('r1');
    expect(prisma.videoRoom.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', deletedAt: { not: null } },
    });
  });

  it('findAnyById finds a room regardless of soft-delete (status check)', async () => {
    await repo.findAnyById('r1');
    expect(prisma.videoRoom.findUnique).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });

  it('findManyByIds hydrates non-deleted rooms preserving the id order', async () => {
    prisma.videoRoom.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const rooms = await repo.findManyByIds(['b', 'a']);
    expect(rooms.map((r: any) => r.id)).toEqual(['b', 'a']);
    expect(prisma.videoRoom.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['b', 'a'] }, deletedAt: null },
    });
  });

  it('findManyByIds short-circuits on an empty id list', async () => {
    const rooms = await repo.findManyByIds([]);
    expect(rooms).toEqual([]);
    expect(prisma.videoRoom.findMany).not.toHaveBeenCalled();
  });

  it('findLiveRoomsByIds hydrates LIVE non-deleted rooms preserving the id order', async () => {
    prisma.videoRoom.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const rooms = await repo.findLiveRoomsByIds(['b', 'a']);
    expect(rooms.map((r: any) => r.id)).toEqual(['b', 'a']);
    expect(prisma.videoRoom.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['b', 'a'] }, deletedAt: null, status: VideoRoomStatus.LIVE },
    });
  });

  it('findDetail returns null when the room is missing', async () => {
    prisma.videoRoom.findFirst.mockResolvedValue(null);
    expect(await repo.findDetail('r1')).toBeNull();
  });

  it('findDetail bundles room + settings + statistics', async () => {
    prisma.videoRoom.findFirst.mockResolvedValue({ id: 'r1' });
    prisma.videoRoomSettings.findUnique.mockResolvedValue({ roomId: 'r1', allowChat: true });
    prisma.videoRoomStatistics.findUnique.mockResolvedValue({ roomId: 'r1', peakViewers: 3 });
    const detail = await repo.findDetail('r1');
    expect(detail).toEqual({
      room: { id: 'r1' },
      settings: { roomId: 'r1', allowChat: true },
      statistics: { roomId: 'r1', peakViewers: 3 },
      owner: {
        id: 'owner',
        username: 'host',
        fullName: 'Host User',
        avatarUrl: 'avatar.png',
      },
    });
  });

  // ---- VR-9.1a chat settings write ----

  it('updateSettings forwards the patch verbatim to the settings row', async () => {
    prisma.videoRoomSettings.update.mockResolvedValue({
      roomId: 'r1',
      chatMode: 'PARTICIPANTS_ONLY',
      allowViewerChat: false,
    });

    const result = await repo.updateSettings('r1', {
      chatMode: 'PARTICIPANTS_ONLY' as never,
      allowViewerChat: false,
    });

    expect(prisma.videoRoomSettings.update).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      data: { chatMode: 'PARTICIPANTS_ONLY', allowViewerChat: false },
    });
    expect(result).toEqual({
      roomId: 'r1',
      chatMode: 'PARTICIPANTS_ONLY',
      allowViewerChat: false,
    });
  });

  // ---- settings integrity ----

  describe('requireSettings', () => {
    it('returns the settings row when it exists', async () => {
      const row = { roomId: 'room-1', allowGifts: true } as never;
      prisma.videoRoomSettings.findUnique.mockResolvedValue(row);

      await expect(repo.requireSettings('room-1')).resolves.toBe(row);
    });

    // A missing row is a data-integrity fault, not a policy decision: the row is
    // created transactionally with the room. Reporting it as "feature disabled"
    // would send a host to toggle a setting that cannot fix it.
    it('throws VIDEO_ROOM_SETTINGS_MISSING when the row is absent', async () => {
      prisma.videoRoomSettings.findUnique.mockResolvedValue(null);

      await expect(repo.requireSettings('room-1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    });
  });

  // ---- VR-2 discovery ----

  it('search applies isVerified + accessPolicy(metadata) + ownerId filters', async () => {
    await repo.search({
      skip: 0,
      take: 10,
      discoverableOnly: true,
      isVerified: true,
      accessPolicy: 'VIP_ONLY',
      ownerId: 'owner',
    });
    const where = prisma.videoRoom.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      deletedAt: null,
      isDiscoverable: true,
      isVerified: true,
      ownerId: 'owner',
      metadata: { path: ['accessPolicy'], equals: 'VIP_ONLY' },
    });
  });

  it('popular orders by statistics and preserves that order', async () => {
    prisma.videoRoomStatistics.findMany.mockResolvedValue([{ roomId: 'b' }, { roomId: 'a' }]);
    prisma.videoRoom.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prisma.videoRoom.count.mockResolvedValue(2);

    const res = await repo.popular({ skip: 0, take: 10, discoverableOnly: true });

    expect(prisma.videoRoomStatistics.findMany.mock.calls[0][0].orderBy).toEqual([
      { peakViewers: 'desc' },
      { totalJoins: 'desc' },
    ]);
    expect(res.items.map((r: any) => r.id)).toEqual(['b', 'a']);
    expect(res.total).toBe(2);
  });

  it('popular short-circuits when there are no statistics rows', async () => {
    prisma.videoRoomStatistics.findMany.mockResolvedValue([]);
    const res = await repo.popular({ skip: 0, take: 10, discoverableOnly: true });
    expect(res).toEqual({ items: [], total: 0 });
    expect(prisma.videoRoom.findMany).not.toHaveBeenCalled();
  });

  // ---- VR-2 trending zset ----

  it('trendingBump increments the room score on the global zset', async () => {
    await repo.trendingBump('r1', 5);
    expect(cache.addScore).toHaveBeenCalledWith(VIDEO_ROOM_TRENDING_KEY, 'r1', 5);
  });

  it('trendingRemove drops a room from the zset', async () => {
    await repo.trendingRemove('r1');
    expect(cache.sortedRemove).toHaveBeenCalledWith(VIDEO_ROOM_TRENDING_KEY, 'r1');
  });

  it('trendingTopIds returns member ids highest-first', async () => {
    cache.top.mockResolvedValue([
      { member: 'r2', score: 9 },
      { member: 'r1', score: 4 },
    ]);
    expect(await repo.trendingTopIds(2)).toEqual(['r2', 'r1']);
    expect(cache.top).toHaveBeenCalledWith(VIDEO_ROOM_TRENDING_KEY, 2);
  });

  // ---- VR-3 member lifecycle + counters ----

  it('upsertActiveMember creates with join context + reactivation update branch', async () => {
    await repo.upsertActiveMember({
      roomId: 'r1',
      userId: 'u1',
      role: VideoRoomMemberRole.VIEWER,
      deviceId: 'd1',
      platform: 'IOS',
      actorId: 'u1',
    });
    const arg = prisma.videoRoomMember.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ roomId_userId: { roomId: 'r1', userId: 'u1' } });
    expect(arg.create).toMatchObject({
      roomId: 'r1',
      userId: 'u1',
      role: VideoRoomMemberRole.VIEWER,
      memberStatus: 'ACTIVE',
      deviceId: 'd1',
      platform: 'IOS',
      isActive: true,
      createdBy: 'u1',
    });
    // Reactivation clears leftAt + flips status back to ACTIVE.
    expect(arg.update).toMatchObject({
      isActive: true,
      leftAt: null,
      memberStatus: 'ACTIVE',
      updatedBy: 'u1',
    });
  });

  it('deactivateMember flips only active rows to LEFT with leftAt', async () => {
    await repo.deactivateMember('r1', 'u1', 'u1');
    const arg = prisma.videoRoomMember.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ roomId: 'r1', userId: 'u1', isActive: true });
    expect(arg.data).toMatchObject({ isActive: false, memberStatus: 'LEFT', updatedBy: 'u1' });
    expect(arg.data.leftAt).toBeInstanceOf(Date);
  });

  it('listActiveMembers pages active members oldest-first', async () => {
    await repo.listActiveMembers('r1', 20, 40);
    expect(prisma.videoRoomMember.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', isActive: true },
      orderBy: { joinedAt: 'asc' },
      take: 20,
      skip: 40,
    });
  });

  it('countActiveMembers counts active rows', async () => {
    prisma.videoRoomMember.count.mockResolvedValue(7);
    expect(await repo.countActiveMembers('r1')).toBe(7);
    expect(prisma.videoRoomMember.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', isActive: true },
    });
  });

  it('listActiveMembersExcluding pages active members excluding given user ids', async () => {
    await repo.listActiveMembersExcluding('r1', ['a', 'b'], 20, 0);
    expect(prisma.videoRoomMember.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', isActive: true, userId: { notIn: ['a', 'b'] } },
      orderBy: { joinedAt: 'asc' },
      take: 20,
      skip: 0,
    });
  });

  it('countActiveMembersExcluding counts active rows excluding given user ids', async () => {
    prisma.videoRoomMember.count.mockResolvedValue(5);
    expect(await repo.countActiveMembersExcluding('r1', ['a', 'b'])).toBe(5);
    expect(prisma.videoRoomMember.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', isActive: true, userId: { notIn: ['a', 'b'] } },
    });
  });

  it('bumpStatsOnJoin increments totals + raises peak via a conditional updateMany', async () => {
    await repo.bumpStatsOnJoin('r1', 12);
    const data = prisma.videoRoomStatistics.update.mock.calls[0][0].data;
    expect(data.totalJoins).toEqual({ increment: 1 });
    expect(data.totalSessions).toEqual({ increment: 1 });
    expect(data.currentViewers).toBe(12);
    expect(prisma.videoRoomStatistics.updateMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', peakViewers: { lt: 12 } },
      data: { peakViewers: 12 },
    });
  });

  it('bumpStatsOnLeave sets the live viewer count', async () => {
    await repo.bumpStatsOnLeave('r1', 3);
    const data = prisma.videoRoomStatistics.update.mock.calls[0][0].data;
    expect(data.currentViewers).toBe(3);
    expect(data.lastActivityAt).toBeInstanceOf(Date);
  });

  it('setParticipantStats sets current + conditional peak', async () => {
    await repo.setParticipantStats('r1', 4);
    expect(prisma.videoRoomStatistics.update).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      data: { currentParticipants: 4, lastActivityAt: expect.any(Date) },
    });
    expect(prisma.videoRoomStatistics.updateMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', peakParticipants: { lt: 4 } },
      data: { peakParticipants: 4 },
    });
  });

  it('bumpChatMessageCount increments the lifetime chat counter', async () => {
    await repo.bumpChatMessageCount('r1');
    expect(prisma.videoRoomStatistics.update).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      data: { totalChatMessages: { increment: 1 }, lastActivityAt: expect.any(Date) },
    });
  });

  // ---- VR-5 media engine writes ----

  it('setZegoRoomId writes the handle + audit', async () => {
    prisma.videoRoom.update.mockResolvedValue({ id: 'r1' } as never);
    await repo.setZegoRoomId('r1', 'zego-123', 'actor');
    expect(prisma.videoRoom.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ zegoRoomId: 'zego-123' }),
      }),
    );
  });

  it('setStreamingStatus writes the projection', async () => {
    prisma.videoRoom.update.mockResolvedValue({ id: 'r1' } as never);
    await repo.setStreamingStatus('r1', 'PUBLISHING' as never, 'actor');
    expect(prisma.videoRoom.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ streamingStatus: 'PUBLISHING' }) }),
    );
  });
});
