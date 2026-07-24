import { Injectable, Logger } from '@nestjs/common';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxSuccesses?: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly stateMap = new Map<
    string,
    {
      state: CircuitState;
      failures: number;
      successes: number;
      nextAttempt: number;
    }
  >();

  async execute<T>(
    serviceKey: string,
    fn: () => Promise<T>,
    fallback?: () => Promise<T>,
    options: CircuitBreakerOptions = {},
  ): Promise<T> {
    const failureThreshold = options.failureThreshold ?? 5;
    const resetTimeoutMs = options.resetTimeoutMs ?? 10000;
    const halfOpenMaxSuccesses = options.halfOpenMaxSuccesses ?? 2;

    let record = this.stateMap.get(serviceKey);
    if (!record) {
      record = {
        state: CircuitState.CLOSED,
        failures: 0,
        successes: 0,
        nextAttempt: 0,
      };
      this.stateMap.set(serviceKey, record);
    }

    const now = Date.now();

    if (record.state === CircuitState.OPEN) {
      if (now > record.nextAttempt) {
        record.state = CircuitState.HALF_OPEN;
        record.successes = 0;
        this.logger.warn(`CircuitBreaker [${serviceKey}] transition -> HALF_OPEN`);
      } else {
        if (fallback) {
          return fallback();
        }
        throw new Error(`CircuitBreaker [${serviceKey}] is OPEN`);
      }
    }

    try {
      const result = await fn();
      if (record.state === CircuitState.HALF_OPEN) {
        record.successes++;
        if (record.successes >= halfOpenMaxSuccesses) {
          record.state = CircuitState.CLOSED;
          record.failures = 0;
          this.logger.log(`CircuitBreaker [${serviceKey}] transition -> CLOSED`);
        }
      } else if (record.state === CircuitState.CLOSED) {
        record.failures = 0;
      }
      return result;
    } catch (error) {
      record.failures++;
      if (record.failures >= failureThreshold || record.state === CircuitState.HALF_OPEN) {
        record.state = CircuitState.OPEN;
        record.nextAttempt = now + resetTimeoutMs;
        this.logger.error(`CircuitBreaker [${serviceKey}] transition -> OPEN`);
      }
      if (fallback) {
        return fallback();
      }
      throw error;
    }
  }

  getState(serviceKey: string): CircuitState {
    return this.stateMap.get(serviceKey)?.state ?? CircuitState.CLOSED;
  }
}
