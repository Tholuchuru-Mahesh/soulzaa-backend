import { VideoRoomSeatRequestStatus, VideoRoomSeatStatus, VideoRoomSeatType } from '@prisma/client';
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
    });
  });

  it('getSeatLayout falls back to platform defaults when settings are absent', async () => {
    prisma.videoRoomSettings.findUnique.mockResolvedValueOnce(null);
    const layout = await repo.getSeatLayout('r1');
    expect(layout.hostSeatCount).toBe(9);
    expect(layout.guestSeatCount).toBe(0);
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
