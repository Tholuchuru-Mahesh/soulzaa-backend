import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent } from './domain-event';
import { InMemoryEventBus } from './in-memory-event-bus';

class TestEvent extends DomainEvent<{ value: number }> {
  readonly name = 'test.happened';
}

describe('InMemoryEventBus', () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));
  });

  it('delivers a published event to subscribers', async () => {
    const received: number[] = [];
    bus.subscribe<TestEvent>('test.happened', (e) => {
      received.push(e.payload.value);
    });

    await bus.publish(new TestEvent({ value: 42 }));

    expect(received).toEqual([42]);
  });

  it('stops delivering after unsubscribe', async () => {
    const received: number[] = [];
    const off = bus.subscribe<TestEvent>('test.happened', (e) => {
      received.push(e.payload.value);
    });
    off();

    await bus.publish(new TestEvent({ value: 1 }));

    expect(received).toEqual([]);
  });

  it('stamps eventId and occurredAt', () => {
    const event = new TestEvent({ value: 1 });
    expect(event.eventId).toEqual(expect.any(String));
    expect(event.occurredAt).toEqual(expect.any(String));
  });
});
