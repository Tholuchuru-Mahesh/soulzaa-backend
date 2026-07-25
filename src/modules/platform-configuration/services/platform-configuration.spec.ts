import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SettingValueType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { ConfigurationEngineService } from './configuration-engine.service';
import { ConfigurationHistoryService } from './configuration-history.service';
import { ConfigurationValidationService } from './configuration-validation.service';
import { FeatureFlagService } from './feature-flag.service';
import { PlatformConfigurationSeederService } from './platform-configuration-seeder.service';
import { SettingsQueryService } from './settings-query.service';

describe('PlatformConfigurationModule Shared Services', () => {
  let configEngine: ConfigurationEngineService;
  let featureFlagService: FeatureFlagService;
  let validationService: ConfigurationValidationService;
  let _historyService: ConfigurationHistoryService;
  let _queryService: SettingsQueryService;
  let seederService: PlatformConfigurationSeederService;

  const mockPrismaService = {
    platformSetting: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      groupBy: jest.fn(),
    },
    settingHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockCacheService = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigurationValidationService,
        ConfigurationHistoryService,
        ConfigurationEngineService,
        FeatureFlagService,
        SettingsQueryService,
        PlatformConfigurationSeederService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    configEngine = module.get<ConfigurationEngineService>(ConfigurationEngineService);
    featureFlagService = module.get<FeatureFlagService>(FeatureFlagService);
    validationService = module.get<ConfigurationValidationService>(ConfigurationValidationService);
    _historyService = module.get<ConfigurationHistoryService>(ConfigurationHistoryService);
    _queryService = module.get<SettingsQueryService>(SettingsQueryService);
    seederService = module.get<PlatformConfigurationSeederService>(
      PlatformConfigurationSeederService,
    );

    jest.clearAllMocks();
  });

  describe('ConfigurationValidationService', () => {
    it('should validate and serialize boolean values correctly', () => {
      expect(
        validationService.validateAndSerialize('test_key', true, SettingValueType.BOOLEAN),
      ).toBe('true');
      expect(
        validationService.validateAndSerialize('test_key', 'false', SettingValueType.BOOLEAN),
      ).toBe('false');
      expect(() =>
        validationService.validateAndSerialize('test_key', 'invalid', SettingValueType.BOOLEAN),
      ).toThrow(BadRequestException);
    });

    it('should validate and serialize number values correctly', () => {
      expect(validationService.validateAndSerialize('num_key', 42, SettingValueType.NUMBER)).toBe(
        '42',
      );
      expect(() =>
        validationService.validateAndSerialize('num_key', 'abc', SettingValueType.NUMBER),
      ).toThrow(BadRequestException);
    });
  });

  describe('ConfigurationEngineService', () => {
    it('should fetch value from Redis cache first', async () => {
      mockCacheService.get.mockResolvedValue('true');

      const result = await configEngine.getBoolean('feature.audio_rooms.enabled');
      expect(result).toBe(true);
      expect(mockCacheService.get).toHaveBeenCalledWith(
        'config:setting:feature.audio_rooms.enabled',
      );
      expect(mockPrismaService.platformSetting.findUnique).not.toHaveBeenCalled();
    });

    it('should fallback to DB if Redis cache misses and cache the result', async () => {
      mockCacheService.get.mockResolvedValue(null);
      mockPrismaService.platformSetting.findUnique.mockResolvedValue({
        key: 'auth.max_login_attempts',
        value: '5',
        valueType: SettingValueType.NUMBER,
      });

      const result = await configEngine.getNumber('auth.max_login_attempts');
      expect(result).toBe(5);
      expect(mockCacheService.set).toHaveBeenCalled();
    });

    it('should throw NotFoundException if key does not exist', async () => {
      mockCacheService.get.mockResolvedValue(null);
      mockPrismaService.platformSetting.findUnique.mockResolvedValue(null);

      await expect(configEngine.getString('non_existent_key')).rejects.toThrow(NotFoundException);
    });
  });

  describe('FeatureFlagService', () => {
    it('should check if a feature flag is enabled', async () => {
      mockCacheService.get.mockResolvedValue('true');

      const isAudioEnabled = await featureFlagService.isEnabled('feature.audio_rooms.enabled');
      expect(isAudioEnabled).toBe(true);
    });
  });

  describe('PlatformConfigurationSeederService', () => {
    it('should seed default platform settings', async () => {
      mockPrismaService.platformSetting.upsert.mockResolvedValue({});

      await seederService.seedDefaults();
      expect(mockPrismaService.platformSetting.upsert).toHaveBeenCalled();
    });
  });
});
