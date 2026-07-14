import { DomainEvent } from 'src/common/events';
import type { CallView } from '../interfaces/calls.service.interface';

/**
 * Call events on the EVENT_BUS. Three listeners consume them, each owning one
 * concern: the socket listener bridges them to the `/call` namespace, the push
 * listener rings phones that are not currently connected, and the chat-log
 * listener writes the finished call into the DM thread as a CALL_LOG message.
 *
 * Every payload carries `recipientIds` — the users who should receive it — so a
 * listener never re-derives an audience, and "who sees what" stays one decision
 * made in the service. It also carries the per-recipient `views`, because a call
 * genuinely looks different to each side: `peer` and `isOutgoing` are inverted.
 */
export const CALL_EVENTS = {
  INITIATED: 'call.initiated',
  ACCEPTED: 'call.accepted',
  CONNECTED: 'call.connected',
  REJECTED: 'call.rejected',
  CANCELLED: 'call.cancelled',
  BUSY: 'call.busy',
  MISSED: 'call.missed',
  ENDED: 'call.ended',
  FAILED: 'call.failed',
} as const;

/**
 * Base shape: every call event names its recipients and carries one view per
 * recipient, keyed by user id.
 */
interface Addressed {
  recipientIds: string[];
  /** Per-recipient view — the same call is "incoming" to one side and "outgoing" to the other. */
  views: Record<string, CallView>;
  callId: string;
}

/** The invitation was persisted and the callee's phones should ring. */
export class CallInitiatedEvent extends DomainEvent<
  Addressed & { callerId: string; calleeId: string }
> {
  readonly name = CALL_EVENTS.INITIATED;
}

export class CallAcceptedEvent extends DomainEvent<Addressed & { acceptedBy: string }> {
  readonly name = CALL_EVENTS.ACCEPTED;
}

export class CallConnectedEvent extends DomainEvent<Addressed> {
  readonly name = CALL_EVENTS.CONNECTED;
}

export class CallRejectedEvent extends DomainEvent<Addressed & { rejectedBy: string }> {
  readonly name = CALL_EVENTS.REJECTED;
}

export class CallCancelledEvent extends DomainEvent<Addressed & { cancelledBy: string }> {
  readonly name = CALL_EVENTS.CANCELLED;
}

/** The callee was on another call. Addressed to the caller alone — the callee is
 * mid-conversation and must not be interrupted by a call they never saw. */
export class CallBusyEvent extends DomainEvent<Addressed> {
  readonly name = CALL_EVENTS.BUSY;
}

export class CallMissedEvent extends DomainEvent<Addressed> {
  readonly name = CALL_EVENTS.MISSED;
}

export class CallEndedEvent extends DomainEvent<
  Addressed & { endedBy: string | null; durationSeconds: number }
> {
  readonly name = CALL_EVENTS.ENDED;
}

export class CallFailedEvent extends DomainEvent<Addressed> {
  readonly name = CALL_EVENTS.FAILED;
}
