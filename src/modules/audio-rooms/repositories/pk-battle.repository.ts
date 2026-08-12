import { Injectable } from '@nestjs/common';
import {
  PkBattle,
  PkMode,
  PkParticipant,
  PkResult,
  PkSide,
  PkStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for PK battles: battle, participants, contribution + reward ledgers. */
@Injectable()
export class PkBattleRepository {
  constructor(private readonly prisma: PrismaService) {}

  getActive(roomId: string): Promise<PkBattle | null> {
    return this.prisma.pkBattle.findFirst({ where: { roomId, status: PkStatus.ACTIVE } });
  }

  getBattle(id: string): Promise<PkBattle | null> {
    return this.prisma.pkBattle.findUnique({ where: { id } });
  }

  createBattle(data: {
    roomId: string;
    mode: PkMode;
    durationSeconds: number;
    startedBy: string;
    endsAt: Date;
  }): Promise<PkBattle> {
    return this.prisma.pkBattle.create({ data });
  }

  createParticipants(
    rows: { battleId: string; roomId: string; userId: string; side: PkSide }[],
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.pkParticipant.createMany({ data: rows });
  }

  listParticipants(battleId: string): Promise<PkParticipant[]> {
    return this.prisma.pkParticipant.findMany({ where: { battleId } });
  }

  findParticipant(battleId: string, userId: string): Promise<PkParticipant | null> {
    return this.prisma.pkParticipant.findUnique({
      where: { battleId_userId: { battleId, userId } },
    });
  }

  /** Apply a contribution: bump the participant + side score and log it, atomically. */
  applyContribution(input: {
    battleId: string;
    roomId: string;
    participantId: string;
    side: PkSide;
    contributorId: string;
    amount: bigint;
    giftTxnId: string | null;
  }): Promise<PkBattle> {
    return this.prisma.$transaction(async (tx) => {
      await tx.pkParticipant.update({
        where: { id: input.participantId },
        data: { score: { increment: input.amount } },
      });
      const battle = await tx.pkBattle.update({
        where: { id: input.battleId },
        data:
          input.side === PkSide.RED
            ? { redScore: { increment: input.amount } }
            : { blueScore: { increment: input.amount } },
      });
      await tx.pkContribution.create({
        data: {
          battleId: input.battleId,
          roomId: input.roomId,
          participantId: input.participantId,
          side: input.side,
          contributorId: input.contributorId,
          amount: input.amount,
          giftTxnId: input.giftTxnId,
        },
      });
      return battle;
    });
  }

  async complete(id: string, result: PkResult): Promise<void> {
    await this.prisma.pkBattle.update({
      where: { id },
      data: { status: PkStatus.COMPLETED, result, completedAt: new Date() },
    });
  }

  async cancel(id: string): Promise<void> {
    await this.prisma.pkBattle.update({
      where: { id },
      data: { status: PkStatus.CANCELLED, completedAt: new Date() },
    });
  }

  findExpired(now: Date, take = 100): Promise<PkBattle[]> {
    return this.prisma.pkBattle.findMany({
      where: { status: PkStatus.ACTIVE, endsAt: { lte: now } },
      take,
      orderBy: { endsAt: 'asc' },
    });
  }

  createReward(data: {
    battleId: string;
    roomId: string;
    userId: string;
    side: PkSide;
    cosmeticId: string | null;
    backpackItemId: string | null;
  }): Promise<void> {
    return this.prisma.pkReward.create({ data }).then(() => undefined);
  }

  listBattles(roomId: string, skip: number, take: number): Promise<[PkBattle[], number]> {
    const where: Prisma.PkBattleWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.pkBattle.findMany({ where, skip, take, orderBy: { startedAt: 'desc' } }),
      this.prisma.pkBattle.count({ where }),
    ]);
  }

  /**
   * Every battle a user has ever participated in, across all rooms, most
   * recent first. No Prisma relation exists between PkParticipant and
   * PkBattle (by design — same-module, id-referenced only), so this is a
   * two-step fetch-then-join rather than a single query; battle counts per
   * user are small (a room feature, not a hot-path table), so this stays
   * cheap. Rows whose battle went missing (should not happen) are dropped.
   */
  async listParticipantBattles(
    userId: string,
  ): Promise<{ participant: PkParticipant; battle: PkBattle }[]> {
    const participants = await this.prisma.pkParticipant.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (participants.length === 0) return [];

    const battles = await this.prisma.pkBattle.findMany({
      where: { id: { in: participants.map((p) => p.battleId) } },
    });
    const battleById = new Map(battles.map((b) => [b.id, b]));

    return participants
      .map((participant) => ({ participant, battle: battleById.get(participant.battleId) }))
      .filter(
        (row): row is { participant: PkParticipant; battle: PkBattle } => row.battle !== undefined,
      );
  }
}
