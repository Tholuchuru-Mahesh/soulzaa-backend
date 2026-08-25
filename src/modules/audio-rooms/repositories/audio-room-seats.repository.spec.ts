import { SeatInvitationStatus, SeatRequestStatus } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AudioRoomSeatsRepository } from './audio-room-seats.repository';

const ROOM = 'room-1';

/**
 * `clearSessionStateTx` is the single place that decides which in-room state is
 * session-scoped (wiped when the live ends) and which is durable. The rules are
 * asserted against the emitted Prisma calls because the interesting part is the
 * *where* clause — which rows survive — not the write itself.
 */
describe('AudioRoomSeatsRepository.clearSessionStateTx', () => {
  let prisma: {
    $transaction: jest.Mock;
    premiumAdminSeat: { findMany: jest.Mock };
    roomRole: { deleteMany: jest.Mock; updateMany: jest.Mock };
    roomMember: { updateMany: jest.Mock };
    roomSeat: { updateMany: jest.Mock };
    seatQueueEntry: { deleteMany: jest.Mock };
    seatRequest: { updateMany: jest.Mock };
    seatInvitation: { updateMany: jest.Mock };
    roomSettings: { updateMany: jest.Mock };
  };
  let repo: AudioRoomSeatsRepository;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockResolvedValue([]),
      premiumAdminSeat: { findMany: jest.fn().mockResolvedValue([]) },
      roomRole: { deleteMany: jest.fn(), updateMany: jest.fn() },
      roomMember: { updateMany: jest.fn() },
      roomSeat: { updateMany: jest.fn() },
      seatQueueEntry: { deleteMany: jest.fn() },
      seatRequest: { updateMany: jest.fn() },
      seatInvitation: { updateMany: jest.fn() },
      roomSettings: { updateMany: jest.fn() },
    };
    repo = new AudioRoomSeatsRepository(
      prisma as unknown as PrismaService,
      { del: jest.fn(), get: jest.fn(), set: jest.fn() } as unknown as CacheService,
    );
  });

  describe('persistent role grants', () => {
    it('preserves roomRole grants so admin promotions persist across sessions', async () => {
      await repo.clearSessionStateTx(ROOM);
      expect(prisma.roomRole.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('stage state', () => {
    it('frees every seat and drops the admin lock/mute flags', async () => {
      await repo.clearSessionStateTx(ROOM);

      expect(prisma.roomSeat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ roomId: ROOM }),
          data: { occupantUserId: null, isMuted: false, isLocked: false },
        }),
      );
    });

    it('drops the mic queue', async () => {
      await repo.clearSessionStateTx(ROOM);
      expect(prisma.seatQueueEntry.deleteMany).toHaveBeenCalledWith({ where: { roomId: ROOM } });
    });

    it('cancels pending hand-raises', async () => {
      await repo.clearSessionStateTx(ROOM);

      expect(prisma.seatRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ roomId: ROOM, status: SeatRequestStatus.PENDING }),
          data: expect.objectContaining({ status: SeatRequestStatus.CANCELLED }),
        }),
      );
    });

    it('expires pending speaker invitations', async () => {
      await repo.clearSessionStateTx(ROOM);

      expect(prisma.seatInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ roomId: ROOM, status: SeatInvitationStatus.PENDING }),
          data: expect.objectContaining({ status: SeatInvitationStatus.EXPIRED }),
        }),
      );
    });

    it('lifts a room-wide mute so the next session does not open muted', async () => {
      await repo.clearSessionStateTx(ROOM);

      expect(prisma.roomSettings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roomId: ROOM },
          data: { isRoomMuted: false },
        }),
      );
    });
  });

  it('applies the whole reset atomically', async () => {
    await repo.clearSessionStateTx(ROOM);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(
      // seats, queue, requests, invitations, settings
      5,
    );
  });
});
