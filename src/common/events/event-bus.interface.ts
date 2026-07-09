import type { DomainEvent, DomainEventHandler } from './domain-event';

export const EVENT_BUS = Symbol('EVENT_BUS');

/**
 * The one contract modules use to talk to each other. Depend on this
 * interface — never on another module's providers. Today it's in-process;
 * swapping the binding to a Redis/Kafka implementation makes the same
 * publish/subscribe calls cross a network boundary with zero call-site edits.
 */
export interface IEventBus {
  /** Publish an event to all subscribers of `event.name`. */
  publish<E extends DomainEvent>(event: E): Promise<void>;

  /** Subscribe a handler to an event name. Returns an unsubscribe fn. */
  subscribe<E extends DomainEvent = DomainEvent>(
    eventName: string,
    handler: DomainEventHandler<E>,
  ): () => void;
}
