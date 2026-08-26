import { Injectable, OnModuleInit } from '@nestjs/common';
import { VideoRoomPkRepository } from '../../repositories/video-room-pk.repository';
import type { IPkScoreStrategy, PkScoreContext } from '../video-room-pk-score.engine';
import { VideoRoomPkScoreEngine } from '../video-room-pk-score.engine';

/**
 * Wealth Level bonus for the sender of a PK gift leg (VR-12 Task 11).
 *
 * Reads the sender's effective Wealth Level through
 * `VideoRoomPkRepository.getWealthLevel`, forwarding `ctx.db` — the
 * transaction client the gift's own money movement is running under —
 * rather than reading through the wealth module's own repository (whose
 * methods always bind to the module-level `PrismaService`, never a
 * caller-supplied client) or Redis. The gift seam forbids Redis inside
 * `onSend`, and this call happens inside the gift's transaction, so reading
 * anywhere but `ctx.db` risks a snapshot of the database from outside that
 * transaction. No Prisma delegate calls live in this service directly: all
 * database access goes through the repository.
 *
 * A user with no `WealthUserProgress` row at all (never purchased) reads
 * back level 0 — no active Wealth Level, bonus 0 — so "no bonus" falls out
 * of the same formula rather than needing a separate branch.
 */
@Injectable()
export class VipMultiplierStrategy implements IPkScoreStrategy, OnModuleInit {
  readonly key = 'VIP';

  constructor(
    private readonly engine: VideoRoomPkScoreEngine,
    private readonly repo: VideoRoomPkRepository,
  ) {}

  onModuleInit(): void {
    this.engine.register(this);
  }

  async bonusBps(ctx: PkScoreContext): Promise<number> {
    const level = await this.repo.getWealthLevel(ctx.senderId, ctx.db);
    return level * ctx.snapshot.vipBonusBpsPerTier;
  }
}
