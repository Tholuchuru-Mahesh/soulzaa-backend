import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Call, CallEndReason, CallStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { CacheService } from 'src/infra/redis/cache.service';
import { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import {
  PRIVACY_SERVICE,
  PrivacyAction,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  CALL_JOB_IDS,
  CALL_JOBS,
  CALL_QUEUES,
  callRateKey,
  callStreamId,
} from '../constants/calls.constants';
import {
  CallAcceptedEvent,
  CallBusyEvent,
  CallCancelledEvent,
  CallConnectedEvent,
  CallEndedEvent,
  CallFailedEvent,
  CallInitiatedEvent,
  CallMissedEvent,
  CallRejectedEvent,
} from '../events/calls.events';
import type {
  CallCredentials,
  CallPermissionView,
  CallSessionView,
  CallView,
  ICallsService,
  InitiateCallInput,
  ListCallsInput,
} from '../interfaces/calls.service.interface';
import { CallRepository } from '../repositories/call.repository';
import { CallViewMapper } from './call-view.mapper';

interface CallsConfig {
  ringTimeoutSeconds: number;
  maxDurationSeconds: number;
  connectTimeoutSeconds: number;
  reaperIntervalSeconds: number;
  rateMax: number;
  rateWindowSeconds: number;
  writeChatLog: boolean;
}

/** Statuses from which a hang-up is legal. */
const HANGUP_FROM: CallStatus[] = [CallStatus.ACCEPTED, CallStatus.CONNECTED];

/**
 * The 1:1 call lifecycle. Owns the invitation, the accept/reject/cancel race, the
 * ring and connect deadlines, token issuance, and history.
 *
 * Three rules shape everything here:
 *
 * 1. **The server decides, the client reports.** A client may say "my media came up"
 *    or "my media died"; it may not say "this call was missed" or "that user was
 *    busy". Anything a client could lie about to rewrite history is the server's.
 *
 * 2. **Every transition is conditional.** State changes go through `updateMany` with
 *    the legal source statuses in the WHERE clause, so the accept-vs-cancel race is
 *    settled by the database rather than by a lock — exactly one of them matches
 *    `RINGING`, and the loser is told it lost.
 *
 * 3. **A ringing call always has a deadline that outlives its process.** The ring
 *    window is persisted on the row *and* armed as a delayed job. If the job is lost
 *    (worker restart), the reaper still finds the row; if the row were the only
 *    record, a crashed worker would strand a phone ringing forever.
 */
@Injectable()
export class CallsService implements ICallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly calls: CallRepository,
    private readonly views: CallViewMapper,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly zego: ZegoTokenService,
    @InjectQueue(CALL_QUEUES.CALLS) private readonly queue: Queue,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  private get cfg(): CallsConfig {
    return this.config.get<CallsConfig>('calls', { infer: true })!;
  }

  // ============================ Placing a call ============================

  async initiate(callerId: string, input: InitiateCallInput): Promise<CallSessionView> {
    const { calleeId, type, clientId } = input;

    if (callerId === calleeId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_CALL_SELF,
        'You cannot call yourself',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertRtcConfigured();

    // Idempotency first: a retried request must not spend a rate-limit token, and
    // must not be gated a second time — it is the *same* call, not a new one.
    const existing = await this.calls.findByClientId(callerId, clientId);
    if (existing) return this.sessionFor(existing, callerId);

    await this.assertNotRateLimited(callerId);
    await this.assertMayCall(callerId, calleeId);

    // The caller must not already be in a call. This is a distinct failure from the
    // callee being busy — it is the caller's own device that is confused (a stale
    // screen, a call it never hung up), and telling them "they're busy" would be a lie.
    // `findBlockingCallFor`, not `findLiveForUser`: an inbound ring this same user
    // never actually saw (undelivered) must not be the reason their own outgoing
    // call fails — see the repository doc comment.
    const callerLive = await this.calls.findBlockingCallFor(callerId);
    if (callerLive) {
      throw new BusinessException(
        ERROR_CODES.CALL_ALREADY_ACTIVE,
        'You are already in a call',
        HttpStatus.CONFLICT,
      );
    }

    const conversationId = null;

    // The callee is busy: still a real row, because "I tried to reach you" is
    // history the caller is owed and a missed call the callee will want to see.
    const calleeLive = await this.calls.findLiveForUser(calleeId);
    if (calleeLive) {
      const busy = await this.calls.createBusy({
        callerId,
        calleeId,
        type,
        clientId,
        zegoRoomId: randomUUID(),
        conversationId,
      });
      const views = await this.views.bothViews(busy);
      // Addressed to the caller alone — the callee is mid-conversation and must not
      // be interrupted by a call they will never see.
      await this.bus.publish(
        new CallBusyEvent({ recipientIds: [callerId], views, callId: busy.id }),
      );
      return { call: views[callerId], credentials: null };
    }

    const call = await this.calls.create({
      callerId,
      calleeId,
      type,
      clientId,
      zegoRoomId: randomUUID(),
      ringingExpiresAt: new Date(Date.now() + this.cfg.ringTimeoutSeconds * 1000),
      conversationId,
    });

    await this.armRingTimeout(call);

    const views = await this.views.bothViews(call);
    await this.bus.publish(
      new CallInitiatedEvent({
        recipientIds: [callerId, calleeId],
        views,
        callId: call.id,
        callerId,
        calleeId,
      }),
    );

    return { call: views[callerId], credentials: this.credentialsFor(call, callerId) };
  }

  // ============================ Answering ============================

  async accept(userId: string, callId: string): Promise<CallSessionView> {
    const call = await this.require(callId, userId);

    // Idempotent for the device that already won: a retried accept after a flaky
    // response must return the session, not fail the user out of a live call.
    if (call.status === CallStatus.ACCEPTED || call.status === CallStatus.CONNECTED) {
      this.assertCallee(call, userId);
      return this.sessionFor(call, userId);
    }
    this.assertCallee(call, userId);
    this.assertStatus(call, [CallStatus.RINGING]);

    const won = await this.calls.markAccepted(callId);
    if (!won) {
      // The caller cancelled, or the ring window closed, in the moment between the
      // read above and this write. Re-read and report what actually happened.
      const settled = await this.require(callId, userId);
      throw this.invalidState(settled.status, 'accept');
    }

    const accepted = await this.require(callId, userId);
    await this.armConnectTimeout(accepted);

    const views = await this.views.bothViews(accepted);
    await this.bus.publish(
      new CallAcceptedEvent({
        recipientIds: [accepted.callerId, accepted.calleeId],
        views,
        callId,
        acceptedBy: userId,
      }),
    );

    return { call: views[userId], credentials: this.credentialsFor(accepted, userId) };
  }

  async reject(userId: string, callId: string): Promise<CallView> {
    const call = await this.require(callId, userId);
    this.assertCallee(call, userId);
    this.assertStatus(call, [CallStatus.RINGING]);

    const won = await this.calls.terminate(callId, [CallStatus.RINGING], {
      status: CallStatus.REJECTED,
      endReason: CallEndReason.DECLINED,
      endedBy: userId,
    });
    if (!won) throw this.invalidState((await this.require(callId, userId)).status, 'reject');

    return this.settle(callId, userId, (views, ended) =>
      this.bus.publish(
        new CallRejectedEvent({
          recipientIds: [ended.callerId, ended.calleeId],
          views,
          callId,
          rejectedBy: userId,
        }),
      ),
    );
  }

  async cancel(userId: string, callId: string): Promise<CallView> {
    const call = await this.require(callId, userId);
    this.assertCaller(call, userId);
    this.assertStatus(call, [CallStatus.RINGING]);

    const won = await this.calls.terminate(callId, [CallStatus.RINGING], {
      status: CallStatus.CANCELLED,
      endReason: CallEndReason.CANCELLED,
      endedBy: userId,
    });
    if (!won) throw this.invalidState((await this.require(callId, userId)).status, 'cancel');

    return this.settle(callId, userId, (views, ended) =>
      this.bus.publish(
        new CallCancelledEvent({
          recipientIds: [ended.callerId, ended.calleeId],
          views,
          callId,
          cancelledBy: userId,
        }),
      ),
    );
  }

  /**
   * The callee's device confirms it actually rendered this ring — the native
   * incoming-call screen came up, or the live socket delivered the event.
   * Callee only. Silently a no-op once the call has moved past RINGING, or if
   * it was already confirmed — this is a delivery receipt, not a transition,
   * and the client may legitimately call it from more than one place (the live
   * socket handler, the background push handler) for the same ring.
   */
  async markDelivered(userId: string, callId: string): Promise<void> {
    const call = await this.require(callId, userId);
    this.assertCallee(call, userId);
    await this.calls.markDelivered(callId);
  }

  // ============================ In the call ============================

  async markConnected(userId: string, callId: string): Promise<CallView> {
    const call = await this.require(callId, userId);

    // Both devices report "connected" — whoever's media comes up second finds the
    // call already CONNECTED. That is success, not a conflict.
    if (call.status === CallStatus.CONNECTED) return this.views.view(call, userId);
    this.assertStatus(call, [CallStatus.ACCEPTED]);

    const won = await this.calls.markConnected(callId);
    if (!won) {
      const settled = await this.require(callId, userId);
      if (settled.status === CallStatus.CONNECTED) return this.views.view(settled, userId);
      throw this.invalidState(settled.status, 'connect');
    }

    const connected = await this.require(callId, userId);
    await this.armMaxDuration(connected);

    const views = await this.views.bothViews(connected);
    await this.bus.publish(
      new CallConnectedEvent({
        recipientIds: [connected.callerId, connected.calleeId],
        views,
        callId,
      }),
    );
    return views[userId];
  }

  async end(userId: string, callId: string): Promise<CallView> {
    const call = await this.require(callId, userId);

    // Hanging up a call that is already over is not an error — it is what a client
    // does when its "end" tap races the peer's. Report the settled call.
    if (this.isTerminal(call.status)) return this.views.view(call, userId);
    // A hang-up while still RINGING is a cancel (caller) or a reject (callee). The
    // client should not have to know that, so route it rather than refuse it.
    if (call.status === CallStatus.RINGING) {
      return call.callerId === userId ? this.cancel(userId, callId) : this.reject(userId, callId);
    }

    const won = await this.calls.terminate(callId, HANGUP_FROM, {
      status: CallStatus.ENDED,
      endReason: CallEndReason.HANGUP,
      endedBy: userId,
      durationSeconds: this.durationOf(call),
    });
    if (!won) return this.views.view(await this.require(callId, userId), userId);

    return this.settle(callId, userId, (views, ended) =>
      this.bus.publish(
        new CallEndedEvent({
          recipientIds: [ended.callerId, ended.calleeId],
          views,
          callId,
          endedBy: userId,
          durationSeconds: ended.durationSeconds,
        }),
      ),
    );
  }

  async fail(userId: string, callId: string, reason: CallEndReason): Promise<CallView> {
    const call = await this.require(callId, userId);
    if (this.isTerminal(call.status)) return this.views.view(call, userId);

    const won = await this.calls.terminate(callId, [CallStatus.RINGING, ...HANGUP_FROM], {
      status: CallStatus.FAILED,
      endReason: reason,
      endedBy: userId,
      durationSeconds: this.durationOf(call),
    });
    if (!won) return this.views.view(await this.require(callId, userId), userId);

    return this.settle(callId, userId, (views, ended) =>
      this.bus.publish(
        new CallFailedEvent({
          recipientIds: [ended.callerId, ended.calleeId],
          views,
          callId,
        }),
      ),
    );
  }

  async renewToken(userId: string, callId: string): Promise<CallCredentials> {
    const call = await this.require(callId, userId);
    if (this.isTerminal(call.status)) {
      throw this.invalidState(call.status, 'renew a token for');
    }
    this.assertRtcConfigured();
    return this.credentialsFor(call, userId);
  }

  // ============================ Reads ============================

  async active(userId: string): Promise<CallSessionView | null> {
    const call = await this.calls.findLiveForUser(userId);
    return call ? this.sessionFor(call, userId) : null;
  }

  async get(userId: string, callId: string): Promise<CallView> {
    const call = await this.require(callId, userId);
    return this.views.view(call, userId);
  }

  async history(userId: string, input: ListCallsInput): Promise<Paginated<CallView>> {
    const { page, limit, skip } = normalizePagination(input);

    // A search resolves to a set of peer ids first. An empty set is meaningful —
    // "nobody matched" must return nothing, not everything — which is why it is
    // passed through as `[]` rather than collapsed to undefined.
    const search = input.search?.trim();
    const peerIds = search
      ? (await this.profiles.search(search, { page: 1, limit: 50 }, userId)).items.map((u) => u.id)
      : undefined;

    const { rows, total } = await this.calls.page(userId, {
      skip,
      limit,
      filter: input.filter,
      peerIds,
    });

    const cards = await this.views.cards(rows.flatMap((c) => [c.callerId, c.calleeId]));
    return buildPaginated(
      rows.map((c) => this.views.toView(c, userId, cards)),
      total,
      page,
      limit,
    );
  }

  async canCall(userId: string, targetId: string): Promise<CallPermissionView> {
    if (userId === targetId) return { allowed: false, reason: 'CANNOT_CALL_SELF' };
    if (await this.privacy.isBlockedEitherWay(userId, targetId)) {
      return { allowed: false, reason: 'CALL_BLOCKED' };
    }
    const allowed = await this.privacy.check(userId, targetId, PrivacyAction.CALL);
    return allowed
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'CALL_NOT_ALLOWED' };
  }

  // ============================ Deadlines (called by the processor) ============================

  /** Ring window lapsed with no answer. Idempotent — the reaper and the job may both fire. */
  async expireRinging(callId: string): Promise<void> {
    const won = await this.calls.terminate(callId, [CallStatus.RINGING], {
      status: CallStatus.MISSED,
      endReason: CallEndReason.TIMEOUT,
      // Nobody hung up a call nobody answered.
      endedBy: null,
    });
    if (!won) return;

    const call = await this.calls.findById(callId);
    if (!call) return;

    const views = await this.views.bothViews(call);
    await this.bus.publish(
      new CallMissedEvent({
        recipientIds: [call.callerId, call.calleeId],
        views,
        callId,
      }),
    );
    this.logger.log(`call ${callId} missed (ring timeout)`);
  }

  /**
   * Answered, but media never came up. FAILED rather than MISSED: the callee said
   * yes and the session broke, which is a different thing to tell them about.
   */
  async expireConnecting(callId: string): Promise<void> {
    const won = await this.calls.terminate(callId, [CallStatus.ACCEPTED], {
      status: CallStatus.FAILED,
      endReason: CallEndReason.NETWORK,
      endedBy: null,
    });
    if (!won) return;

    const call = await this.calls.findById(callId);
    if (!call) return;

    const views = await this.views.bothViews(call);
    await this.bus.publish(
      new CallFailedEvent({ recipientIds: [call.callerId, call.calleeId], views, callId }),
    );
    this.logger.warn(`call ${callId} failed (media never connected)`);
  }

  /** Connected past the hard ceiling — a client died without hanging up. */
  async expireConnected(callId: string): Promise<void> {
    const call = await this.calls.findById(callId);
    if (!call || call.status !== CallStatus.CONNECTED) return;

    const won = await this.calls.terminate(callId, [CallStatus.CONNECTED], {
      status: CallStatus.ENDED,
      endReason: CallEndReason.HANGUP,
      endedBy: null,
      durationSeconds: this.durationOf(call),
    });
    if (!won) return;

    const ended = await this.calls.findById(callId);
    if (!ended) return;

    const views = await this.views.bothViews(ended);
    await this.bus.publish(
      new CallEndedEvent({
        recipientIds: [ended.callerId, ended.calleeId],
        views,
        callId,
        endedBy: null,
        durationSeconds: ended.durationSeconds,
      }),
    );
    this.logger.warn(`call ${callId} ended (exceeded max duration)`);
  }

  /**
   * Sweep for calls stranded by a crashed worker or client. The delayed jobs are the
   * fast path; this is the one that makes a lost job survivable rather than fatal.
   */
  async reap(): Promise<{ missed: number; failed: number; ended: number }> {
    const now = new Date();
    const cfg = this.cfg;
    const BATCH = 100;

    const ringing = await this.calls.findExpiredRinging(now, BATCH);
    for (const c of ringing) await this.expireRinging(c.id);

    const stuck = await this.calls.findStuckAccepted(
      new Date(now.getTime() - cfg.connectTimeoutSeconds * 1000),
      BATCH,
    );
    for (const c of stuck) await this.expireConnecting(c.id);

    const overlong = await this.calls.findOverlongConnected(
      new Date(now.getTime() - cfg.maxDurationSeconds * 1000),
      BATCH,
    );
    for (const c of overlong) await this.expireConnected(c.id);

    return { missed: ringing.length, failed: stuck.length, ended: overlong.length };
  }

  // ============================ Internals ============================

  /**
   * A ZEGO token scoped to this call's room, with publish privilege.
   *
   * Both participants publish and both subscribe — a 1:1 call has no audience — so
   * the role distinction that governs an audio room does not apply here.
   */
  private credentialsFor(call: Call, userId: string): CallCredentials {
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    const { appId, token, expiresInSeconds } = this.zego.buildRoomToken(
      userId,
      call.zegoRoomId,
      true,
    );
    return {
      appId,
      token,
      zegoRoomId: call.zegoRoomId,
      streamId: callStreamId(call.id, userId),
      peerStreamId: callStreamId(call.id, peerId),
      expiresInSeconds,
    };
  }

  private async sessionFor(call: Call, userId: string): Promise<CallSessionView> {
    const view = await this.views.view(call, userId);
    return {
      call: view,
      // No room to join once the call is over — and handing out a token for a dead
      // call is a bug the client would otherwise have to defend against.
      credentials: this.isTerminal(call.status) ? null : this.credentialsFor(call, userId),
    };
  }

  /** Re-read the settled row, publish through `emit`, and return the actor's view. */
  private async settle(
    callId: string,
    userId: string,
    emit: (views: Record<string, CallView>, call: Call) => Promise<void>,
  ): Promise<CallView> {
    const call = await this.require(callId, userId);
    const views = await this.views.bothViews(call);
    await emit(views, call);
    await this.disarm(callId);
    return views[userId];
  }

  private durationOf(call: Call): number {
    if (!call.connectedAt) return 0;
    return Math.max(0, Math.round((Date.now() - call.connectedAt.getTime()) / 1000));
  }

  private isTerminal(status: CallStatus): boolean {
    return (
      status !== CallStatus.RINGING &&
      status !== CallStatus.ACCEPTED &&
      status !== CallStatus.CONNECTED
    );
  }

  // ---- Deadline jobs ----

  private async armRingTimeout(call: Call): Promise<void> {
    await this.queue.add(
      CALL_JOBS.RING_TIMEOUT,
      { callId: call.id },
      {
        // Deterministic id so a retried initiate cannot arm two timeouts for one call.
        jobId: CALL_JOB_IDS.ring(call.id),
        delay: Math.max(0, call.ringingExpiresAt.getTime() - Date.now()),
      },
    );
  }

  private async armConnectTimeout(call: Call): Promise<void> {
    await this.queue.add(
      CALL_JOBS.CONNECT_TIMEOUT,
      { callId: call.id },
      { jobId: CALL_JOB_IDS.connect(call.id), delay: this.cfg.connectTimeoutSeconds * 1000 },
    );
  }

  private async armMaxDuration(call: Call): Promise<void> {
    await this.queue.add(
      CALL_JOBS.CONNECT_TIMEOUT,
      { callId: call.id, maxDuration: true },
      { jobId: CALL_JOB_IDS.maxDuration(call.id), delay: this.cfg.maxDurationSeconds * 1000 },
    );
  }

  /**
   * Drop a settled call's pending deadline jobs. Best-effort: the handlers are all
   * idempotent and re-check the status, so a job that fires anyway is harmless —
   * this just stops the queue carrying work that can no longer do anything.
   */
  private async disarm(callId: string): Promise<void> {
    await Promise.all(
      [
        CALL_JOB_IDS.ring(callId),
        CALL_JOB_IDS.connect(callId),
        CALL_JOB_IDS.maxDuration(callId),
      ].map(async (jobId) => {
        try {
          await (await this.queue.getJob(jobId))?.remove();
        } catch {
          // A job that is already running cannot be removed. Harmless — see above.
        }
      }),
    );
  }

  // ---- Guards ----

  private assertRtcConfigured(): void {
    if (!this.zego.isConfigured()) {
      throw new BusinessException(
        ERROR_CODES.VOICE_NOT_CONFIGURED,
        'Calling is temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async assertMayCall(callerId: string, calleeId: string): Promise<void> {
    if (await this.privacy.isBlockedEitherWay(callerId, calleeId)) {
      throw new BusinessException(
        ERROR_CODES.CALL_BLOCKED,
        'You cannot call this user',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!(await this.privacy.check(callerId, calleeId, PrivacyAction.CALL))) {
      throw new BusinessException(
        ERROR_CODES.CALL_NOT_ALLOWED,
        'This user does not accept calls from you',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Blunts call-spam harassment: a blocked user cannot call, but an unblocked one
   * should not be able to ring a phone thirty times a minute either. */
  private async assertNotRateLimited(callerId: string): Promise<void> {
    const cfg = this.cfg;
    const count = await this.cache.increment(callRateKey(callerId), {
      ttlSeconds: cfg.rateWindowSeconds,
    });
    if (count > cfg.rateMax) {
      throw new BusinessException(
        ERROR_CODES.CALL_RATE_LIMITED,
        'You are placing calls too quickly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async require(callId: string, userId: string): Promise<Call> {
    const call = await this.calls.findById(callId);
    if (!call) {
      throw new BusinessException(
        ERROR_CODES.CALL_NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      // 404, not 403: confirming a call exists between two other people is itself a
      // leak, and there is nothing this user is entitled to learn from the difference.
      throw new BusinessException(
        ERROR_CODES.CALL_NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return call;
  }

  private assertCaller(call: Call, userId: string): void {
    if (call.callerId !== userId) {
      throw new BusinessException(
        ERROR_CODES.CALL_NOT_PARTICIPANT,
        'Only the caller may do that',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertCallee(call: Call, userId: string): void {
    if (call.calleeId !== userId) {
      throw new BusinessException(
        ERROR_CODES.CALL_NOT_PARTICIPANT,
        'Only the person being called may do that',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertStatus(call: Call, allowed: CallStatus[]): void {
    if (!allowed.includes(call.status)) throw this.invalidState(call.status, 'do that to');
  }

  private invalidState(status: CallStatus, verb: string): BusinessException {
    return new BusinessException(
      status === CallStatus.BUSY ? ERROR_CODES.CALL_BUSY : ERROR_CODES.CALL_INVALID_STATE,
      `You cannot ${verb} a call that is ${status.toLowerCase()}`,
      HttpStatus.CONFLICT,
    );
  }
}
