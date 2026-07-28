import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/infra/redis/cache.service';

@Injectable()
export class AuthorizationCacheService {
  private readonly logger = new Logger(AuthorizationCacheService.name);
  private readonly defaultTtlSeconds: number;

  constructor(
    private readonly cacheService: CacheService,
    config: ConfigService,
  ) {
    this.defaultTtlSeconds = Number(config.get('authorization', { infer: true })!.cacheTtlSeconds);
  }

  private getPermsKey(userId: string): string {
    return `rbac:perms:${userId}`;
  }

  private getRolesKey(userId: string): string {
    return `rbac:roles:${userId}`;
  }

  private getScopesKey(userId: string): string {
    return `rbac:scopes:${userId}`;
  }

  // ---- Cached Permissions ----

  async getCachedPermissions(userId: string): Promise<string[] | null> {
    try {
      return await this.cacheService.get<string[]>(this.getPermsKey(userId));
    } catch (err) {
      this.logger.warn(`Redis getCachedPermissions failed: ${(err as Error).message}`);
      return null;
    }
  }

  async setCachedPermissions(userId: string, permissions: string[]): Promise<void> {
    try {
      await this.cacheService.set(this.getPermsKey(userId), permissions, this.defaultTtlSeconds);
    } catch (err) {
      this.logger.warn(`Redis setCachedPermissions failed: ${(err as Error).message}`);
    }
  }

  // ---- Cached Roles ----

  async getCachedRoles<T>(userId: string): Promise<T[] | null> {
    try {
      return await this.cacheService.get<T[]>(this.getRolesKey(userId));
    } catch (err) {
      this.logger.warn(`Redis getCachedRoles failed: ${(err as Error).message}`);
      return null;
    }
  }

  async setCachedRoles<T>(userId: string, roles: T[]): Promise<void> {
    try {
      await this.cacheService.set(this.getRolesKey(userId), roles, this.defaultTtlSeconds);
    } catch (err) {
      this.logger.warn(`Redis setCachedRoles failed: ${(err as Error).message}`);
    }
  }

  // ---- Cached Scopes ----

  async getCachedScopes<T>(userId: string): Promise<T[] | null> {
    try {
      return await this.cacheService.get<T[]>(this.getScopesKey(userId));
    } catch (err) {
      this.logger.warn(`Redis getCachedScopes failed: ${(err as Error).message}`);
      return null;
    }
  }

  async setCachedScopes<T>(userId: string, scopes: T[]): Promise<void> {
    try {
      await this.cacheService.set(this.getScopesKey(userId), scopes, this.defaultTtlSeconds);
    } catch (err) {
      this.logger.warn(`Redis setCachedScopes failed: ${(err as Error).message}`);
    }
  }

  // ---- Cache Invalidation Hooks ----

  /**
   * Invalidates all authorization cache keys for a specific user.
   */
  async invalidateUser(userId: string): Promise<void> {
    try {
      await this.cacheService.del(
        this.getPermsKey(userId),
        this.getRolesKey(userId),
        this.getScopesKey(userId),
      );
      this.logger.log(`Invalidated authorization cache for user: ${userId}`);
    } catch (err) {
      this.logger.warn(`Redis invalidateUser failed: ${(err as Error).message}`);
    }
  }
}
