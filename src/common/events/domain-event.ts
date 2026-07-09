import { randomUUID } from 'node:crypto';

/**
 * Base class for every cross-module event. Concrete events set a stable
 * `name` (dot-namespaced, e.g. "wallet.debited") and carry a serialisable
 * `payload`. Keeping events plain-serialisable is what lets the transport
 * swap from in-process to Redis/Kafka/NATS on microservice extraction.
 */
export abstract class DomainEvent<TPayload = unknown> {
  /** Stable, dot-namespaced event name. Subscribers match on this. */
  abstract readonly name: string;

  readonly eventId: string;
  readonly occurredAt: string;

  constructor(
    public readonly payload: TPayload,
    meta?: { eventId?: string; occurredAt?: string },
  ) {
    this.eventId = meta?.eventId ?? randomUUID();
    this.occurredAt = meta?.occurredAt ?? new Date().toISOString();
  }
}

export type DomainEventHandler<E extends DomainEvent = DomainEvent> = (
  event: E,
) => void | Promise<void>;
