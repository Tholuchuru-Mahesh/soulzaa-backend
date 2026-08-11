import type { Paginated } from 'src/common/interfaces/api-response.interface';

/**
 * Public contract for the audio-rooms module's PK battle sub-domain — the only
 * PK surface other modules (Creator Center) may depend on. Internals
 * (PkBattleRepository, the live start/invite/score/complete flow) stay
 * private; that flow is invoked through the PK REST controller / gift events,
 * not through this seam.
 */
export const PK_BATTLE_SERVICE = Symbol('PK_BATTLE_SERVICE');

export type PkHistoryFilter = 'all' | 'wins' | 'losses' | 'draws';

export interface IPkBattleService {
  /** Every battle the caller has fought, across all rooms, most recent first. */
  historyForCreator(
    userId: string,
    q: { skip: number; limit: number; page: number; filter: PkHistoryFilter },
  ): Promise<Paginated<unknown>>;

  /** Detail for one of the caller's own battles; null if they didn't fight in it. */
  getCreatorBattleDetail(userId: string, battleId: string): Promise<unknown | null>;
}
