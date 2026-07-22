import { Injectable, OnModuleInit } from '@nestjs/common';
import { VipLevel } from '@prisma/client';
import { vipOrdinal } from 'src/modules/vip/constants/vip.constants';
import { VideoRoomPkRepository } from '../../repositories/video-room-pk.repository';
import type { IPkScoreStrategy, PkScoreContext } from '../video-room-pk-score.engine';
import { VideoRoomPkScoreEngine } from '../video-room-pk-score.engine';

/**
 * VIP tier bonus for the sender of a PK gift leg (VR-12 Task 11).
 *
 * Reads the sender's VIP status through `VideoRoomPkRepository.getVipStatus`,
 * forwarding `ctx.db` — the transaction client the gift's own money movement
 * is running under — rather than reading through `VipRepository` (whose
 * methods always bind to the module-level `PrismaService`, never a
 * caller-supplied client) or Redis. The gift seam forbids Redis inside
 * `onSend`, and this call happens inside the gift's transaction, so reading
 * anywhere but `ctx.db` risks a snapshot of the database from outside that
 * transaction. No Prisma delegate calls live in this service directly: all
 * database access goes through the repository.
 *
 * VIP (VR-7, `prisma/schema/vip.prisma`) has no subscription/expiry concept:
 * `VipStatus` is a permanent, denormalised projection of lifetime recharge, one
 * row per user, defaulting to `NONE`. There is therefore no "active" flag to
 * check — "active VIP" just means `level !== NONE` — and no ready-made integer
 * "tier level" column either. `vipOrdinal()` (`src/modules/vip/constants/
 * vip.constants.ts`) is the most defensible mapping available: it is the same
 * helper `VipService.getLevelOrdinal` uses to compare a user's tier against a
 * gift's `minVipLevel` and an event's `minVipLevel` gate, giving NONE=0 …
 * TITAN=7. A user with no `VipStatus` row at all (never recharged) reads back
 * `null`, which is treated as `NONE` — ordinal 0, bonus 0 — so "no active VIP"
 * falls out of the same formula rather than needing a separate branch.
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
    const status = await this.repo.getVipStatus(ctx.senderId, ctx.db);
    const level = status?.level ?? VipLevel.NONE;
    return vipOrdinal(level) * ctx.snapshot.vipBonusBpsPerTier;
  }
}
