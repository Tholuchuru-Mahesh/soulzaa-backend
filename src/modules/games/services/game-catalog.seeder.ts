import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { GAME_CATALOG_SEED } from '../constants/games.constants';
import { GamesRepository } from '../repositories/games.repository';

/**
 * Idempotently seeds the catalog (Ludo + Carrom) on bootstrap. Only creates
 * missing entries — admin edits to existing definitions are preserved. GREEDY,
 * ROULETTE, SLOTS, JACKPOT, UNO and DOMINO were removed from the catalog (see
 * GAME_CATALOG_SEED) — this seeder no longer creates them, and any pre-existing
 * rows for them were disabled by prisma/disable_dead_games.ts, not deleted.
 */
@Injectable()
export class GameCatalogSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(GameCatalogSeeder.name);

  constructor(private readonly repo: GamesRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    let created = 0;
    for (const seed of GAME_CATALOG_SEED) {
      const existing = await this.repo.getDefinitionByCode(seed.code);
      if (existing) continue;
      await this.repo.upsertDefinition({
        code: seed.code,
        name: seed.name,
        category: seed.category,
        currency: seed.currency,
        minPlayers: seed.minPlayers,
        maxPlayers: seed.maxPlayers,
        minStake: BigInt(seed.minStake),
        maxStake: BigInt(seed.maxStake),
      });
      created++;
    }
    if (created > 0) this.logger.log(`Seeded ${created} game definition(s).`);
  }
}
