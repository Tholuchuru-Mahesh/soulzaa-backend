import 'reflect-metadata';
import { BaseGateway } from './base.gateway';

/**
 * The generic `send_chat` relay that used to live on BaseGateway was a complete
 * bypass of the video-room chat stack: client-supplied sender identity, no room
 * membership check, no mute/ban/block, no chat-mode gate, no rate limiter, no
 * blocked-word scan and no persistence (so no id, no ordering, no dedup).
 *
 * It is gone, and this test exists so it cannot come back by accident — a relay
 * on the base class is inherited by EVERY namespace at once, which is exactly
 * what made it dangerous.
 */
describe('BaseGateway inbound surface', () => {
  /** The event names Nest binds, read off the `@SubscribeMessage` metadata. */
  const subscribedEvents = (): string[] => {
    const proto = BaseGateway.prototype as unknown as Record<string, unknown>;
    const events: string[] = [];
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const handler = proto[key];
      if (typeof handler !== 'function') continue;
      const message: unknown = Reflect.getMetadata('message', handler);
      if (typeof message === 'string') events.push(message);
    }
    return events;
  };

  it.each(['send_chat', 'chat_message', 'send_message'])(
    'does not expose a generic %s relay',
    (event) => {
      expect(subscribedEvents()).not.toContain(event);
    },
  );

  it('still exposes the room join/leave/heartbeat/ping surface', () => {
    const events = subscribedEvents();
    // Stacked `@SubscribeMessage` decorators do NOT register aliases: they all
    // write the same `message` metadata key, and decorators apply bottom-up, so
    // the TOP-most name is the only one Nest ever binds. `join_room`,
    // `leave_room`, `room:heartbeat` and `stay_heartbeat` therefore reach no
    // handler — which is safe only because every client emits the colon form
    // alongside them. Pinned here so the real surface is visible.
    expect(events).toEqual(
      expect.arrayContaining(['room:join', 'room:leave', 'room:stay_heartbeat', 'ping']),
    );
    expect(events).not.toContain('join_room');
  });
});
