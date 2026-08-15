import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EVENT_BUS } from './event-bus.interface';
import { InMemoryEventBus } from './in-memory-event-bus';

/**
 * Binds the EVENT_BUS token to the in-process implementation. To move a
 * module out of the monolith, rebind EVENT_BUS here to a networked bus —
 * nothing else changes.
 */
@Global()
@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 50 })],
  providers: [{ provide: EVENT_BUS, useClass: InMemoryEventBus }],
  exports: [EVENT_BUS],
})
export class EventBusModule {}
