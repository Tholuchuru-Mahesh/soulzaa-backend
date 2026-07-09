import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, RoomPollStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { pollLockKey } from '../constants/room-utilities.constants';
import { CreatePollDto } from '../dto/room-utilities.dto';
import {
  PollCreatedEvent,
  PollEndedEvent,
  PollVotedEvent,
  type PollTally,
} from '../events/room-utilities.events';
import { PollRepository, type PollWithOptions } from '../repositories/poll.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/**
 * Room polls (AR-15): a host creates a poll with 2..8 options and an optional
 * auto-end window; members cast one vote each (enforced by a DB unique
 * constraint + a per-poll lock); live tallies fan out over EVENT_BUS. Results
 * are always server-authoritative.
 */
@Injectable()
export class PollService {
  constructor(
    private readonly repo: PollRepository,
    private readonly authz: RoomUtilAuthz,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async create(actor: RoomActor, roomId: string, dto: CreatePollDto): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    const endsAt = dto.durationSeconds ? new Date(Date.now() + dto.durationSeconds * 1000) : null;
    const poll = await this.repo.createPoll({
      roomId,
      creatorId: actor.id,
      question: dto.question,
      options: dto.options,
      endsAt,
    });
    await this.bus.publish(
      new PollCreatedEvent({
        roomId,
        pollId: poll.id,
        creatorId: actor.id,
        question: poll.question,
        options: this.tallies(poll),
        endsAt: poll.endsAt ? poll.endsAt.toISOString() : null,
        createdAt: poll.createdAt.toISOString(),
      }),
    );
    return this.pollView(poll);
  }

  async vote(actor: RoomActor, roomId: string, pollId: string, optionId: string): Promise<unknown> {
    await this.authz.assertMember(roomId, actor.id);
    return this.locks.withLock(pollLockKey(pollId), async () => {
      const poll = await this.repo.findById(pollId);
      if (!poll || poll.roomId !== roomId) {
        throw new BusinessException(
          ERROR_CODES.POLL_NOT_FOUND,
          'Poll not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (
        poll.status !== RoomPollStatus.ACTIVE ||
        (poll.endsAt && poll.endsAt.getTime() <= Date.now())
      ) {
        throw new BusinessException(
          ERROR_CODES.POLL_ENDED,
          'This poll is closed.',
          HttpStatus.CONFLICT,
        );
      }
      if (!poll.options.some((o) => o.id === optionId)) {
        throw new BusinessException(
          ERROR_CODES.POLL_OPTION_INVALID,
          'That option does not belong to this poll.',
          HttpStatus.BAD_REQUEST,
        );
      }

      try {
        await this.repo.vote(pollId, optionId, actor.id);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BusinessException(
            ERROR_CODES.POLL_ALREADY_VOTED,
            'You have already voted in this poll.',
            HttpStatus.CONFLICT,
          );
        }
        throw err;
      }

      const fresh = await this.repo.findById(pollId);
      const tallies = fresh ? this.tallies(fresh) : [];
      const totalVotes = tallies.reduce((s, t) => s + t.voteCount, 0);
      await this.bus.publish(
        new PollVotedEvent({ roomId, pollId, optionId, userId: actor.id, totalVotes, tallies }),
      );
      return { pollId, optionId, totalVotes, tallies };
    });
  }

  async end(actor: RoomActor, roomId: string, pollId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    const poll = await this.repo.findById(pollId);
    if (!poll || poll.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.POLL_NOT_FOUND,
        'Poll not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (poll.status !== RoomPollStatus.ACTIVE) {
      throw new BusinessException(
        ERROR_CODES.POLL_ENDED,
        'This poll is already closed.',
        HttpStatus.CONFLICT,
      );
    }
    await this.repo.end(pollId);
    await this.publishEnded(poll, 'manual');
    return this.pollView({ ...poll, status: RoomPollStatus.ENDED, endedAt: new Date() });
  }

  async getPoll(roomId: string, pollId: string): Promise<unknown> {
    const poll = await this.repo.findById(pollId);
    if (!poll || poll.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.POLL_NOT_FOUND,
        'Poll not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.pollView(poll);
  }

  async getActive(roomId: string): Promise<unknown> {
    const polls = await this.repo.listActive(roomId);
    return { active: polls.map((p) => this.pollView(p)) };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listHistory(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((p) => this.pollView(p)),
      total,
      q.page,
      q.limit,
    );
  }

  /** Auto-end polls past their window (called by the tick monitor). */
  async endExpired(now: Date): Promise<void> {
    const expired = await this.repo.findExpired(now, 50);
    for (const poll of expired) {
      await this.locks.withLock(pollLockKey(poll.id), async () => {
        const fresh = await this.repo.findById(poll.id);
        if (!fresh || fresh.status !== RoomPollStatus.ACTIVE) return;
        await this.repo.end(fresh.id);
        await this.publishEnded(fresh, 'expired');
      });
    }
  }

  // ---- Internals ----

  private async publishEnded(poll: PollWithOptions, reason: 'manual' | 'expired'): Promise<void> {
    const tallies = this.tallies(poll);
    const totalVotes = tallies.reduce((s, t) => s + t.voteCount, 0);
    await this.bus.publish(
      new PollEndedEvent({
        roomId: poll.roomId,
        pollId: poll.id,
        reason,
        totalVotes,
        tallies,
        winningOptionId: this.winningOption(tallies),
      }),
    );
  }

  private tallies(poll: PollWithOptions): PollTally[] {
    return poll.options.map((o) => ({ optionId: o.id, label: o.label, voteCount: o.voteCount }));
  }

  private winningOption(tallies: PollTally[]): string | null {
    let best: PollTally | null = null;
    for (const t of tallies) {
      if (t.voteCount > 0 && (!best || t.voteCount > best.voteCount)) best = t;
    }
    return best?.optionId ?? null;
  }

  private pollView(poll: PollWithOptions) {
    const tallies = this.tallies(poll);
    return {
      id: poll.id,
      roomId: poll.roomId,
      creatorId: poll.creatorId,
      question: poll.question,
      status: poll.status,
      options: poll.options.map((o) => ({
        id: o.id,
        label: o.label,
        position: o.position,
        voteCount: o.voteCount,
      })),
      totalVotes: tallies.reduce((s, t) => s + t.voteCount, 0),
      endsAt: poll.endsAt,
      endedAt: poll.endedAt,
      createdAt: poll.createdAt,
    };
  }
}
