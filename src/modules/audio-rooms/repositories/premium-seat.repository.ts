import { Injectable } from '@nestjs/common';
import { PremiumAdminSeat, PremiumSeatStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for purchased premium admin seats. */
@Injectable()
export class PremiumSeatRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActive(roomId: string, userId: string): Promise<PremiumAdminSeat | null> {
    return this.prisma.premiumAdminSeat.findFirst({
      where: { roomId, userId, status: PremiumSeatStatus.ACTIVE },
    });
  }

  countActive(roomId: string): Promise<number> {
    return this.prisma.premiumAdminSeat.count({
      where: { roomId, status: PremiumSeatStatus.ACTIVE },
    });
  }

  listActive(roomId: string): Promise<PremiumAdminSeat[]> {
    return this.prisma.premiumAdminSeat.findMany({
      where: { roomId, status: PremiumSeatStatus.ACTIVE },
      orderBy: { purchasedAt: 'desc' },
    });
  }

  getById(id: string): Promise<PremiumAdminSeat | null> {
    return this.prisma.premiumAdminSeat.findUnique({ where: { id } });
  }

  create(data: {
    roomId: string;
    userId: string;
    price: bigint;
    walletTxnId: string | null;
    expiresAt: Date;
  }): Promise<PremiumAdminSeat> {
    return this.prisma.premiumAdminSeat.create({ data });
  }

  async finish(id: string, status: PremiumSeatStatus, revokedBy: string | null): Promise<void> {
    await this.prisma.premiumAdminSeat.update({
      where: { id },
      data: { status, revokedBy, revokedAt: new Date() },
    });
  }

  findExpired(now: Date, take = 200): Promise<PremiumAdminSeat[]> {
    return this.prisma.premiumAdminSeat.findMany({
      where: { status: PremiumSeatStatus.ACTIVE, expiresAt: { lte: now } },
      take,
      orderBy: { expiresAt: 'asc' },
    });
  }

  listUserSeats(userId: string, skip: number, take: number): Promise<[PremiumAdminSeat[], number]> {
    const where: Prisma.PremiumAdminSeatWhereInput = { userId };
    return this.prisma.$transaction([
      this.prisma.premiumAdminSeat.findMany({
        where,
        skip,
        take,
        orderBy: { purchasedAt: 'desc' },
      }),
      this.prisma.premiumAdminSeat.count({ where }),
    ]);
  }
}
