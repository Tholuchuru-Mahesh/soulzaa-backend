import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { USER_ROOM_PREFIX } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { CALL_NAMESPACE, CALL_SOCKET_EVENTS } from '../constants/calls.constants';
import {
  CALL_EVENTS,
  type CallAcceptedEvent,
  type CallBusyEvent,
  type CallCancelledEvent,
  type CallConnectedEvent,
  type CallEndedEvent,
  type CallFailedEvent,
  type CallInitiatedEvent,
  type CallMissedEvent,
  type CallRejectedEvent,
} from '../events/calls.events';

/**
 * Bridges call domain events to the `/call` namespace. Every event is delivered
 * into each recipient's per-user room (`user:<id>`), which is what makes two
 * otherwise-hard things free:
 *
 *  - **Every device rings.** All of a user's sockets sit in that room, so a call
 *    lights up their phone and their tablet at once.
 *  - **Every device stops ringing.** The accept/reject/cancel events go to the same
 *    room, so the moment one device answers, the others are told — without any
 *    device-to-device coordination, which is the part that is genuinely hard to
 *    get right otherwise.
 *
 * Each recipient gets *their own* view of the call: `peer` and `isOutgoing` are
 * inverted between the two sides, so the payload cannot be shared. The service
 * already built both views; this listener only routes them.
 */
@Injectable()
export class CallsSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    // The invitation. The callee's devices see it as an incoming call; the caller's
    // see it as "ringing" — the same row, two different screens.
    this.bus.subscribe<CallInitiatedEvent>(CALL_EVENTS.INITIATED, (e) => {
      const { calleeId, callerId, views } = e.payload;
      this.toUser(calleeId, CALL_SOCKET_EVENTS.INCOMING, views[calleeId]);
      this.toUser(callerId, CALL_SOCKET_EVENTS.RINGING, views[callerId]);
    });

    this.bus.subscribe<CallAcceptedEvent>(CALL_EVENTS.ACCEPTED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.ACCEPTED, e.payload.views),
    );

    this.bus.subscribe<CallConnectedEvent>(CALL_EVENTS.CONNECTED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.CONNECTED, e.payload.views),
    );

    this.bus.subscribe<CallRejectedEvent>(CALL_EVENTS.REJECTED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.REJECTED, e.payload.views),
    );

    this.bus.subscribe<CallCancelledEvent>(CALL_EVENTS.CANCELLED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.CANCELLED, e.payload.views),
    );

    // Addressed to the caller alone — the service decided that, and the listener
    // does not need to know why (the callee is mid-conversation).
    this.bus.subscribe<CallBusyEvent>(CALL_EVENTS.BUSY, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.BUSY, e.payload.views),
    );

    this.bus.subscribe<CallMissedEvent>(CALL_EVENTS.MISSED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.MISSED, e.payload.views),
    );

    this.bus.subscribe<CallEndedEvent>(CALL_EVENTS.ENDED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.ENDED, e.payload.views),
    );

    this.bus.subscribe<CallFailedEvent>(CALL_EVENTS.FAILED, (e) =>
      this.fanOut(e.payload.recipientIds, CALL_SOCKET_EVENTS.FAILED, e.payload.views),
    );
  }

  /** Deliver each recipient the view built for them. */
  private fanOut(userIds: string[], event: string, views: Record<string, { id: string }>): void {
    for (const userId of userIds) {
      const view = views[userId];
      if (view) this.toUser(userId, event, view);
    }
  }

  private toUser(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(
      CALL_NAMESPACE,
      `${USER_ROOM_PREFIX}${userId}`,
      event,
      payload,
    );
  }
}
