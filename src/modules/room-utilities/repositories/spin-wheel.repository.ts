import { Injectable } from '@nestjs/common';
import { Prisma, SpinResult, SpinWheel, SpinWheelStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for spin wheels: host-defined wheels (with a `segments` JSON) and
 * the immutable spin-result ledger.
 */
@Injectable()
export class SpinWheelRepository {
  constructor(private readonly prisma: PrismaService) {}

  createWheel(data: {
    roomId: string;
    creatorId: string;
    title: string;
    segments: Prisma.InputJsonValue;
  }): Promise<SpinWheel> {
    return this.prisma.spinWheel.create({ data });
  }

  findWheel(wheelId: string): Promise<SpinWheel | null> {
    return this.prisma.spinWheel.findUnique({ where: { id: wheelId } });
  }

  listActiveWheels(roomId: string): Promise<SpinWheel[]> {
    return this.prisma.spinWheel.findMany({
      where: { roomId, status: SpinWheelStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });
  }

  createResult(data: {
    wheelId: string;
    roomId: string;
    userId: string;
    segmentIndex: number;
    segmentLabel: string;
    rewardCoins: bigint | null;
  }): Promise<SpinResult> {
    return this.prisma.spinResult.create({ data });
  }

  async setResultTxn(resultId: string, walletTxnId: string): Promise<void> {
    await this.prisma.spinResult.update({ where: { id: resultId }, data: { walletTxnId } });
  }

  listResults(roomId: string, skip: number, take: number): Promise<[SpinResult[], number]> {
    const where: Prisma.SpinResultWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.spinResult.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.spinResult.count({ where }),
    ]);
  }
}
