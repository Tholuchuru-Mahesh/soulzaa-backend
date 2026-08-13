import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CosmeticRarity, CosmeticType, EventType, Prisma } from '@prisma/client';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { EventRewardEntry } from '../constants/events.constants';
import { EventsRepository } from '../repositories/events.repository';
import { EventsService } from './events.service';

/**
 * Seeds a couple of ready-to-use events on a fresh database: a long-running
 * claimable "Welcome Festival" (free coins + EXP + a collectible frame) and an
 * active "Double EXP Weekend" multiplier event. Idempotent by name; operators
 * manage real events via the admin API. Reloads the events cache after seeding.
 */
@Injectable()
export class EventsSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventsSeeder.name);

  constructor(
    private readonly repo: EventsRepository,
    private readonly events: EventsService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const now = new Date();
      const farFuture = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
      const weekend = new Date(now.getTime() + 3 * 24 * 3600 * 1000);

      const welcomeRewards: EventRewardEntry[] = [
        { kind: 'COINS', coins: 5_000, currency: 'FREE' },
        { kind: 'EXP', exp: 500 },
      ];

      let created = 0;
      if (
        await this.repo.seedEvent('Welcome Festival', {
          name: 'Welcome Festival',
          type: EventType.FESTIVAL,
          description: 'Claim your welcome rewards!',
          startAt: now,
          endAt: farFuture,
          visibility: 'PUBLIC',
          enabled: true,
          rewards: welcomeRewards as unknown as Prisma.InputJsonValue,
          multiplier: 1,
        })
      ) {
        created += 1;
      }
      if (
        await this.repo.seedEvent('Double EXP Weekend', {
          name: 'Double EXP Weekend',
          type: EventType.DOUBLE_EXP,
          description: 'Earn double EXP from all activity.',
          startAt: now,
          endAt: weekend,
          visibility: 'PUBLIC',
          enabled: true,
          rewards: [] as unknown as Prisma.InputJsonValue,
          multiplier: 2,
        })
      ) {
        created += 1;
      }

      if (created > 0) {
        await this.events.reload();
        this.logger.log(`Seeded ${created} events`);
      }
    } catch (err) {
      this.logger.warn(`Events seed skipped: ${(err as Error).message}`);
    }
  }
}
