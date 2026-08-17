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
  // maxListeners: 50 — every feature module subscribes its own listener(s)
  // to this shared platform-wide bus by design (that's the point of an
  // event bus), so the EventEmitter2 default cap of 10 listeners per event
  // name is not a real leak signal here and trips as the module count
  // grows. 50 gives generous headroom over the current legitimate count
  // while still catching a genuine future leak (e.g. a listener bound per
  // request and never removed) — deliberately finite rather than 0
  // (unlimited), which would disable this diagnostic outright. Also
  // sidesteps a Node 24 + Jest sandboxed-realm interaction where the
  // MaxListenersExceededWarning's `process.emitWarning(e)` call throws
  // (`instanceof Error` fails cross-realm) instead of just logging, which
  // would otherwise crash `app.init()` in any e2e test that boots the full
  // AppModule.
  imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 50 })],
  providers: [{ provide: EVENT_BUS, useClass: InMemoryEventBus }],
  exports: [EVENT_BUS],
})
export class EventBusModule {}
