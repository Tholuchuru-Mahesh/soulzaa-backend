import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface GrantGiftLockAccessData {
  userId: string;
  roomId: string;
  sessionId: string;
  giftId: string;
  giftTransactionId: string;
}

@Injectable()
export class VideoRoomGiftLockAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Find gift-lock access for a specific user and broadcast session. */
  async findAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any | null> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomGiftLockAccess.findUnique({
      where: { userId_sessionId: { userId, sessionId } },
    });
  }

  /** Check if a user has active granted gift-lock access for a broadcast session. */
  async hasGrantedAccess(
    userId: string,
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const access = await this.findAccess(userId, sessionId, tx);
    return access !== null && access.status === 'GRANTED';
  }

  /** Grant new gift-lock access entitlement. */
  async grantAccess(
    data: GrantGiftLockAccessData,
    tx?: Prisma.TransactionClient,
  ): Promise<any> {
    const client = tx ?? this.prisma;
    return (client as any).videoRoomGiftLockAccess.create({
      data: {
        userId: data.userId,
        roomId: data.roomId,
        sessionId: data.sessionId,
        giftId: data.giftId,
        giftTransactionId: data.giftTransactionId,
        status: 'GRANTED',
        grantedAt: new Date(),
      },
    });
  }
}
