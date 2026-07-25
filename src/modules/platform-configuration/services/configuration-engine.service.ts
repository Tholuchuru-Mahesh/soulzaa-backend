import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { ConfigurationHistoryService } from './configuration-history.service';
import { ConfigurationValidationService } from './configuration-validation.service';

const CACHE_TTL_SECONDS = 3600;

@Injectable()
export class ConfigurationEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly validationService: ConfigurationValidationService,
    private readonly historyService: ConfigurationHistoryService,
  ) {}

  /**
   * Retrieves a typed configuration value by key with Redis caching & process.env fallback
   */
  async get<T = any>(key: string, defaultValue?: T): Promise<T> {
    const cacheKey = `config:setting:${key}`;

    // 1. Try Redis cache
    const cachedStr = await this.cacheService.get<string>(cacheKey);
    if (cachedStr !== null && cachedStr !== undefined) {
      return this.deserializeValue(key, cachedStr);
    }

    // 2. Try Database lookup
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key },
    });

    if (setting) {
      await this.cacheService.set(cacheKey, setting.value, CACHE_TTL_SECONDS);
      return this.validationService.deserialize<T>(setting.value, setting.valueType);
    }

    // 3. Try Environment variable override
    const envValue = process.env[key.toUpperCase().replace(/\./g, '_')];
    if (envValue !== undefined) {
      return envValue as any;
    }

    // 4. Default parameter fallback
    if (defaultValue !== undefined) {
      return defaultValue;
    }

    throw new NotFoundException(`Platform configuration key '${key}' not found`);
  }

  async getString(key: string, defaultValue?: string): Promise<string> {
    return this.get<string>(key, defaultValue);
  }

  async getNumber(key: string, defaultValue?: number): Promise<number> {
    const val = await this.get<any>(key, defaultValue);
    return Number(val);
  }

  async getBoolean(key: string, defaultValue?: boolean): Promise<boolean> {
    const val = await this.get<any>(key, defaultValue);
    if (typeof val === 'boolean') return val;
    return String(val).toLowerCase() === 'true';
  }

  async getJSON<T = any>(key: string, defaultValue?: T): Promise<T> {
    return this.get<T>(key, defaultValue);
  }

  /**
   * Sets or creates a platform setting
   */
  async setSetting(key: string, value: any, reason?: string, actorId?: string) {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key },
    });

    if (!setting) {
      throw new NotFoundException(`Setting with key '${key}' not found`);
    }

    if (setting.isReadOnly) {
      throw new BadRequestException(`Setting '${key}' is read-only and cannot be modified`);
    }

    const newValueStr = this.validationService.validateAndSerialize(key, value, setting.valueType);
    const oldValueStr = setting.value;

    if (oldValueStr === newValueStr) {
      return setting;
    }

    const updated = await this.prisma.platformSetting.update({
      where: { key },
      data: {
        value: newValueStr,
        updatedBy: actorId,
      },
    });

    // Invalidate Redis Cache & Record History
    await Promise.all([
      this.cacheService.del(`config:setting:${key}`),
      this.historyService.recordHistory(setting.id, oldValueStr, newValueStr, reason, actorId),
    ]);

    return updated;
  }

  /**
   * Resets a setting value back to its default value
   */
  async resetSetting(key: string, reason?: string, actorId?: string) {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key },
    });

    if (!setting) {
      throw new NotFoundException(`Setting with key '${key}' not found`);
    }

    if (setting.defaultValue === null || setting.defaultValue === undefined) {
      throw new BadRequestException(`Setting '${key}' does not have a default value defined`);
    }

    return this.setSetting(key, setting.defaultValue, reason ?? 'Reset to default value', actorId);
  }

  private deserializeValue(key: string, rawStr: string) {
    try {
      if (rawStr === 'true') return true;
      if (rawStr === 'false') return false;
      if (!isNaN(Number(rawStr))) return Number(rawStr);
      return JSON.parse(rawStr);
    } catch {
      return rawStr;
    }
  }
}
