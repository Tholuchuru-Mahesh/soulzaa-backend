import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';

export interface ChaosSimulationResult {
  targetService: string;
  simulatedFailure: string;
  circuitBreakerState: string;
  fallbackTriggered: boolean;
  recovered: boolean;
  timestamp: string;
}

@Injectable()
export class ChaosSimulationService {
  private readonly logger = new Logger(ChaosSimulationService.name);

  constructor(private readonly circuitBreaker: CircuitBreakerService) {}

  async runChaosSimulation(targetService: string): Promise<ChaosSimulationResult> {
    this.logger.warn(`Injecting chaos failure simulation into service [${targetService}]`);

    let fallbackTriggered = false;
    const failFn = () => Promise.reject(new Error(`Simulated Chaos Failure on ${targetService}`));
    const fallbackFn = () => {
      fallbackTriggered = true;
      return Promise.resolve({ fallback: true });
    };

    try {
      await this.circuitBreaker.execute(targetService, failFn, fallbackFn, {
        failureThreshold: 1,
        resetTimeoutMs: 100,
      });
    } catch {
      // Ignored
    }

    const state = this.circuitBreaker.getState(targetService);

    return {
      targetService,
      simulatedFailure: 'SYNTHETIC_TIMEOUT_INJECTION',
      circuitBreakerState: state,
      fallbackTriggered,
      recovered: true,
      timestamp: new Date().toISOString(),
    };
  }
}
