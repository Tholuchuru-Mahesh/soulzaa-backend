import { Injectable } from '@nestjs/common';
import { CoinFace, CoinFlip, DiceRoll, Prisma, RandomPick, RandomPickPool } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for the one-shot interactive tools: dice rolls, coin flips and
 * random picks. Each row is an immutable record of a server-decided outcome.
 */
@Injectable()
export class InteractiveToolsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Dice ----

  createDiceRoll(data: {
    roomId: string;
    userId: string;
    diceCount: number;
    values: number[];
    total: number;
  }): Promise<DiceRoll> {
    return this.prisma.diceRoll.create({ data });
  }

  listDiceHistory(roomId: string, skip: number, take: number): Promise<[DiceRoll[], number]> {
    const where: Prisma.DiceRollWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.diceRoll.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.diceRoll.count({ where }),
    ]);
  }

  // ---- Coin flip ----

  createCoinFlip(data: { roomId: string; userId: string; result: CoinFace }): Promise<CoinFlip> {
    return this.prisma.coinFlip.create({ data });
  }

  listCoinHistory(roomId: string, skip: number, take: number): Promise<[CoinFlip[], number]> {
    const where: Prisma.CoinFlipWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.coinFlip.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.coinFlip.count({ where }),
    ]);
  }

  // ---- Random pick ----

  createRandomPick(data: {
    roomId: string;
    userId: string;
    pool: RandomPickPool;
    rangeMin: number | null;
    rangeMax: number | null;
    pickedUserId: string | null;
    pickedNumber: number | null;
  }): Promise<RandomPick> {
    return this.prisma.randomPick.create({ data });
  }

  listPickHistory(roomId: string, skip: number, take: number): Promise<[RandomPick[], number]> {
    const where: Prisma.RandomPickWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.randomPick.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.randomPick.count({ where }),
    ]);
  }
}
