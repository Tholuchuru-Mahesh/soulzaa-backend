import { Injectable } from '@nestjs/common';
import {
  LuckyPacket,
  LuckyPacketClaim,
  LuckyPacketDistribution,
  LuckyPacketStatus,
  Prisma,
  WalletCurrency,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for lucky packets: the funded packet rows and the append-only
 * claim ledger. Pure persistence — share computation, wallet movement and
 * locking live in the service. The claim insert + packet decrement run in one
 * `$transaction` so a slot can never be over-drawn; the `(packetId, userId)`
 * unique constraint is the authoritative duplicate-claim guard.
 */
@Injectable()
export class LuckyPacketRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    roomId: string;
    creatorId: string;
    currency: WalletCurrency;
    totalCoins: bigint;
    winnerCount: number;
    distribution: LuckyPacketDistribution;
    message: string | null;
    debitTxnId: string | null;
    expiresAt: Date;
  }): Promise<LuckyPacket> {
    return this.prisma.luckyPacket.create({
      data: {
        roomId: data.roomId,
        creatorId: data.creatorId,
        currency: data.currency,
        totalCoins: data.totalCoins,
        winnerCount: data.winnerCount,
        distribution: data.distribution,
        message: data.message,
        status: LuckyPacketStatus.ACTIVE,
        remainingCoins: data.totalCoins,
        remainingSlots: data.winnerCount,
        debitTxnId: data.debitTxnId,
        expiresAt: data.expiresAt,
      },
    });
  }

  findById(id: string): Promise<LuckyPacket | null> {
    return this.prisma.luckyPacket.findUnique({ where: { id } });
  }

  findActiveByRoom(roomId: string): Promise<LuckyPacket[]> {
    return this.prisma.luckyPacket.findMany({
      where: { roomId, status: LuckyPacketStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
  }

  countClaims(packetId: string): Promise<number> {
    return this.prisma.luckyPacketClaim.count({ where: { packetId } });
  }

  /**
   * Insert the claim and decrement the packet atomically. Throws Prisma P2002 if
   * the user already claimed this packet (the caller maps it to ALREADY_CLAIMED).
   */
  async applyClaim(input: {
    packetId: string;
    roomId: string;
    userId: string;
    amount: bigint;
    complete: boolean;
  }): Promise<{ claim: LuckyPacketClaim; packet: LuckyPacket }> {
    const [claim, packet] = await this.prisma.$transaction([
      this.prisma.luckyPacketClaim.create({
        data: {
          packetId: input.packetId,
          roomId: input.roomId,
          userId: input.userId,
          amount: input.amount,
        },
      }),
      this.prisma.luckyPacket.update({
        where: { id: input.packetId },
        data: {
          remainingCoins: { decrement: input.amount },
          remainingSlots: { decrement: 1 },
          ...(input.complete
            ? { status: LuckyPacketStatus.COMPLETED, completedAt: new Date() }
            : {}),
        },
      }),
    ]);
    return { claim, packet };
  }

  async setClaimTxn(claimId: string, walletTxnId: string): Promise<void> {
    await this.prisma.luckyPacketClaim.update({
      where: { id: claimId },
      data: { walletTxnId },
    });
  }

  findClaim(packetId: string, userId: string): Promise<LuckyPacketClaim | null> {
    return this.prisma.luckyPacketClaim.findUnique({
      where: { packetId_userId: { packetId, userId } },
    });
  }

  listClaims(
    packetId: string,
    skip: number,
    take: number,
    userId?: string,
  ): Promise<[LuckyPacketClaim[], number]> {
    const where: Prisma.LuckyPacketClaimWhereInput = {
      packetId,
      ...(userId ? { userId } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.luckyPacketClaim.findMany({
        where,
        skip,
        take,
        orderBy: { amount: 'desc' },
      }),
      this.prisma.luckyPacketClaim.count({ where }),
    ]);
  }

  listHistory(roomId: string, skip: number, take: number): Promise<[LuckyPacket[], number]> {
    const where: Prisma.LuckyPacketWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.luckyPacket.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.luckyPacket.count({ where }),
    ]);
  }

  /** ACTIVE packets whose claim window has elapsed (for the expiry sweep). */
  findExpired(now: Date, limit: number): Promise<LuckyPacket[]> {
    return this.prisma.luckyPacket.findMany({
      where: { status: LuckyPacketStatus.ACTIVE, expiresAt: { lte: now } },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
  }

  async markStatus(id: string, status: LuckyPacketStatus): Promise<void> {
    await this.prisma.luckyPacket.update({
      where: { id },
      data: { status, completedAt: new Date() },
    });
  }
}
