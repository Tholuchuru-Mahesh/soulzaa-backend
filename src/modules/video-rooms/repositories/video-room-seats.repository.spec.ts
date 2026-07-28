import {
  VideoRoomInvitationStatus,
  VideoRoomSeatRequestStatus,
  VideoRoomSeatStatus,
  VideoRoomSeatType,
} from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomSeatsRepository } from './video-room-seats.repository';

describe('VideoRoomSeatsRepository', () => {
  let prisma: any;
  let repo: VideoRoomSeatsRepository;

  beforeEach(() => {
    prisma = {
      videoRoomSeat: {
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 's1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      videoRoomSeatRequest: {
        create: jest.fn().mockResolvedValue({ id: 'rq1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({ id: 'rq1' }),
        update: jest.fn().mockResolvedValue({ id: 'rq1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      videoRoomInvitation: {
        create: jest.fn().mockResolvedValue({ id: 'iv1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'iv1' }),
        update: jest.fn().mockResolvedValue({ id: 'iv1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      videoRoomSettings: {
        findUnique: jest.fn().mockResolvedValue({ hostSeatCount: 6, guestSeatCount: 2 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    repo = new VideoRoomSeatsRepository(prisma as unknown as PrismaService);
  });

  it('createLayout batches seats with audit and skips duplicates (idempotent)', async () => {
    const count = await repo.createLayout(
      'r1',
      [
        { seatIndex: 0, seatType: VideoRoomSeatType.OWNER },
        { seatIndex: 1, seatType: VideoRoomSeatType.HOST },
      ],
      'owner',
    );
    const arg = prisma.videoRoomSeat.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toMatchObject({ roomId: 'r1', seatIndex: 0, createdBy: 'owner' });
    expect(count).toBe(3);
  });

  it('createLayout omits the audit stamp for a system backfill (null actor)', async () => {
    await repo.createLayout('r1', [{ seatIndex: 0, seatType: VideoRoomSeatType.OWNER }], null);
    const arg = prisma.videoRoomSeat.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toEqual({ roomId: 'r1', seatIndex: 0, seatType: VideoRoomSeatType.OWNER });
    expect(arg.data[0]).not.toHaveProperty('createdBy');
  });

  it('findSeat keys on the (roomId,seatIndex) unique index', async () => {
    await repo.findSeat('r1', 2);
    expect(prisma.videoRoomSeat.findUnique).toHaveBeenCalledWith({
      where: { roomId_seatIndex: { roomId: 'r1', seatIndex: 2 } },
    });
  });

  it('setRequestStatus stamps resolvedAt + resolvedBy + audit', async () => {
    await repo.setRequestStatus('rq1', VideoRoomSeatRequestStatus.ACCEPTED, 'admin', 'admin');
    const data = prisma.videoRoomSeatRequest.update.mock.calls[0][0].data;
    expect(data.status).toBe(VideoRoomSeatRequestStatus.ACCEPTED);
    expect(data.resolvedBy).toBe('admin');
    expect(data.resolvedAt).toBeInstanceOf(Date);
    expect(data.updatedBy).toBe('admin');
  });

  it('expireStaleRequests only touches PENDING rows past expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const count = await repo.expireStaleRequests(now);
    expect(prisma.videoRoomSeatRequest.updateMany).toHaveBeenCalledWith({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      data: { status: VideoRoomSeatRequestStatus.EXPIRED },
    });
    expect(count).toBe(2);
  });

  it('getSeatLayout reads host/guest counts from settings', async () => {
    await expect(repo.getSeatLayout('r1')).resolves.toEqual({
      hostSeatCount: 6,
      guestSeatCount: 2,
      hasSettings: true,
    });
  });

  it('getSeatLayout falls back to platform defaults when settings are absent', async () => {
    prisma.videoRoomSettings.findUnique.mockResolvedValueOnce(null);
    const layout = await repo.getSeatLayout('r1');
    expect(layout.hostSeatCount).toBe(9);
    expect(layout.guestSeatCount).toBe(0);
    // …and says so, so callers never write seat rows off a defaulted layout.
    expect(layout.hasSettings).toBe(false);
  });

  it('setSeatLayout stamps audit on the settings row', async () => {
    await repo.setSeatLayout('r1', 6, 2, 'owner');
    const data = prisma.videoRoomSettings.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ hostSeatCount: 6, guestSeatCount: 2, updatedBy: 'owner' });
  });

  it('deleteSeatsFrom removes rows at/after the index (layout shrink)', async () => {
    const count = await repo.deleteSeatsFrom('r1', 5);
    expect(prisma.videoRoomSeat.deleteMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', seatIndex: { gte: 5 } },
    });
    expect(count).toBe(4);
  });

  it('findRequestById / findInvitationById delegate to findUnique', async () => {
    await expect(repo.findRequestById('rq1')).resolves.toEqual({ id: 'rq1' });
    await expect(repo.findInvitationById('iv1')).resolves.toEqual({ id: 'iv1' });
  });

  it('resolveAllPendingRequestsForUser only touches that user PENDING rows', async () => {
    await repo.resolveAllPendingRequestsForUser(
      'r1',
      'u1',
      VideoRoomSeatRequestStatus.ACCEPTED,
      'admin',
    );
    const call = prisma.videoRoomSeatRequest.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      roomId: 'r1',
      userId: 'u1',
      status: VideoRoomSeatRequestStatus.PENDING,
    });
    expect(call.data.status).toBe(VideoRoomSeatRequestStatus.ACCEPTED);
  });

  it('isSeatOccupied reflects status + occupant', () => {
    expect(
      repo.isSeatOccupied({
        seatStatus: VideoRoomSeatStatus.OCCUPIED,
        occupantUserId: 'u1',
      } as any),
    ).toBe(true);
    expect(
      repo.isSeatOccupied({
        seatStatus: VideoRoomSeatStatus.EMPTY,
        occupantUserId: null,
      } as any),
    ).toBe(false);
  });
});

describe('VideoRoomSeatsRepository — VR-8 workflow', () => {
  let prisma: any;
  let repo: VideoRoomSeatsRepository;

  beforeEach(() => {
    prisma = {
      videoRoomSeatRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'q1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'q1', status: 'ACCEPTED' }),
      },
      videoRoomInvitation: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'i1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'i1', status: 'PENDING' }),
      },
    };
    repo = new VideoRoomSeatsRepository(prisma);
  });

  it('lists expired requests bounded by the caller-supplied limit', async () => {
    const now = new Date('2026-07-21T10:00:00Z');
    await repo.listExpiredRequests(now, 500);
    expect(prisma.videoRoomSeatRequest.findMany).toHaveBeenCalledWith({
      where: { status: VideoRoomSeatRequestStatus.PENDING, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: 500,
    });
  });

  it('lists expired invitations from both PENDING and DELIVERED', async () => {
    const now = new Date('2026-07-21T10:00:00Z');
    await repo.listExpiredInvitations(now, 500);
    const arg = prisma.videoRoomInvitation.findMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({
      in: [VideoRoomInvitationStatus.PENDING, VideoRoomInvitationStatus.DELIVERED],
    });
    expect(arg.take).toBe(500);
  });

  it('records lastError and bumps attemptCount when asked', async () => {
    await repo.setRequestStatus('q1', VideoRoomSeatRequestStatus.FAILED, 'actor', 'actor', {
      lastError: 'seat taken',
      bumpAttempt: true,
    });
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'q1' });
    expect(arg.data.status).toBe(VideoRoomSeatRequestStatus.FAILED);
    expect(arg.data.lastError).toBe('seat taken');
    expect(arg.data.attemptCount).toEqual({ increment: 1 });
  });

  it('does not touch attemptCount on an ordinary status change', async () => {
    await repo.setRequestStatus('q1', VideoRoomSeatRequestStatus.REJECTED, 'actor', 'actor');
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.attemptCount).toBeUndefined();
    expect(arg.data.lastError).toBeUndefined();
  });

  it('stamps deliveredAt when marking an invitation DELIVERED', async () => {
    const when = new Date('2026-07-21T10:00:00Z');
    await repo.setInvitationStatus('i1', VideoRoomInvitationStatus.DELIVERED, 'u2', {
      deliveredAt: when,
    });
    const arg = prisma.videoRoomInvitation.update.mock.calls[0][0];
    expect(arg.data.deliveredAt).toBe(when);
  });

  it('updates only the preferred seat index, leaving status untouched', async () => {
    await repo.updateRequestSeatIndex('q1', 4, 'u1');
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.seatIndex).toBe(4);
    expect(arg.data.status).toBeUndefined();
  });

  it('restores a request to PENDING without disturbing createdAt', async () => {
    const expiresAt = new Date('2026-07-21T10:05:00Z');
    await repo.restoreRequest('q1', 'u1', expiresAt);
    const arg = prisma.videoRoomSeatRequest.update.mock.calls[0][0];
    expect(arg.data.status).toBe(VideoRoomSeatRequestStatus.PENDING);
    expect(arg.data.expiresAt).toBe(expiresAt);
    expect(arg.data.resolvedAt).toBeNull();
    expect(arg.data.createdAt).toBeUndefined();
  });

  // ---- I6 — compare-and-swap ----

  describe('setRequestStatus — I6 compare-and-swap', () => {
    it('writes unconditionally via `update` when expectedFrom is omitted (unchanged behaviour)', async () => {
      await repo.setRequestStatus('q1', VideoRoomSeatRequestStatus.ACCEPTED, 'actor', 'actor');
      expect(prisma.videoRoomSeatRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.videoRoomSeatRequest.updateMany).not.toHaveBeenCalled();
    });

    it('writes conditionally via `updateMany({ where: { id, status: expectedFrom } })` when given', async () => {
      const updated = await repo.setRequestStatus(
        'q1',
        VideoRoomSeatRequestStatus.ACCEPTED,
        'actor',
        'actor',
        { expectedFrom: VideoRoomSeatRequestStatus.PENDING },
      );
      expect(prisma.videoRoomSeatRequest.update).not.toHaveBeenCalled();
      const call = prisma.videoRoomSeatRequest.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'q1', status: VideoRoomSeatRequestStatus.PENDING });
      expect(call.data.status).toBe(VideoRoomSeatRequestStatus.ACCEPTED);
      // A successful CAS re-reads the row — `updateMany` can't return it —
      // to preserve the "returns the updated entity" contract.
      expect(prisma.videoRoomSeatRequest.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'q1' },
      });
      expect(updated).toEqual({ id: 'q1', status: 'ACCEPTED' });
    });

    it('returns null — without re-reading — when the row was no longer in the expected status', async () => {
      prisma.videoRoomSeatRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      const updated = await repo.setRequestStatus(
        'q1',
        VideoRoomSeatRequestStatus.ACCEPTED,
        'actor',
        'actor',
        { expectedFrom: VideoRoomSeatRequestStatus.PENDING },
      );
      expect(updated).toBeNull();
      expect(prisma.videoRoomSeatRequest.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('setInvitationStatus — I6 compare-and-swap', () => {
    it('writes unconditionally via `update` when expectedFrom is omitted (unchanged behaviour)', async () => {
      await repo.setInvitationStatus('i1', VideoRoomInvitationStatus.PENDING, 'actor');
      expect(prisma.videoRoomInvitation.update).toHaveBeenCalledTimes(1);
      expect(prisma.videoRoomInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('writes conditionally via `updateMany({ where: { id, status: expectedFrom } })` when given', async () => {
      const updated = await repo.setInvitationStatus(
        'i1',
        VideoRoomInvitationStatus.PENDING,
        'actor',
        { expectedFrom: VideoRoomInvitationStatus.FAILED },
      );
      expect(prisma.videoRoomInvitation.update).not.toHaveBeenCalled();
      const call = prisma.videoRoomInvitation.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'i1', status: VideoRoomInvitationStatus.FAILED });
      expect(call.data.status).toBe(VideoRoomInvitationStatus.PENDING);
      expect(prisma.videoRoomInvitation.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'i1' },
      });
      expect(updated).toEqual({ id: 'i1', status: 'PENDING' });
    });

    it('returns null — without re-reading — when the row was no longer in the expected status', async () => {
      prisma.videoRoomInvitation.updateMany.mockResolvedValueOnce({ count: 0 });
      const updated = await repo.setInvitationStatus(
        'i1',
        VideoRoomInvitationStatus.PENDING,
        'actor',
        { expectedFrom: VideoRoomInvitationStatus.FAILED },
      );
      expect(updated).toBeNull();
      expect(prisma.videoRoomInvitation.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });
});
