import { Logger } from '@nestjs/common';
import type { MonitoringMetrics } from '../observability/monitoring.metrics';
import type { RedisClient } from './redis.constants';

/** Minimal shape of the ioredis Command object passed to sendCommand. */
interface TimedCommand {
  name?: string;
  promise?: Promise<unknown>;
}

/**
 * Wrap an ioredis client's `sendCommand` to time every command: records the
 * `redis_command_duration_seconds` metric and warns when a command exceeds
 * `slowMs`. Works for both standalone and Cluster clients. Exported standalone
 * so it can be unit-tested against a real client.
 */
export function instrumentRedisClient(
  client: RedisClient,
  metrics: MonitoringMetrics,
  logger: Logger,
  slowMs: number,
): RedisClient {
  const target = client as unknown as {
    sendCommand: (command: TimedCommand, ...rest: unknown[]) => unknown;
  };
  const original = target.sendCommand.bind(target);

  target.sendCommand = (command: TimedCommand, ...rest: unknown[]): unknown => {
    const start = process.hrtime.bigint();
    const result = original(command, ...rest);
    const name = command?.name ?? 'unknown';

    const finish = (): void => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.observeRedisCommand(name, ms / 1000);
      if (ms > slowMs) {
        logger.warn(`slow redis command ${name} (${ms.toFixed(1)}ms)`);
      }
    };
    command?.promise?.then(finish, finish);
    return result;
  };

  return client;
}
