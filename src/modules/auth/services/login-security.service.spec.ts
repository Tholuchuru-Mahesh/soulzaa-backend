import { ConfigService } from '@nestjs/config';
import { BusinessException } from 'src/common/exceptions';
import { CacheService } from 'src/infra/redis/cache.service';
import { LoginSecurityService } from './login-security.service';

describe('LoginSecurityService', () => {
  let cache: jest.Mocked<Pick<CacheService, 'increment' | 'set' | 'del' | 'exists'>>;
  let service: LoginSecurityService;

  beforeEach(() => {
    cache = {
      increment: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn(),
    };
    const config = {
      get: () => ({ loginMaxAttempts: 3, loginLockSeconds: 900 }),
    } as unknown as ConfigService;
    service = new LoginSecurityService(cache as unknown as CacheService, {} as any, config);
  });

  it('throws ACCOUNT_LOCKED when a lock exists', async () => {
    cache.exists.mockResolvedValue(true);
    await expect(service.assertNotLocked('a@b.com')).rejects.toBeInstanceOf(BusinessException);
  });

  it('passes when no lock exists', async () => {
    cache.exists.mockResolvedValue(false);
    await expect(service.assertNotLocked('a@b.com')).resolves.toBeUndefined();
  });

  it('locks the identifier once attempts reach the max', async () => {
    cache.increment.mockResolvedValue(3); // == max
    await service.recordFailure('a@b.com');
    expect(cache.set).toHaveBeenCalledWith('login:lock:a@b.com', true, 900);
    expect(cache.del).toHaveBeenCalledWith('login:attempts:a@b.com');
  });

  it('does not lock before reaching the max', async () => {
    cache.increment.mockResolvedValue(1);
    await service.recordFailure('a@b.com');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('clears state on success', async () => {
    await service.recordSuccess('a@b.com');
    expect(cache.del).toHaveBeenCalledWith('login:attempts:a@b.com', 'login:lock:a@b.com');
  });

  it('rate-limits once the window count exceeds the limit', async () => {
    cache.increment.mockResolvedValue(2);
    await expect(service.enforceRateLimit('k', 1, 60)).rejects.toBeInstanceOf(BusinessException);
  });

  it('allows requests within the limit', async () => {
    cache.increment.mockResolvedValue(1);
    await expect(service.enforceRateLimit('k', 1, 60)).resolves.toBeUndefined();
  });
});
