import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { CacheService } from 'src/infra/redis/cache.service';

/**
 * Redis-backed login-attempt tracking + temporary account lock, plus a generic
 * fixed-window rate limiter (OTP requests, password resets). All state is in
 * Redis with TTLs — nothing to clean up, and it works across horizontally
 * scaled instances. Cluster-safe: every method touches a single key.
 */
@Injectable()
export class LoginSecurityService {
  private readonly maxAttempts: number;
  private readonly lockSeconds: number;

  constructor(
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    const sec = config.get('security', { infer: true })!;
    this.maxAttempts = Number(sec.loginMaxAttempts);
    this.lockSeconds = Number(sec.loginLockSeconds);
  }

  private attemptsKey(identifier: string): string {
    return `login:attempts:${identifier.toLowerCase()}`;
  }

  private lockKey(identifier: string): string {
    return `login:lock:${identifier.toLowerCase()}`;
  }

  /** Throw ACCOUNT_LOCKED if the identifier is currently locked out. */
  async assertNotLocked(identifier: string): Promise<void> {
    if (await this.cache.exists(this.lockKey(identifier))) {
      throw new BusinessException(
        ERROR_CODES.ACCOUNT_LOCKED,
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Record a failed login. When attempts reach the max, set a lock key with TTL
   * and reset the counter. The attempt window itself expires after the lock
   * duration so counts don't accrue forever.
   */
  async recordFailure(identifier: string): Promise<void> {
    const attempts = await this.cache.increment(this.attemptsKey(identifier), {
      ttlSeconds: this.lockSeconds,
    });
    if (attempts >= this.maxAttempts) {
      await this.cache.set(this.lockKey(identifier), true, this.lockSeconds);
      await this.cache.del(this.attemptsKey(identifier));
    }
  }

  /** Clear attempt + lock state after a successful login. */
  async recordSuccess(identifier: string): Promise<void> {
    await this.cache.del(this.attemptsKey(identifier), this.lockKey(identifier));
  }

  /**
   * Fixed-window rate limit. Throws RATE_LIMITED once `limit` hits occur within
   * `windowSeconds`. Used to throttle OTP requests and password-reset requests.
   */
  async enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const count = await this.cache.increment(`rl:${key}`, { ttlSeconds: windowSeconds });
    if (count > limit) {
      throw new BusinessException(
        ERROR_CODES.RATE_LIMITED,
        'Too many requests. Please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
