import { Injectable } from '@nestjs/common';
import { Prisma, RoomPoll, RoomPollOption, RoomPollStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export type PollWithOptions = RoomPoll & { options: RoomPollOption[] };

/**
 * Data layer for room polls: the poll + its options (with a denormalized
 * `voteCount`) and the append-only vote ledger. The vote insert + tally
 * increment run in one `$transaction`; the `(pollId, userId)` unique constraint
 * is the authoritative duplicate-vote guard.
 */
@Injectable()
export class PollRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPoll(data: {
    roomId: string;
    creatorId: string;
    question: string;
    options: string[];
    endsAt: Date | null;
  }): Promise<PollWithOptions> {
    return this.prisma.roomPoll.create({
      data: {
        roomId: data.roomId,
        creatorId: data.creatorId,
        question: data.question,
        endsAt: data.endsAt,
        options: {
          create: data.options.map((label, i) => ({ label, position: i })),
        },
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });
  }

  findById(pollId: string): Promise<PollWithOptions | null> {
    return this.prisma.roomPoll.findUnique({
      where: { id: pollId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
  }

  listActive(roomId: string): Promise<PollWithOptions[]> {
    return this.prisma.roomPoll.findMany({
      where: { roomId, status: RoomPollStatus.ACTIVE },
      include: { options: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Insert a vote and bump the option tally atomically. Throws P2002 on a dup. */
  async vote(pollId: string, optionId: string, userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.roomPollVote.create({ data: { pollId, optionId, userId } }),
      this.prisma.roomPollOption.update({
        where: { id: optionId },
        data: { voteCount: { increment: 1 } },
      }),
    ]);
  }

  async end(pollId: string): Promise<void> {
    await this.prisma.roomPoll.update({
      where: { id: pollId },
      data: { status: RoomPollStatus.ENDED, endedAt: new Date() },
    });
  }

  listHistory(roomId: string, skip: number, take: number): Promise<[PollWithOptions[], number]> {
    const where: Prisma.RoomPollWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.roomPoll.findMany({
        where,
        skip,
        take,
        include: { options: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomPoll.count({ where }),
    ]);
  }

  /** ACTIVE polls whose auto-end time has elapsed (for the tick monitor). */
  findExpired(now: Date, limit: number): Promise<PollWithOptions[]> {
    return this.prisma.roomPoll.findMany({
      where: { status: RoomPollStatus.ACTIVE, endsAt: { not: null, lte: now } },
      include: { options: { orderBy: { position: 'asc' } } },
      take: limit,
    });
  }
}
