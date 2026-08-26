import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';

const LEVELS = [
  { level: 0, name: 'Normal User', expThreshold: 0n },
  { level: 1, name: 'Prestige', expThreshold: 10_000n },
  { level: 2, name: 'Rise', expThreshold: 30_000n },
  { level: 3, name: 'Nova', expThreshold: 75_000n },
  { level: 4, name: 'Elite', expThreshold: 150_000n },
  { level: 5, name: 'Royal', expThreshold: 300_000n },
  { level: 6, name: 'Crown', expThreshold: 600_000n },
  { level: 7, name: 'Legend', expThreshold: 1_200_000n },
  { level: 8, name: 'Titan', expThreshold: 2_500_000n },
  { level: 9, name: 'Supreme', expThreshold: 5_000_000n },
  { level: 10, name: 'Infinity', expThreshold: 10_000_000n },
  { level: 11, name: 'Celestial', expThreshold: 20_000_000n },
  { level: 12, name: 'Immortal', expThreshold: 40_000_000n },
];

describe('WealthLevelService', () => {
  let repo: Record<string, jest.Mock>;
  let service: WealthLevelService;

  beforeEach(async () => {
    repo = { listLevels: jest.fn().mockResolvedValue(LEVELS) };
    service = new WealthLevelService(repo as unknown as WealthRepository);
    await service.reload();
  });

  describe('levelForExp — every threshold boundary from the spec', () => {
    it.each([
      [0, 0],
      [9_999, 0],
      [10_000, 1],
      [29_999, 1],
      [30_000, 2],
      [74_999, 2],
      [75_000, 3],
      [149_999, 3],
      [150_000, 4],
      [299_999, 4],
      [300_000, 5],
      [599_999, 5],
      [600_000, 6],
      [1_199_999, 6],
      [1_200_000, 7],
      [2_499_999, 7],
      [2_500_000, 8],
      [4_999_999, 8],
      [5_000_000, 9],
      [9_999_999, 9],
      [10_000_000, 10],
      [19_999_999, 10],
      [20_000_000, 11],
      [39_999_999, 11],
      [40_000_000, 12],
      [100_000_000, 12],
    ])('%i EXP → level %i', (exp, expectedLevel) => {
      expect(service.levelForExp(BigInt(exp))).toBe(expectedLevel);
    });
  });

  describe('worked edge cases from the spec', () => {
    it('29,500 + 500 = 30,000 → Rise (2)', () => {
      expect(service.levelForExp(29_500n + 500n)).toBe(2);
    });

    it('149,999 + 1 = 150,000 → Elite (4)', () => {
      expect(service.levelForExp(149_999n + 1n)).toBe(4);
    });
  });

  describe('nextLevel', () => {
    it('returns the next configured level', () => {
      expect(service.nextLevel(3)?.level).toBe(4);
      expect(service.nextLevel(3)?.name).toBe('Elite');
    });

    it('returns null at the max level (Immortal)', () => {
      expect(service.nextLevel(12)).toBeNull();
    });
  });

  describe('getByOrdinal', () => {
    it('returns the level definition', () => {
      expect(service.getByOrdinal(8)?.name).toBe('Titan');
    });

    it('returns null for an unconfigured level', () => {
      expect(service.getByOrdinal(99)).toBeNull();
    });
  });

  describe('maxLevel', () => {
    it('returns 12 (Immortal)', () => {
      expect(service.maxLevel()).toBe(12);
    });
  });
});
