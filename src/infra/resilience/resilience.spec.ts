import { CircuitBreakerService, CircuitState } from './circuit-breaker.service';
import { withRetry } from './retry.util';

describe('Resilience Utilities', () => {
  describe('withRetry', () => {
    it('should return result on first try', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const res = await withRetry(fn, { maxRetries: 2, initialDelayMs: 1 });
      expect(res).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on error and succeed', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success');

      const res = await withRetry(fn, { maxRetries: 2, initialDelayMs: 1, jitter: false });
      expect(res).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('CircuitBreakerService', () => {
    let breaker: CircuitBreakerService;

    beforeEach(() => {
      breaker = new CircuitBreakerService();
    });

    it('should start in CLOSED state and execute successfully', async () => {
      const res = await breaker.execute('test-svc', () => Promise.resolve('data'));
      expect(res).toBe('data');
      expect(breaker.getState('test-svc')).toBe(CircuitState.CLOSED);
    });

    it('should open circuit after threshold failures', async () => {
      const failFn = () => Promise.reject(new Error('service error'));

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.execute('test-svc', failFn, undefined, {
            failureThreshold: 2,
            resetTimeoutMs: 5000,
          }),
        ).rejects.toThrow('service error');
      }

      expect(breaker.getState('test-svc')).toBe(CircuitState.OPEN);

      await expect(
        breaker.execute('test-svc', failFn, undefined, {
          failureThreshold: 2,
          resetTimeoutMs: 5000,
        }),
      ).rejects.toThrow('CircuitBreaker [test-svc] is OPEN');
    });
  });
});
