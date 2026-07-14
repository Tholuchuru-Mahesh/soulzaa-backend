import type { CallEndReason, CallStatus, CallType } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import type { SocialUserCard } from 'src/modules/social/interfaces/social.interface';

/**
 * Public contract for the calls module — the ONLY surface other modules may
 * depend on (this token, or the EVENT_BUS). Internals (repository, DTOs,
 * concrete service) stay private. Notifications and analytics subscribe to
 * `call.*` bus events rather than calling in here.
 */
export const CALLS_SERVICE = Symbol('CALLS_SERVICE');

/**
 * Everything a client needs to join the call's ZEGO room — and nothing more.
 *
 * Issued only to a participant of a call that is live, and only for that call's
 * own room. A token is scoped to one room with publish privilege, so it cannot be
 * replayed into an audio room or a later call between the same two people.
 */
export interface CallCredentials {
  appId: number;
  token: string;
  zegoRoomId: string;
  /** The stream this user publishes. */
  streamId: string;
  /** The stream this user plays. Derived, not exchanged — see `callStreamId`. */
  peerStreamId: string;
  expiresInSeconds: number;
}

export interface CallView {
  id: string;
  type: CallType;
  status: CallStatus;
  callerId: string;
  calleeId: string;
  /** The *other* participant, from the requesting user's point of view. */
  peer: SocialUserCard;
  /** Whether the requesting user placed this call. Drives incoming vs outgoing UI. */
  isOutgoing: boolean;
  /** When the ring window closes. The client shows a countdown against it. */
  ringingExpiresAt: Date;
  acceptedAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  endedBy: string | null;
  endReason: CallEndReason | null;
  /** Seconds of connected media. Zero for a call that never connected. */
  durationSeconds: number;
  /** The DM thread this call is logged into, once one exists. */
  conversationId: string | null;
  createdAt: Date;
}

/**
 * A call plus the credentials to join it.
 *
 * `credentials` is null when the call never entered a live state — a BUSY callee
 * produces a real history row but no room to join, and handing out a token for a
 * call that is already over would be a bug the client would have to defend against.
 */
export interface CallSessionView {
  call: CallView;
  credentials: CallCredentials | null;
}

export interface InitiateCallInput {
  calleeId: string;
  type: CallType;
  /** Caller-generated idempotency key — a double-tap resolves to one call. */
  clientId: string;
}

/** The history-screen filter chips. */
export type CallHistoryFilter = 'ALL' | 'INCOMING' | 'OUTGOING' | 'MISSED';

export interface ListCallsInput {
  page: number;
  limit: number;
  filter: CallHistoryFilter;
  /** Free-text match against the peer's username / full name. */
  search?: string;
  /** Keyset cursor: the id of the last call on the previous page. */
  cursor?: string;
}

/** Whether the requesting user may place a call to a target, and why not. */
export interface CallPermissionView {
  allowed: boolean;
  /** Null when allowed. Otherwise the machine-readable reason (see ERROR_CODES). */
  reason: 'CALL_BLOCKED' | 'CALL_NOT_ALLOWED' | 'CANNOT_CALL_SELF' | null;
}

export interface ICallsService {
  /**
   * Place a call. Runs the privacy gate, the block check and the busy check, mints
   * the room, persists the invitation and arms the ring timeout — all before the
   * callee's phone lights up, so a call that rings is a call that is real.
   */
  initiate(callerId: string, input: InitiateCallInput): Promise<CallSessionView>;

  /** Answer. Idempotent for the accepting device; a no-op for a call already accepted by it. */
  accept(userId: string, callId: string): Promise<CallSessionView>;

  /** Decline. Callee only. */
  reject(userId: string, callId: string): Promise<CallView>;

  /** Withdraw before it is answered. Caller only. */
  cancel(userId: string, callId: string): Promise<CallView>;

  /** Media is flowing. Starts the duration clock. Either participant may report it. */
  markConnected(userId: string, callId: string): Promise<CallView>;

  /** Hang up. Either participant, from ACCEPTED or CONNECTED. */
  end(userId: string, callId: string): Promise<CallView>;

  /** Report that the RTC session could not be established or was lost. */
  fail(userId: string, callId: string, reason: CallEndReason): Promise<CallView>;

  /**
   * Re-issue the ZEGO token for a live call.
   *
   * A long call outlives its token; ZEGO warns before expiry and the client renews
   * through here rather than being dropped mid-sentence.
   */
  renewToken(userId: string, callId: string): Promise<CallCredentials>;

  /**
   * The user's currently-live call, if any.
   *
   * This is call *recovery*: an app that was killed mid-call asks this on launch
   * and either rejoins the room or shows the incoming-call screen, instead of
   * silently dropping a conversation that is still running for the peer.
   */
  active(userId: string): Promise<CallSessionView | null>;

  get(userId: string, callId: string): Promise<CallView>;
  history(userId: string, input: ListCallsInput): Promise<Paginated<CallView>>;

  /** Pre-flight check so the client can grey out the call button rather than fail on tap. */
  canCall(userId: string, targetId: string): Promise<CallPermissionView>;
}
