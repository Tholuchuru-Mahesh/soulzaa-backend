import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VIDEO_ROOM_RANKING_MAX_PAGE_SIZE } from '../constants/video-room-ranking.constants';
import { QueryRankingDto } from './video-room-ranking.dto';

/**
 * QueryRankingDto is the shared query object behind every ranking GET route.
 * These validate the class-validator/class-transformer decorators that stand
 * between the wire and `VideoRoomRankingQueryService` — anything unvalidated
 * here (city, dateKey, country) flows into a Redis key or scope string, so the
 * bounds matter. Business rules (the guest gate, dimension forcing) live in the
 * service/controller and are NOT the DTO's job — this spec only asserts shape.
 */
const build = (raw: Record<string, unknown>) => validate(plainToInstance(QueryRankingDto, raw));

describe('QueryRankingDto', () => {
  it('accepts an empty query and applies the documented defaults', async () => {
    const dto = plainToInstance(QueryRankingDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.dimension).toBe('hosts');
    expect(dto.period).toBe('daily');
    expect(dto.audience).toBe('all');
    expect(dto.limit).toBe(20);
    expect(dto.page).toBe(1);
    expect(dto.dateKey).toBeUndefined();
  });

  describe('dimension / period / audience enums', () => {
    it('accepts every valid enum value', async () => {
      expect(await build({ dimension: 'pk', period: 'monthly', audience: 'friends' })).toHaveLength(
        0,
      );
    });

    it('rejects an unknown dimension', async () => {
      expect((await build({ dimension: 'families' })).length).toBeGreaterThan(0);
    });

    it('rejects an unknown period', async () => {
      expect((await build({ period: 'fortnightly' })).length).toBeGreaterThan(0);
    });

    it('rejects an unknown audience', async () => {
      expect((await build({ audience: 'enemies' })).length).toBeGreaterThan(0);
    });
  });

  describe('dateKey', () => {
    it('accepts each period key format', async () => {
      for (const dateKey of ['2026072214', '20260722', '2026W30', '202607', '2026Q3', 'alltime']) {
        expect(await build({ dateKey })).toHaveLength(0);
      }
    });

    it('rejects a malformed dateKey rather than letting it reach a Redis key', async () => {
      for (const dateKey of ['2026-07-22', '2026Q5', 'yesterday', '']) {
        expect((await build({ dateKey })).length).toBeGreaterThan(0);
      }
    });
  });

  describe('country', () => {
    it('accepts a two-letter code', async () => {
      expect(await build({ country: 'IN' })).toHaveLength(0);
    });

    it('rejects anything that is not ISO-3166 alpha-2', async () => {
      for (const country of ['IND', 'I', '12', '']) {
        expect((await build({ country })).length).toBeGreaterThan(0);
      }
    });
  });

  describe('city', () => {
    it('accepts a bounded city id', async () => {
      expect(await build({ city: 'city-9' })).toHaveLength(0);
    });

    it('rejects a city string longer than the 80-char cap that guards the Redis key', async () => {
      expect((await build({ city: 'x'.repeat(81) })).length).toBeGreaterThan(0);
    });
  });

  describe('limit', () => {
    it('coerces a numeric string (query params arrive as strings)', async () => {
      const dto = plainToInstance(QueryRankingDto, { limit: '50' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.limit).toBe(50);
    });

    it('rejects a limit above the max page size', async () => {
      expect((await build({ limit: VIDEO_ROOM_RANKING_MAX_PAGE_SIZE + 1 })).length).toBeGreaterThan(
        0,
      );
    });

    it('rejects a non-positive limit', async () => {
      expect((await build({ limit: 0 })).length).toBeGreaterThan(0);
    });

    it('rejects a non-integer limit', async () => {
      expect((await build({ limit: 2.5 })).length).toBeGreaterThan(0);
    });
  });

  describe('page', () => {
    it('coerces a numeric string', async () => {
      const dto = plainToInstance(QueryRankingDto, { page: '3' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.page).toBe(3);
    });

    it('rejects page 0 / negative (the service also floors defensively)', async () => {
      expect((await build({ page: 0 })).length).toBeGreaterThan(0);
      expect((await build({ page: -1 })).length).toBeGreaterThan(0);
    });
  });
});
