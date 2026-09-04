import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface GrantEntryAccessData {
  userId: string;
  roomId: string;
  sessionId: string;
  transactionId?: string | null;
  amountPaid: bigint;
  creatorEarnings: bigint;
}

@Injectable()
export class VideoRoomEntryAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find entry access for a specific user and broadcast session.
   */
  async findAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any | null> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomEntryAccess.findUnique({
      where: {
        userId_sessionId: {
          userId,
          sessionId,
        },
      },
    });
  }

  /**
   * Check if a user has active granted access for a broadcast session.
   */
  async hasGrantedAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const access = await this.findAccess(userId, sessionId, tx);
    return access !== null && access.status === 'GRANTED';
  }

  /**
   * Grant new entry access entitlement.
   */
  async grantAccess(
    data: GrantEntryAccessData,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomEntryAccess.create({
      data: {
        userId: data.userId,
        roomId: data.roomId,
        sessionId: data.sessionId,
        transactionId: data.transactionId ?? null,
        amountPaid: data.amountPaid,
        creatorEarnings: data.creatorEarnings,
        status: 'GRANTED',
        grantedAt: new Date(),
      },
    });
  }

  /**
   * Count total unique paid entrants for a broadcast session.
   */
  async countPaidEntrants(
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomEntryAccess.count({
      where: {
        sessionId,
        status: 'GRANTED',
      },
    });
  }
}
