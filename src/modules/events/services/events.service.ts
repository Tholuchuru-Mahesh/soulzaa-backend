import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventType, PlatformEvent, Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import { EXP_SERVICE, type IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import {
  WEALTH_SERVICE,
  type IWealthService,
} from 'src/modules/wealth/interfaces/wealth.service.interface';
import {
  eventClaimLockKey,
  type EventEligibility,
  type EventRewardEntry,
} from '../constants/events.constants';
import { EventRewardClaimedEvent } from '../events/event.events';
import type { IEventsService } from '../interfaces/events.service.interface';
import { EventsRepository } from '../repositories/events.repository';
import { EventRewardGranter } from './event-reward.granter';

const MULTIPLIER_TYPES: ReadonlySet<EventType> = new Set([
  EventType.DOUBLE_RECHARGE,
  EventType.DOUBLE_EXP,
]);

const CONFIG_RELOAD_MS = 30_000;

/**
 * The event system (AR-8). Serves two kinds of events:
 *  - Claimable reward events (festival/anniversary/lucky-gift/generic): a user
 *    claims once within the window (eligibility-gated), receiving coins/cosmetics/
 *    EXP idempotently with an immutable claim ledger.
 *  - Active multiplier events (double-recharge/double-EXP): `getActiveMultiplier`
 *    exposes the live multiplier the accrual pipelines apply.
 * Enabled events are cached in-memory and refreshed on a short timer so
 * `getActiveMultiplier` is a hot, allocation-free read.
 */
@Injectable()
export class EventsService implements IEventsService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private enabled: PlatformEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: EventsRepository,
    private readonly granter: EventRewardGranter,
    private readonly locks: LockService,
    private readonly queue: QueueService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(EXP_SERVICE) private readonly exp: IExpService,
    @Inject(WEALTH_SERVICE) private readonly wealth: IWealthService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch(() => undefined), CONFIG_RELOAD_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    // Cache all enabled events; active-at-now is computed per read from windows.
    this.enabled = await this.repo.listActive(new Date());
  }

  // ---- IEventsService ----

  async getActiveMultiplier(type: EventType): Promise<number> {
    if (!MULTIPLIER_TYPES.has(type)) return 1;
    const now = Date.now();
    let mult = 1;
    for (const e of this.enabled) {
      if (e.type === type && e.startAt.getTime() <= now && e.endAt.getTime() >= now) {
        mult = Math.max(mult, e.multiplier);
      }
    }
    return mult;
  }

  // ---- Claim flow ----

  async claim(userId: string, eventId: string): Promise<{ claimId: string; rewards: unknown[] }> {
    const event = await this.repo.getEvent(eventId);
    if (!event) {
      throw new BusinessException(
        ERROR_CODES.EVENT_NOT_FOUND,
        'Event not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (MULTIPLIER_TYPES.has(event.type)) {
      throw new BusinessException(
        ERROR_CODES.EVENT_NOT_CLAIMABLE,
        'This event has no claimable reward.',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertActive(event);
    await this.assertEligible(event, userId);

    return this.locks.withLock(eventClaimLockKey(eventId, userId), async () => {
      if (await this.repo.findClaim(eventId, userId)) {
        throw new BusinessException(
          ERROR_CODES.EVENT_ALREADY_CLAIMED,
          'You have already claimed this event.',
          HttpStatus.CONFLICT,
        );
      }

      const rewards = (event.rewards as unknown as EventRewardEntry[]) ?? [];
      const summaries = await this.granter.grant(userId, rewards, `event:${eventId}:${userId}`);

      let claimId: string;
      try {
        const claim = await this.repo.createClaim({
          eventId,
          userId,
          rewardsSummary: summaries as unknown as Prisma.InputJsonValue,
          idempotencyKey: `event:${eventId}:${userId}`,
        });
        claimId = claim.id;
      } catch (err) {
        // Unique (event,user) → a concurrent claim won the race.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BusinessException(
            ERROR_CODES.EVENT_ALREADY_CLAIMED,
            'You have already claimed this event.',
            HttpStatus.CONFLICT,
          );
        }
        throw err;
      }

      await this.bus.publish(
        new EventRewardClaimedEvent({
          eventId,
          eventType: event.type,
          userId,
          rewards: summaries,
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'event.reward_claimed', {
        userId,
        eventId,
        eventName: event.name,
      });
      return { claimId, rewards: summaries };
    });
  }

  // ---- Reads ----

  async listActive(userId: string): Promise<unknown[]> {
    const events = await this.repo.listActivePublic(new Date());
    const claimable = events.filter((e) => !MULTIPLIER_TYPES.has(e.type));
    const results = await Promise.all(
      events.map(async (e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
        bannerUrl: e.bannerUrl,
        startAt: e.startAt,
        endAt: e.endAt,
        multiplier: e.multiplier,
        claimable: !MULTIPLIER_TYPES.has(e.type),
        claimed: claimable.includes(e) ? (await this.repo.findClaim(e.id, userId)) !== null : false,
      })),
    );
    return results;
  }

  async myClaims(
    userId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listUserClaims(userId, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  // ---- Internals ----

  private assertActive(event: PlatformEvent): void {
    const now = Date.now();
    if (!event.enabled || event.startAt.getTime() > now || event.endAt.getTime() < now) {
      throw new BusinessException(
        ERROR_CODES.EVENT_NOT_ACTIVE,
        'This event is not currently active.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async assertEligible(event: PlatformEvent, userId: string): Promise<void> {
    const gate = (event.eligibility as unknown as EventEligibility | null) ?? null;
    if (!gate) return;
    if (gate.minUserLevel && gate.minUserLevel > 1) {
      const { level } = await this.exp.getUserExp(userId);
      if (level < gate.minUserLevel) this.notEligible();
    }
    if (gate.minVipLevel && gate.minVipLevel > 0) {
      const ordinal = await this.wealth.getEffectiveLevel(userId);
      if (ordinal < gate.minVipLevel) this.notEligible();
    }
  }

  private notEligible(): never {
    throw new BusinessException(
      ERROR_CODES.EVENT_NOT_ELIGIBLE,
      'You are not eligible to claim this event.',
      HttpStatus.FORBIDDEN,
    );
  }
}
