// src/modules/platform-moderation/repositories/platform-ban.repository.ts
import { Injectable } from '@nestjs/common';
import { PlatformBanStatus, PlatformRoomType, PlatformUserBan } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreatePlatformBanInput {
  targetUserId: string;
  moderatorId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
  reportId?: string | null;
  expiresAt: Date;
}

export interface ListPlatformBansFilter {
  status?: PlatformBanStatus;
  targetUserId?: string;
}

@Injectable()
export class PlatformBanRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePlatformBanInput): Promise<PlatformUserBan> {
    return this.prisma.platformUserBan.create({ data: input });
  }

  findActive(targetUserId: string): Promise<PlatformUserBan | null> {
    return this.prisma.platformUserBan.findFirst({
      where: { targetUserId, status: PlatformBanStatus.ACTIVE },
    });
  }

  /** Every currently-ACTIVE, not-yet-expired ban — used to re-prime the Redis
   * enforcement cache (see PlatformBanReconciliationScheduler). Excludes rows
   * whose `expiresAt` has passed but were never explicitly lifted, since
   * nothing currently sweeps `status` to EXPIRED on a timer. */
  listActive(): Promise<PlatformUserBan[]> {
    return this.prisma.platformUserBan.findMany({
      where: { status: PlatformBanStatus.ACTIVE, expiresAt: { gt: new Date() } },
    });
  }

  findById(id: string): Promise<PlatformUserBan | null> {
    return this.prisma.platformUserBan.findUnique({ where: { id } });
  }

  lift(id: string, liftedBy: string): Promise<PlatformUserBan> {
    return this.prisma.platformUserBan.update({
      where: { id },
      data: { status: PlatformBanStatus.LIFTED, liftedBy, liftedAt: new Date() },
    });
  }

  async list(
    filter: ListPlatformBansFilter,
    skip: number,
    limit: number,
  ): Promise<[PlatformUserBan[], number]> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.targetUserId ? { targetUserId: filter.targetUserId } : {}),
    };
    return Promise.all([
      this.prisma.platformUserBan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { bannedAt: 'desc' },
      }),
      this.prisma.platformUserBan.count({ where }),
    ]);
  }
}
