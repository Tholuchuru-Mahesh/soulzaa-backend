import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent, DomainEventHandler } from './domain-event';
import type { IEventBus } from './event-bus.interface';

/**
 * In-process implementation backed by EventEmitter2. Handlers run in the same
 * node process. This is the Phase-0 default; a Redis/Kafka implementation can
 * be bound to EVENT_BUS later without touching publishers or subscribers.
 */
@Injectable()
export class InMemoryEventBus implements IEventBus {
  private readonly logger = new Logger(InMemoryEventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish<E extends DomainEvent>(event: E): Promise<void> {
    this.logger.debug(`publish ${event.name} (${event.eventId})`);
    // emitAsync awaits async listeners so publishers can rely on completion.
    await this.emitter.emitAsync(event.name, event);
  }

  subscribe<E extends DomainEvent = DomainEvent>(
    eventName: string,
    handler: DomainEventHandler<E>,
  ): () => void {
    const listener = (event: E) => handler(event);
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }
}
