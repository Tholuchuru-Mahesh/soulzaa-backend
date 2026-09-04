import { Injectable } from '@nestjs/common';
import { Call, CallEndReason, CallStatus, CallType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { CallHistoryFilter } from '../interfaces/calls.service.interface';

/** Statuses in which a call occupies its participants. */
const LIVE: CallStatus[] = [CallStatus.RINGING, CallStatus.ACCEPTED, CallStatus.CONNECTED];

/** The fields a terminal transition writes. */
export interface TerminateInput {
  status: CallStatus;
  endReason: CallEndReason;
  endedBy?: string | null;
  durationSeconds?: number;
}

/**
 * Data layer for calls. Pure persistence: the privacy gate, the busy rule and
 * view assembly live in the service.
 *
 * Every state change goes through a **conditional** update — `updateMany` with the
 * permitted source statuses in the WHERE clause — and reports whether it won. That
 * is what makes the lifecycle correct under concurrency without a single lock: when
 * the caller cancels at the same instant the callee accepts, both updates race on
 * the same row, exactly one matches `status: RINGING`, and the loser is told it
 * lost instead of overwriting a decided call.
 */
@Injectable()
export class CallRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Lookup ----

  findById(id: string): Promise<Call | null> {
    return this.prisma.call.findUnique({ where: { id } });
  }

  /** The user's live call, if any — they are in at most one at a time. */
  findLiveForUser(userId: string): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: {
        status: { in: LIVE },
        OR: [{ callerId: userId }, { calleeId: userId }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The call that would legitimately block `userId` from placing a *new* one —
   * every live call they are the caller of, plus every live call they are the
   * callee of that they have actually been rung for.
   *
   * Deliberately narrower than `findLiveForUser`: an undelivered RINGING row —
   * the push/socket never reached this device — has not made this user busy in
   * any sense they would recognize, so it must not be the reason their own
   * outgoing call fails with "You are already in a call". Nothing else reads
   * this: the callee's own `active()` recovery call and a third party's busy
   * check when calling them both still need `findLiveForUser` unchanged, since
   * an undelivered ring is still very much a real, pending call server-side.
   */
  findBlockingCallFor(userId: string): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: {
        OR: [
          { callerId: userId, status: { in: LIVE } },
          { calleeId: userId, status: { in: [CallStatus.ACCEPTED, CallStatus.CONNECTED] } },
          { calleeId: userId, status: CallStatus.RINGING, deliveredAt: { not: null } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Resolve a previous attempt with the same idempotency key. */
  findByClientId(callerId: string, clientId: string): Promise<Call | null> {
    return this.prisma.call.findUnique({
      where: { callerId_clientId: { callerId, clientId } },
    });
  }

  // ---- Create ----

  /**
   * Persist the invitation. Idempotent on `(callerId, clientId)`: a double-tapped
   * call button, or a retry after a flaky network, converges on the first row
   * rather than ringing the callee twice.
   */
  async create(input: {
    callerId: string;
    calleeId: string;
    type: CallType;
    clientId: string;
    zegoRoomId: string;
    ringingExpiresAt: Date;
    conversationId: string | null;
  }): Promise<Call> {
    try {
      return await this.prisma.call.create({ data: input });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByClientId(input.callerId, input.clientId);
        if (existing) return existing;
      }
      throw e;
    }
  }

  /**
   * Record a call that was over before it began — the callee was busy. A real row,
   * because "I tried to reach you" is history the caller is owed, and the callee
   * will see it as a missed call once they hang up.
   */
  createBusy(input: {
    callerId: string;
    calleeId: string;
    type: CallType;
    clientId: string;
    zegoRoomId: string;
    conversationId: string | null;
  }): Promise<Call> {
    const now = new Date();
    return this.prisma.call.create({
      data: {
        ...input,
        status: CallStatus.BUSY,
        endReason: CallEndReason.BUSY,
        ringingExpiresAt: now,
        endedAt: now,
      },
    });
  }

  // ---- Transitions (conditional; report whether they won the race) ----

  /** RINGING → ACCEPTED. False when the call was already cancelled, missed or answered. */
  markAccepted(id: string): Promise<boolean> {
    return this.transition(id, [CallStatus.RINGING], {
      status: CallStatus.ACCEPTED,
      acceptedAt: new Date(),
    });
  }

  /**
   * ACCEPTED → CONNECTED. The duration clock starts here rather than at ACCEPTED,
   * because a call whose media never established lasted zero seconds no matter how
   * long the SDK spent trying.
   */
  markConnected(id: string): Promise<boolean> {
    return this.transition(id, [CallStatus.ACCEPTED], {
      status: CallStatus.CONNECTED,
      connectedAt: new Date(),
    });
  }

  /**
   * Move a live call to a terminal state. `from` names the only statuses the
   * transition is legal from, so an end() arriving after a reject() is rejected
   * rather than rewriting the outcome.
   */
  terminate(id: string, from: CallStatus[], input: TerminateInput): Promise<boolean> {
    return this.transition(id, from, {
      status: input.status,
      endReason: input.endReason,
      endedBy: input.endedBy ?? null,
      endedAt: new Date(),
      durationSeconds: input.durationSeconds ?? 0,
    });
  }

  private async transition(
    id: string,
    from: CallStatus[],
    data: Prisma.CallUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.call.updateMany({
      where: { id, status: { in: from } },
      data,
    });
    return count > 0;
  }

  /** Attach the DM thread once one exists (opened lazily on the first connected call). */
  async setConversation(id: string, conversationId: string): Promise<void> {
    await this.prisma.call.update({ where: { id }, data: { conversationId } });
  }

  /**
   * Record that the callee's device actually rendered this ring. Idempotent and
   * silent by design: a duplicate signal (the live socket *and* the background
   * push both confirming) or one that arrives after the call already moved on
   * is a no-op, not an error — this is a delivery receipt, not a transition.
   */
  async markDelivered(id: string): Promise<void> {
    await this.prisma.call.updateMany({
      where: { id, status: CallStatus.RINGING, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }

  // ---- History ----

  async page(
    userId: string,
    input: { skip: number; limit: number; filter: CallHistoryFilter; peerIds?: string[] },
  ): Promise<{ rows: Call[]; total: number }> {
    const where = this.historyWhere(userId, input.filter, input.peerIds);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.call.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: input.skip,
        take: input.limit,
      }),
      this.prisma.call.count({ where }),
    ]);
    return { rows, total };
  }

  private historyWhere(
    userId: string,
    filter: CallHistoryFilter,
    peerIds?: string[],
  ): Prisma.CallWhereInput {
    // A peer filter of [] means "the search matched nobody" — which must return
    // nothing, not everything. Undefined means "no search was run".
    const peer: Prisma.CallWhereInput | undefined = peerIds
      ? { OR: [{ callerId: { in: peerIds } }, { calleeId: { in: peerIds } }] }
      : undefined;

    const base: Prisma.CallWhereInput =
      filter === 'INCOMING'
        ? { calleeId: userId }
        : filter === 'OUTGOING'
          ? { callerId: userId }
          : filter === 'MISSED'
            ? // "Missed" is the callee's word. An unanswered call the *user placed*
              // is not a call they missed, so this is deliberately one-sided.
              { calleeId: userId, status: { in: [CallStatus.MISSED, CallStatus.BUSY] } }
            : { OR: [{ callerId: userId }, { calleeId: userId }] };

    return peer ? { AND: [base, peer] } : base;
  }

  // ---- Reaper reads ----

  /** Calls whose ring window lapsed while nobody was watching. */
  findExpiredRinging(now: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { status: CallStatus.RINGING, ringingExpiresAt: { lte: now } },
      take: limit,
    });
  }

  /** Answered, but media never came up within the grace period. */
  findStuckAccepted(before: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { status: CallStatus.ACCEPTED, acceptedAt: { lte: before } },
      take: limit,
    });
  }

  /** Connected past the hard ceiling — a client died without hanging up. */
  findOverlongConnected(before: Date, limit: number): Promise<Call[]> {
    return this.prisma.call.findMany({
      where: { status: CallStatus.CONNECTED, connectedAt: { lte: before } },
      take: limit,
    });
  }
}
