import {
  PremiumSeatStatus,
  RoomMemberRole,
  SeatInvitationStatus,
  SeatRequestStatus,
} from '@prisma/client';
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

  /** The `where` of every call recorded on a given model+op during the run. */
  const wheres = (fn: jest.Mock): Array<Record<string, unknown>> =>
    fn.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);

  const datas = (fn: jest.Mock): Array<Record<string, unknown>> =>
    fn.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

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

  describe('role grants', () => {
    it('deletes every non-OWNER grant so promotions do not survive the session', async () => {
      await repo.clearSessionStateTx(ROOM);

      expect(prisma.roomRole.deleteMany).toHaveBeenCalledTimes(1);
      expect(wheres(prisma.roomRole.deleteMany)[0]).toMatchObject({
        roomId: ROOM,
        role: { not: RoomMemberRole.OWNER },
      });
    });

    it('never deletes the OWNER grant', async () => {
      await repo.clearSessionStateTx(ROOM);
      for (const where of wheres(prisma.roomRole.deleteMany)) {
        expect(where.role).toEqual({ not: RoomMemberRole.OWNER });
      }
    });

    it('spares users holding an unexpired paid premium seat', async () => {
      prisma.premiumAdminSeat.findMany.mockResolvedValue([
        { userId: 'paid-1' },
        { userId: 'paid-2' },
      ]);

      await repo.clearSessionStateTx(ROOM);

      expect(prisma.premiumAdminSeat.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: ROOM,
            status: PremiumSeatStatus.ACTIVE,
            expiresAt: { gt: expect.any(Date) as unknown as Date },
          }),
        }),
      );
      expect(wheres(prisma.roomRole.deleteMany)[0]).toMatchObject({
        userId: { notIn: ['paid-1', 'paid-2'] },
      });
    });

    it('re-pins a paid holder who was also promoted to ADMIN back down to PREMIUM_ADMIN', async () => {
      prisma.premiumAdminSeat.findMany.mockResolvedValue([{ userId: 'paid-1' }]);

      await repo.clearSessionStateTx(ROOM);

      expect(prisma.roomRole.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: ROOM,
            role: { not: RoomMemberRole.OWNER },
            userId: { in: ['paid-1'] },
          }),
          data: expect.objectContaining({ role: RoomMemberRole.PREMIUM_ADMIN }),
        }),
      );
    });

    it('skips the paid-holder re-pin entirely when nobody holds a paid seat', async () => {
      await repo.clearSessionStateTx(ROOM);
      expect(prisma.roomRole.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('RoomMember.role mirror', () => {
    it('resets non-owner members to LISTENER (owner succession reads this column)', async () => {
      await repo.clearSessionStateTx(ROOM);

      const listenerReset = prisma.roomMember.updateMany.mock.calls.find(
        (c) => (c[0] as { data: { role: RoomMemberRole } }).data.role === RoomMemberRole.LISTENER,
      );
      expect(listenerReset).toBeDefined();
      expect((listenerReset?.[0] as { where: Record<string, unknown> }).where).toMatchObject({
        roomId: ROOM,
        role: { not: RoomMemberRole.OWNER },
      });
    });

    it('mirrors PREMIUM_ADMIN for paid holders instead of LISTENER', async () => {
      prisma.premiumAdminSeat.findMany.mockResolvedValue([{ userId: 'paid-1' }]);

      await repo.clearSessionStateTx(ROOM);

      expect(datas(prisma.roomMember.updateMany)).toContainEqual(
        expect.objectContaining({ role: RoomMemberRole.PREMIUM_ADMIN }),
      );
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
      // seats, queue, requests, invitations, role delete, member reset, settings
      7,
    );
  });
});
