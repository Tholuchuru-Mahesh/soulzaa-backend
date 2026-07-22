import { Injectable } from '@nestjs/common';
import { Prisma, VideoRoomPkInvitation, VideoRoomPkInvitationStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Db } from './video-room-pk.repository';

/**
 * Persistence for per-invitee PK invitation delivery rows (VR-12).
 *
 * `updateStatus` mirrors `VideoRoomPkRepository.transition`: conditional on
 * the expected `from` status via `updateMany`, reporting a lost race as
 * `null` rather than throwing. `findActionable` is scoped to `SENT` /
 * `DELIVERED` — the only two states a user can still respond from — ordered
 * by `attempt` descending so a retry supersedes its predecessor.
 *
 * No business logic lives here: no FSM validation, no domain exceptions.
 * That belongs to the services that call this repository.
 */
@Injectable()
export class VideoRoomPkInvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.VideoRoomPkInvitationUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkInvitation> {
    return db.videoRoomPkInvitation.create({ data });
  }

  listForBattle(battleId: string, db: Db = this.prisma): Promise<VideoRoomPkInvitation[]> {
    return db.videoRoomPkInvitation.findMany({ where: { battleId } });
  }

  /** The most recent invitation this user can still act on, or null if none. */
  findActionable(
    battleId: string,
    inviteeUserId: string,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkInvitation | null> {
    return db.videoRoomPkInvitation.findFirst({
      where: {
        battleId,
        inviteeUserId,
        status: {
          in: [VideoRoomPkInvitationStatus.SENT, VideoRoomPkInvitationStatus.DELIVERED],
        },
      },
      orderBy: { attempt: 'desc' },
    });
  }

  /**
   * Conditional status transition. Returns the updated row, or null when the
   * invitation was no longer in `from` — another actor (the invitee's
   * response, an expiry sweep) moved it first.
   */
  async updateStatus(
    id: string,
    from: VideoRoomPkInvitationStatus,
    to: VideoRoomPkInvitationStatus,
    patch: Prisma.VideoRoomPkInvitationUpdateInput = {},
    db: Db = this.prisma,
  ): Promise<VideoRoomPkInvitation | null> {
    const { count } = await db.videoRoomPkInvitation.updateMany({
      where: { id, status: from },
      data: { ...patch, status: to },
    });
    if (count === 0) return null;
    return db.videoRoomPkInvitation.findUnique({ where: { id } });
  }

  /** Highest `attempt` sent to this invitee for this battle, or 0 if none yet. */
  async latestAttempt(
    battleId: string,
    inviteeUserId: string,
    db: Db = this.prisma,
  ): Promise<number> {
    const row = await db.videoRoomPkInvitation.findFirst({
      where: { battleId, inviteeUserId },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    return row?.attempt ?? 0;
  }

  /** Invitations still actionable whose `expiresAt` deadline has passed — feeds the expiry sweep. */
  findExpired(now: Date, take: number): Promise<VideoRoomPkInvitation[]> {
    return this.prisma.videoRoomPkInvitation.findMany({
      where: {
        status: {
          in: [VideoRoomPkInvitationStatus.SENT, VideoRoomPkInvitationStatus.DELIVERED],
        },
        expiresAt: { lte: now },
      },
      take,
      orderBy: { expiresAt: 'asc' },
    });
  }
}
