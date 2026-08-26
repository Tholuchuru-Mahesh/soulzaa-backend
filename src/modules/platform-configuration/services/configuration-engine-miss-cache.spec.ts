import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { ConfigurationEngineService } from './configuration-engine.service';
import { ConfigurationHistoryService } from './configuration-history.service';
import { ConfigurationValidationService } from './configuration-validation.service';

/**
 * `get()` is called twice per HTTP request by CustomThrottlerGuard, for two keys
 * that are not in `platform_settings` and never will be. Before misses were
 * cached that was two Postgres queries on every request — measured at 41 reads
 * of the table across 20 requests, 64% of all database reads on a profile fetch.
 *
 * These tests pin the behaviour that removed them: an absent key is queried at
 * most once per MISS_TTL, and a cached absence still resolves through the env
 * and default fallbacks exactly as an uncached one did.
 */
describe('ConfigurationEngineService — negative caching', () => {
  let engine: ConfigurationEngineService;
  let prisma: { platformSetting: { findUnique: jest.Mock } };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    prisma = { platformSetting: { findUnique: jest.fn().mockResolvedValue(null) } };
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigurationEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
        { provide: ConfigurationValidationService, useValue: { deserialize: (v: string) => v } },
        { provide: ConfigurationHistoryService, useValue: { recordHistory: jest.fn() } },
      ],
    }).compile();

    engine = module.get(ConfigurationEngineService);
  });

  /** What the cache would hand back after a miss was stored. */
  const storedValue = () => cache.set.mock.calls.at(-1)?.[1];

  it('queries the database once for an absent key, then stores a miss marker', async () => {
    const value = await engine.getNumber('throttle.global.limit', 100);

    expect(value).toBe(100);
    expect(prisma.platformSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
    // Stored with a short TTL so a later-seeded key is not masked for long.
    expect(cache.set.mock.calls[0][2]).toBeLessThanOrEqual(60);
  });

  it('does NOT touch the database when the miss is already cached', async () => {
    cache.get.mockResolvedValue({ __configMiss: true });

    const value = await engine.getNumber('throttle.global.limit', 100);

    expect(value).toBe(100);
    expect(prisma.platformSetting.findUnique).not.toHaveBeenCalled();
  });

  it('a cached miss still resolves the env override', async () => {
    cache.get.mockResolvedValue({ __configMiss: true });
    process.env['THROTTLE_GLOBAL_LIMIT'] = '250';
    try {
      await expect(engine.getNumber('throttle.global.limit', 100)).resolves.toBe(250);
      expect(prisma.platformSetting.findUnique).not.toHaveBeenCalled();
    } finally {
      delete process.env['THROTTLE_GLOBAL_LIMIT'];
    }
  });

  it('still returns a real cached value, and does not mistake it for a miss', async () => {
    cache.get.mockResolvedValue('42');
    await expect(engine.getNumber('throttle.global.limit', 100)).resolves.toBe(42);
    expect(prisma.platformSetting.findUnique).not.toHaveBeenCalled();
  });

  it('reads a real database row and caches the value, not a marker', async () => {
    prisma.platformSetting.findUnique.mockResolvedValue({
      key: 'throttle.global.limit',
      value: '250',
      valueType: 'NUMBER',
    });

    await expect(engine.getNumber('throttle.global.limit', 100)).resolves.toBe(250);
    expect(storedValue()).toBe('250');
  });

  it('throws for an absent key with no env and no default, as before', async () => {
    cache.get.mockResolvedValue({ __configMiss: true });
    await expect(engine.get('nothing.here')).rejects.toThrow();
  });
});
