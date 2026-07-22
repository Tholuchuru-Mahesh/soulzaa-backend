import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TreasureWinnerAlgorithm } from '../constants/video-room-treasure.constants';
import { WinnerSelectionException } from '../exceptions/video-room-treasure.exceptions';

export interface WinnerSelectionInput {
  eligible: string[];
  want: number;
  /** Reproducibility anchor — persisted on the pool row. */
  seed: string;
  contributions: Map<string, bigint>;
  activity: Map<string, number>;
  vipTiers: Map<string, number>;
}

export interface WinnerSelectionStrategy {
  readonly algorithm: string;
  /** Bumped whenever the selection maths changes, so old draws stay explicable. */
  readonly version: number;
  select(input: WinnerSelectionInput): string[];
}

/**
 * A deterministic PRNG seeded from a string (mulberry32 over a SHA-256 prefix).
 *
 * `Math.random()` would make a draw unauditable: a user disputing a result
 * could never have it re-derived. Seeding from `(boxId + correlationId)` and
 * persisting the seed means any draw is reproducible from data alone.
 */
export function seededRandom(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `want` distinct users, weight-proportional, without replacement. */
function weightedDraw(
  eligible: string[],
  want: number,
  weightOf: (userId: string) => number,
  rng: () => number,
): string[] {
  const pool = eligible.map((userId) => ({
    userId,
    // Every eligible user keeps a floor weight of 1: a lottery that can never
    // pick a non-contributor is a leaderboard wearing a lottery's clothes.
    weight: Math.max(1, weightOf(userId)),
  }));
  const winners: string[] = [];
  const take = Math.min(want, pool.length);

  for (let i = 0; i < take; i++) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let roll = rng() * total;
    let index = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      roll -= pool[j].weight;
      if (roll <= 0) {
        index = j;
        break;
      }
    }
    winners.push(pool[index].userId);
    pool.splice(index, 1);
  }
  return winners;
}

/**
 * The winner-selection registry (VR-11 spec §6.5).
 *
 * Same shape as `GiftContextRegistry`: strategies register themselves, so a
 * sixth algorithm is a new class plus one `register()` call and never an edit
 * to this selector. An unknown algorithm throws rather than falling back to
 * RANDOM — a config typo must be loud, not silently change who gets paid.
 */
@Injectable()
export class VideoRoomTreasureWinnerService {
  private readonly strategies = new Map<string, WinnerSelectionStrategy>();

  constructor() {
    this.registerBuiltIns();
  }

  register(strategy: WinnerSelectionStrategy): void {
    this.strategies.set(strategy.algorithm, strategy);
  }

  select(algorithm: string, input: WinnerSelectionInput): { winners: string[]; version: number } {
    const strategy = this.strategies.get(algorithm);
    if (!strategy) {
      throw new WinnerSelectionException(`Unknown winner algorithm "${algorithm}".`);
    }
    if (input.eligible.length === 0) return { winners: [], version: strategy.version };
    return { winners: strategy.select(input), version: strategy.version };
  }

  private registerBuiltIns(): void {
    this.register({
      algorithm: TreasureWinnerAlgorithm.RANDOM,
      version: 1,
      select: (i) => weightedDraw(i.eligible, i.want, () => 1, seededRandom(i.seed)),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.WEIGHTED_RANDOM,
      version: 1,
      select: (i) =>
        weightedDraw(
          i.eligible,
          i.want,
          (id) => Number(i.contributions.get(id) ?? 0n),
          seededRandom(i.seed),
        ),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.ACTIVITY_BASED,
      version: 1,
      select: (i) =>
        weightedDraw(i.eligible, i.want, (id) => i.activity.get(id) ?? 0, seededRandom(i.seed)),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.CONTRIBUTION_BASED,
      version: 1,
      // Deterministic top-N — the audio-room parity mode. Ties break on userId
      // so the order is stable across runs rather than dependent on Map order.
      select: (i) =>
        [...i.eligible]
          .sort((a, b) => {
            const diff = (i.contributions.get(b) ?? 0n) - (i.contributions.get(a) ?? 0n);
            if (diff > 0n) return 1;
            if (diff < 0n) return -1;
            return a.localeCompare(b);
          })
          .slice(0, i.want),
    });

    this.register({
      algorithm: TreasureWinnerAlgorithm.VIP_PRIORITY,
      version: 1,
      select: (i) =>
        weightedDraw(
          i.eligible,
          i.want,
          // Tier multiplies odds; a non-VIP keeps the floor weight of 1.
          (id) => 1 + (i.vipTiers.get(id) ?? 0) * 2,
          seededRandom(i.seed),
        ),
    });
  }
}
