import { Injectable } from '@nestjs/common';
import { BroadBan, BroadBanStatus, PlatformRoomType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateBroadBanInput {
  roomId: string;
  roomType: PlatformRoomType;
  ownerId: string;
  moderatorId: string;
  reason: string;
  description?: string | null;
  proofUrl?: string | null;
  expiresAt: Date;
}

export interface ListBroadBansFilter {
  status?: BroadBanStatus;
  ownerId?: string;
}

@Injectable()
export class BroadBanRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateBroadBanInput): Promise<BroadBan> {
    return this.prisma.broadBan.create({ data: input });
  }

  findById(id: string): Promise<BroadBan | null> {
    return this.prisma.broadBan.findUnique({ where: { id } });
  }

  lift(id: string, liftedBy: string): Promise<BroadBan> {
    return this.prisma.broadBan.update({
      where: { id },
      data: { status: BroadBanStatus.LIFTED, liftedBy, liftedAt: new Date() },
    });
  }

  extend(id: string, expiresAt: Date): Promise<BroadBan> {
    return this.prisma.broadBan.update({
      where: { id },
      data: { expiresAt },
    });
  }

  async list(
    filter: ListBroadBansFilter,
    skip: number,
    limit: number,
  ): Promise<[BroadBan[], number]> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
    };
    return Promise.all([
      this.prisma.broadBan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { bannedAt: 'desc' },
      }),
      this.prisma.broadBan.count({ where }),
    ]);
  }
}
