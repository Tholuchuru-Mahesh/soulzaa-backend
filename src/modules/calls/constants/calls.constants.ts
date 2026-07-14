import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/**
 * Calls module constants: the socket namespace, `call.*` event names, queue/job
 * names, Redis key builders and the stream-id convention. Tunable numbers (ring
 * timeout, max duration, rate limits) live in the `calls` config namespace.
 */

/** Socket.IO namespace the CallGateway serves (see infra/socket). */
export const CALL_NAMESPACE = SOCKET_NAMESPACES.CALL;

/**
 * Client-facing realtime event names. Every one is delivered into the per-user
 * room (`user:<id>`) of each participant on the `/call` namespace, exactly like
 * chat: no `room:join` handshake is needed before a phone can ring, and every
 * device a user owns rings at once — which is also how the *other* devices learn
 * to stop ringing the moment one of them answers.
 *
 * The namespace is fan-out only. A client never emits a call command over the
 * socket; every mutation is a REST call, matching the platform convention and
 * keeping auth, validation, rate limiting and the error envelope uniform.
 */
export const CALL_SOCKET_EVENTS = {
  /** To the callee's devices: a call is coming in. Carries no token — see CallSessionView. */
  INCOMING: 'call.incoming',
  /** To the caller: the invitation was persisted and dispatched. */
  RINGING: 'call.ringing',
  /** To both: the callee answered. Each side fetches its own credentials. */
  ACCEPTED: 'call.accepted',
  /** To both: media is flowing; the duration clock has started. */
  CONNECTED: 'call.connected',
  /** To both: the callee declined. */
  REJECTED: 'call.rejected',
  /** To both: the caller withdrew before it was answered. */
  CANCELLED: 'call.cancelled',
  /** To the caller: the callee was already on another call. */
  BUSY: 'call.busy',
  /** To both: the ring window closed with no answer. */
  MISSED: 'call.missed',
  /** To both: the call is over. Carries the final duration. */
  ENDED: 'call.ended',
  /** To both: the session could not be established or was lost past recovery. */
  FAILED: 'call.failed',
} as const;

/** Calls-owned BullMQ queue. Separate worker so a ring timeout can never queue
 * behind a slow media-processing job — a late timeout is a stuck phone. */
export const CALL_QUEUES = {
  CALLS: 'calls',
} as const;

export const CALL_JOBS = {
  /** Fires at `ringingExpiresAt`; marks a still-RINGING call MISSED. */
  RING_TIMEOUT: 'call:ring-timeout',
  /** Fires after the connect grace period; fails a call stuck in ACCEPTED. */
  CONNECT_TIMEOUT: 'call:connect-timeout',
  /** Repeatable sweep for calls stranded by a crashed client or worker. */
  REAP: 'call:reap',
} as const;

/** Payload of every deadline job on the calls queue. */
export interface CallDeadlineJob {
  callId: string;
  /** Set on the max-duration job, which shares the connect-timeout job name. */
  maxDuration?: boolean;
}

/**
 * Deterministic BullMQ job ids for a call's deadlines, so a retried request cannot
 * arm the same timeout twice and a settled call can drop the ones still pending.
 *
 * Hyphens, not colons: BullMQ rejects a custom job id containing `:` (it reserves
 * the character for its own Redis key structure).
 */
export const CALL_JOB_IDS = {
  ring: (callId: string) => `ring-${callId}`,
  connect: (callId: string) => `connect-${callId}`,
  maxDuration: (callId: string) => `max-${callId}`,
} as const;

/** Rolling call-placement counter for a caller (per rate window). */
export function callRateKey(userId: string): string {
  return `call:rate:{${userId}}`;
}

/**
 * The ZEGO stream a participant publishes.
 *
 * Derived from (call, user) rather than exchanged over the wire, so each side can
 * compute the peer's stream id the instant it knows the call — one less round trip
 * between "answered" and "hearing a voice", on the path where latency is felt most.
 */
export function callStreamId(callId: string, userId: string): string {
  return `call_${callId}_${userId}`;
}

/** Statuses in which a call is live — i.e. occupies its participants. */
export const LIVE_CALL_STATUSES = ['RINGING', 'ACCEPTED', 'CONNECTED'] as const;
