import { Injectable } from '@nestjs/common';
import { Prisma, VideoRoomPkBattle, VideoRoomPkStatus } from '@prisma/client';
import { PKBattleException } from '../exceptions/video-room-pk.exceptions';
import { isPkTerminal, VIDEO_ROOM_PK_TRANSITIONS } from '../constants/video-room-pk.constants';
import { Db, VideoRoomPkRepository } from '../repositories/video-room-pk.repository';

/**
 * The only place a PK battle changes status.
 *
 * Enforcement is doubled on purpose. `assertTransition` checks the declared
 * table and produces a clean domain error; the repository's conditional UPDATE
 * then re-checks at the row, which is what actually settles a race between two
 * pods. The table alone would be advisory; the UPDATE alone would give the
 * client a bare 409 with no explanation of which edge was illegal.
 */
@Injectable()
export class VideoRoomPkStateService {
  constructor(private readonly repo: VideoRoomPkRepository) {}

  assertTransition(from: VideoRoomPkStatus, to: VideoRoomPkStatus): void {
    if (!VIDEO_ROOM_PK_TRANSITIONS[from]?.has(to)) {
      throw new PKBattleException(
        isPkTerminal(from)
          ? `This PK battle has already finished (${from}).`
          : `A PK battle cannot move from ${from} to ${to}.`,
      );
    }
  }

  async transition(
    battleId: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch?: Prisma.VideoRoomPkBattleUpdateInput,
    db?: Db,
  ): Promise<VideoRoomPkBattle> {
    const updated = await this.tryTransition(battleId, from, to, patch, db);
    if (!updated) {
      throw new PKBattleException(
        `The PK battle is no longer ${from}; another action changed it first.`,
      );
    }
    return updated;
  }

  // `async` here is load-bearing even though nothing else in the body awaits:
  // `assertTransition` throws synchronously, and without `async` that throw
  // would escape a `.catch()` chain instead of rejecting the returned promise.
  // `tryTransition`'s whole purpose is "don't throw, return null", which
  // invites `.catch()` chaining from callers such as settlement jobs and the
  // recovery sweep — those run inside BullMQ handlers where an uncaught
  // synchronous exception can take down a worker. Keep this in lockstep with
  // `transition`, which is also `async`, so both siblings share one throw
  // contract for the same illegal-edge input.
  async tryTransition(
    battleId: string,
    from: VideoRoomPkStatus,
    to: VideoRoomPkStatus,
    patch?: Prisma.VideoRoomPkBattleUpdateInput,
    db?: Db,
  ): Promise<VideoRoomPkBattle | null> {
    this.assertTransition(from, to);
    return await this.repo.transition(battleId, from, to, patch, db);
  }
}
