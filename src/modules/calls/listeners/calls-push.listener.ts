import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallType, NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  CALL_EVENTS,
  type CallCancelledEvent,
  type CallInitiatedEvent,
  type CallMissedEvent,
} from '../events/calls.events';

/**
 * Rings phones that are not looking at the app, and records the missed calls.
 *
 * The socket fan-out only reaches a device with a live connection. A backgrounded
 * or dozing phone has none — and a call that only reaches foregrounded apps is not
 * a calling feature. This listener is the other half of delivery.
 *
 * Three properties matter and all three are deliberate:
 *
 *  - **High priority, short TTL.** An incoming-call push must wake a dozing device
 *    immediately, and must expire rather than arrive after the ring window closed.
 *    A phone that rings for a call that no longer exists is worse than a phone that
 *    never rang.
 *  - **A collapse key per call.** The cancel/miss push shares its key with the
 *    incoming one, so a phone that was offline when the call came in receives the
 *    *outcome* rather than an invitation to a call that is already over.
 *  - **The payload is data, not prose.** The client needs the call id and type to
 *    raise its own incoming-call screen; the title/body are only what the OS draws
 *    if the app never gets to.
 *
 * Delivery goes through NOTIFICATION_SERVICE rather than DEVICE_SERVICE so that a
 * user who turned call notifications off is not rung anyway. None of these bodies
 * carry private content ("Missed voice call" is not a secret), so none of them
 * supply a `redactedBody` — a preview-off user sees exactly the same text.
 */
@Injectable()
export class CallsPushListener implements OnModuleInit {
  private readonly logger = new Logger(CallsPushListener.name);

  /** Ring pushes are worthless once the ring window has closed — expire them there. */
  private readonly ringTtlSeconds: number;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    config: ConfigService,
  ) {
    this.ringTtlSeconds = config.get<{ ringTimeoutSeconds: number }>('calls', {
      infer: true,
    })!.ringTimeoutSeconds;
  }

  onModuleInit(): void {
    this.bus.subscribe<CallInitiatedEvent>(
      CALL_EVENTS.INITIATED,
      this.safe<CallInitiatedEvent>('onIncoming', (e) => this.onIncoming(e)),
    );
    this.bus.subscribe<CallMissedEvent>(
      CALL_EVENTS.MISSED,
      this.safe<CallMissedEvent>('onMissed', (e) => this.onMissed(e)),
    );
    this.bus.subscribe<CallCancelledEvent>(
      CALL_EVENTS.CANCELLED,
      this.safe<CallCancelledEvent>('onCancelled', (e) => this.onCancelled(e)),
    );
  }

  /**
   * Isolates a handler from the publisher that triggered it.
   *
   * `InMemoryEventBus.publish()` awaits every subscriber via `emitAsync`, so
   * an *unwrapped* handler that throws would propagate its rejection all the
   * way back into whichever `CallsService` method published the event
   * (`initiate`, `cancel`, the ring-timeout reaper, ...) — failing an
   * already-committed state transition (the `Call` row is written before the
   * event is published) over a notification, which can be retried, degraded,
   * or simply missed without the call itself being wrong. A ringing phone is
   * a delivery best-effort; a call record is not. See `DeviceService
   * .pushToUser`'s own doc comment for the same rule applied one layer down.
   */
  private safe<E>(
    label: string,
    handler: (event: E) => Promise<void>,
  ): (event: E) => Promise<void> {
    return async (event: E) => {
      try {
        await handler(event);
      } catch (err) {
        this.logger.warn(`${label} failed, call state unaffected: ${(err as Error).message}`);
      }
    };
  }

  private async onIncoming(e: CallInitiatedEvent): Promise<void> {
    const { calleeId, callId, views } = e.payload;
    const view = views[calleeId];
    if (!view) return;

    const isVideo = view.type === CallType.VIDEO;
    const name = view.peer.fullName ?? view.peer.username;

    await this.notifications.notify(calleeId, {
      category: PUSH_CATEGORIES.CALL,
      title: name,
      body: isVideo ? 'Incoming video call' : 'Incoming voice call',
      priority: 'high',
      ttlSeconds: this.ringTtlSeconds,
      collapseKey: this.collapseKey(callId),
      threadId: this.collapseKey(callId),
      // An iOS device that registered a VoIP token rings even backgrounded,
      // locked, or killed — the one push type Apple delivers unconditionally.
      // See ApnsVoipPushProvider.
      preferVoipOnIos: true,
      data: {
        type: 'call_incoming',
        callId,
        callType: view.type,
        callerId: view.peer.userId,
        callerName: name,
        ...(view.peer.avatarUrl ? { callerAvatar: view.peer.avatarUrl } : {}),
      },
    });
  }

  /**
   * A missed call is durable — it belongs in the notification centre, not just as a
   * banner the user may have swiped away. The push shares the incoming call's
   * collapse key so a phone that was offline throughout is told the outcome instead
   * of being invited to a call that ended minutes ago.
   */
  private async onMissed(e: CallMissedEvent): Promise<void> {
    const { callId, views } = e.payload;
    const call = Object.values(views)[0];
    if (!call) return;

    const calleeView = views[call.calleeId];
    if (!calleeView) return;

    const name = calleeView.peer.fullName ?? calleeView.peer.username;
    const isVideo = calleeView.type === CallType.VIDEO;

    await this.notifications.create({
      userId: call.calleeId,
      type: NotificationType.MISSED_CALL,
      actorId: call.callerId,
      entityType: 'call',
      entityId: callId,
      data: { callType: calleeView.type, callerName: name },
    });

    await this.notifications.notify(call.calleeId, {
      category: PUSH_CATEGORIES.CALL,
      title: name,
      body: isVideo ? 'Missed video call' : 'Missed voice call',
      priority: 'normal',
      collapseKey: this.collapseKey(callId),
      threadId: this.collapseKey(callId),
      badge: 'unread',
      // Dismisses a still-ringing native CallKit screen on an iOS device that
      // was mid-ring when the window closed — see ApnsVoipPushProvider.
      preferVoipOnIos: true,
      data: { type: 'call_missed', callId, callType: calleeView.type, callerId: call.callerId },
    });
  }

  /**
   * The caller hung up before it was answered. No notification row and no missed-call
   * entry — the callee was never given a chance to answer, so calling it "missed"
   * would blame them for the caller's change of mind. The push exists only to
   * supersede the incoming one on a device that was offline.
   */
  private async onCancelled(e: CallCancelledEvent): Promise<void> {
    const { callId, views } = e.payload;
    const call = Object.values(views)[0];
    if (!call) return;

    const calleeView = views[call.calleeId];
    if (!calleeView) return;

    await this.notifications.notify(call.calleeId, {
      category: PUSH_CATEGORIES.CALL,
      title: calleeView.peer.fullName ?? calleeView.peer.username,
      body: 'Call cancelled',
      priority: 'normal',
      ttlSeconds: 60,
      collapseKey: this.collapseKey(callId),
      threadId: this.collapseKey(callId),
      // Dismisses a still-ringing native CallKit screen — see ApnsVoipPushProvider.
      preferVoipOnIos: true,
      data: { type: 'call_cancelled', callId },
    });
  }

  /** One key per call, shared by every push about it — see the class doc. */
  private collapseKey(callId: string): string {
    return `call_${callId}`;
  }
}
