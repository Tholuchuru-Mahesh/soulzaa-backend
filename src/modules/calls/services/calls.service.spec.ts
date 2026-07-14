import { CallEndReason, CallStatus, CallType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { CacheService } from 'src/infra/redis/cache.service';
import { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import { PrivacyAction } from 'src/modules/privacy/interfaces/privacy.interface';
import { CALL_EVENTS } from '../events/calls.events';
import { CallRepository } from '../repositories/call.repository';
import { CallViewMapper } from './call-view.mapper';
import { CallsService } from './calls.service';

const CALLER = 'user-caller';
const CALLEE = 'user-callee';
const CALL_ID = 'call-1';

const CONFIG = {
  ringTimeoutSeconds: 45,
  maxDurationSeconds: 14_400,
  connectTimeoutSeconds: 30,
  reaperIntervalSeconds: 60,
  rateMax: 10,
  rateWindowSeconds: 60,
  writeChatLog: true,
};

/** A call row as the repository returns it. */
function call(over: Record<string, unknown> = {}) {
  return {
    id: CALL_ID,
    callerId: CALLER,
    calleeId: CALLEE,
    type: CallType.VOICE,
    status: CallStatus.RINGING,
    zegoRoomId: 'zego-room-1',
    clientId: 'client-key-1',
    conversationId: null,
    ringingExpiresAt: new Date('2026-01-01T00:00:45Z'),
    acceptedAt: null,
    connectedAt: null,
    endedAt: null,
    endedBy: null,
    endReason: null,
    durationSeconds: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function card(userId: string) {
  return {
    id: userId,
    username: userId,
    fullName: null,
    avatarUrl: null,
    verified: false,
    level: 1,
    vipLevel: 0,
    country: null,
  };
}

describe('CallsService', () => {
  let repo: jest.Mocked<CallRepository>;
  let cache: jest.Mocked<CacheService>;
  let zego: jest.Mocked<ZegoTokenService>;
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let privacy: {
    isBlockedEitherWay: jest.Mock;
    check: jest.Mock;
  };
  let profiles: { getCards: jest.Mock; search: jest.Mock };
  let service: CallsService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      findLiveForUser: jest.fn().mockResolvedValue(null),
      findByClientId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      createBusy: jest.fn(),
      markAccepted: jest.fn().mockResolvedValue(true),
      markConnected: jest.fn().mockResolvedValue(true),
      terminate: jest.fn().mockResolvedValue(true),
      setConversation: jest.fn(),
      page: jest.fn(),
      findExpiredRinging: jest.fn().mockResolvedValue([]),
      findStuckAccepted: jest.fn().mockResolvedValue([]),
      findOverlongConnected: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CallRepository>;

    cache = { increment: jest.fn().mockResolvedValue(1) } as unknown as jest.Mocked<CacheService>;

    zego = {
      isConfigured: jest.fn().mockReturnValue(true),
      buildRoomToken: jest
        .fn()
        .mockReturnValue({ appId: 42, token: 'zego-token', expiresInSeconds: 3600 }),
    } as unknown as jest.Mocked<ZegoTokenService>;

    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    bus = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as unknown as jest.Mocked<IEventBus>;

    privacy = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      check: jest.fn().mockResolvedValue(true),
    };

    profiles = {
      getCards: jest.fn().mockResolvedValue([card(CALLER), card(CALLEE)]),
      search: jest.fn(),
    };

    const config = { get: jest.fn().mockReturnValue(CONFIG) };
    const views = new CallViewMapper(profiles as never);

    service = new CallsService(
      repo,
      views,
      cache,
      config as never,
      zego,
      queue as never,
      bus,
      privacy as never,
      profiles as never,
    );
  });

  const published = (name: string) =>
    bus.publish.mock.calls.map(([e]) => e).find((e) => (e as { name: string }).name === name);

  describe('initiate', () => {
    it('rings the callee and hands the caller a room token', async () => {
      repo.create.mockResolvedValue(call() as never);

      const session = await service.initiate(CALLER, {
        calleeId: CALLEE,
        type: CallType.VOICE,
        clientId: 'client-key-1',
      });

      expect(session.call.status).toBe(CallStatus.RINGING);
      expect(session.call.isOutgoing).toBe(true);
      expect(session.call.peer.userId).toBe(CALLEE);
      expect(session.credentials).toMatchObject({ appId: 42, token: 'zego-token' });
      // Each side publishes its own stream and plays the other's — derived, not exchanged.
      expect(session.credentials!.streamId).toContain(CALLER);
      expect(session.credentials!.peerStreamId).toContain(CALLEE);
      expect(published(CALL_EVENTS.INITIATED)).toBeDefined();
    });

    it('arms a ring timeout so an unanswered call cannot ring forever', async () => {
      repo.create.mockResolvedValue(call() as never);
      await service.initiate(CALLER, {
        calleeId: CALLEE,
        type: CallType.VOICE,
        clientId: 'client-key-1',
      });
      expect(queue.add).toHaveBeenCalledWith(
        'call:ring-timeout',
        { callId: CALL_ID },
        expect.objectContaining({ jobId: `ring-${CALL_ID}` }),
      );
    });

    it('uses deadline job ids BullMQ will actually accept', async () => {
      repo.create.mockResolvedValue(call() as never);
      await service.initiate(CALLER, {
        calleeId: CALLEE,
        type: CallType.VOICE,
        clientId: 'client-key-1',
      });
      // BullMQ rejects a custom job id containing ':' — it reserves the character for
      // its own Redis keys. Caught in production-shaped testing, not by a mocked queue,
      // so it is pinned here.
      const [, , opts] = queue.add.mock.calls[0];
      expect(opts.jobId).not.toContain(':');
    });

    it('refuses a call the callee’s privacy settings do not permit', async () => {
      privacy.check.mockResolvedValue(false);
      await expect(
        service.initiate(CALLER, { calleeId: CALLEE, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toThrow(BusinessException);
      expect(privacy.check).toHaveBeenCalledWith(CALLER, CALLEE, PrivacyAction.CALL);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a call between blocked users', async () => {
      privacy.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.initiate(CALLER, { calleeId: CALLEE, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toThrow(BusinessException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses to call yourself', async () => {
      await expect(
        service.initiate(CALLER, { calleeId: CALLER, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toThrow(BusinessException);
    });

    it('records a BUSY call — with no token — when the callee is already on one', async () => {
      repo.findLiveForUser.mockImplementation(async (id: string) =>
        id === CALLEE ? (call({ id: 'other-call' }) as never) : null,
      );
      repo.createBusy.mockResolvedValue(
        call({ status: CallStatus.BUSY, endReason: CallEndReason.BUSY }) as never,
      );

      const session = await service.initiate(CALLER, {
        calleeId: CALLEE,
        type: CallType.VOICE,
        clientId: 'c',
      });

      expect(session.call.status).toBe(CallStatus.BUSY);
      // No room to join — handing out a token for a call that never started is a bug
      // the client would otherwise have to defend against.
      expect(session.credentials).toBeNull();
      expect(repo.create).not.toHaveBeenCalled();

      // The callee is mid-conversation and must not be interrupted by a call they
      // will never see, so the event is addressed to the caller alone.
      const event = published(CALL_EVENTS.BUSY) as { payload: { recipientIds: string[] } };
      expect(event.payload.recipientIds).toEqual([CALLER]);
    });

    it('refuses when the caller is already in a call (not the same as the callee being busy)', async () => {
      repo.findLiveForUser.mockImplementation(async (id: string) =>
        id === CALLER ? (call({ id: 'my-other-call' }) as never) : null,
      );
      await expect(
        service.initiate(CALLER, { calleeId: CALLEE, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toMatchObject({ errorCode: 'CALL_ALREADY_ACTIVE' });
    });

    it('is idempotent on clientId — a double-tap resolves to the one call', async () => {
      repo.findByClientId.mockResolvedValue(call() as never);

      const session = await service.initiate(CALLER, {
        calleeId: CALLEE,
        type: CallType.VOICE,
        clientId: 'client-key-1',
      });

      expect(session.call.id).toBe(CALL_ID);
      expect(repo.create).not.toHaveBeenCalled();
      // A retry is the same call, so it must not spend a rate-limit token...
      expect(cache.increment).not.toHaveBeenCalled();
      // ...nor ring the callee a second time.
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('rate-limits call spam', async () => {
      cache.increment.mockResolvedValue(11); // over rateMax of 10
      await expect(
        service.initiate(CALLER, { calleeId: CALLEE, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toMatchObject({ errorCode: 'CALL_RATE_LIMITED' });
    });

    it('503s cleanly when ZEGO is not configured, rather than ringing a call nobody can join', async () => {
      zego.isConfigured.mockReturnValue(false);
      await expect(
        service.initiate(CALLER, { calleeId: CALLEE, type: CallType.VOICE, clientId: 'c' }),
      ).rejects.toMatchObject({ errorCode: 'VOICE_NOT_CONFIGURED' });
    });
  });

  describe('accept', () => {
    it('answers a ringing call and returns the callee’s credentials', async () => {
      repo.findById
        .mockResolvedValueOnce(call() as never)
        .mockResolvedValue(call({ status: CallStatus.ACCEPTED, acceptedAt: new Date() }) as never);

      const session = await service.accept(CALLEE, CALL_ID);

      expect(repo.markAccepted).toHaveBeenCalledWith(CALL_ID);
      expect(session.call.status).toBe(CallStatus.ACCEPTED);
      expect(session.call.isOutgoing).toBe(false);
      expect(session.call.peer.userId).toBe(CALLER);
      expect(session.credentials!.streamId).toContain(CALLEE);
      expect(published(CALL_EVENTS.ACCEPTED)).toBeDefined();
    });

    it('loses the accept-vs-cancel race gracefully', async () => {
      // Read says RINGING; by the time we write, the caller has cancelled.
      repo.findById
        .mockResolvedValueOnce(call() as never)
        .mockResolvedValue(call({ status: CallStatus.CANCELLED }) as never);
      repo.markAccepted.mockResolvedValue(false);

      await expect(service.accept(CALLEE, CALL_ID)).rejects.toMatchObject({
        errorCode: 'CALL_INVALID_STATE',
      });
      expect(published(CALL_EVENTS.ACCEPTED)).toBeUndefined();
    });

    it('is idempotent — a retried accept returns the live session rather than failing', async () => {
      repo.findById.mockResolvedValue(call({ status: CallStatus.ACCEPTED }) as never);

      const session = await service.accept(CALLEE, CALL_ID);

      expect(session.call.status).toBe(CallStatus.ACCEPTED);
      expect(session.credentials).not.toBeNull();
      expect(repo.markAccepted).not.toHaveBeenCalled();
    });

    it('refuses to let the caller answer their own call', async () => {
      repo.findById.mockResolvedValue(call() as never);
      await expect(service.accept(CALLER, CALL_ID)).rejects.toMatchObject({
        errorCode: 'CALL_NOT_PARTICIPANT',
      });
    });

    it('hides a call between two other people behind a 404, not a 403', async () => {
      repo.findById.mockResolvedValue(call() as never);
      await expect(service.accept('someone-else', CALL_ID)).rejects.toMatchObject({
        errorCode: 'CALL_NOT_FOUND',
      });
    });
  });

  describe('reject / cancel', () => {
    it('lets the callee decline a ringing call', async () => {
      repo.findById
        .mockResolvedValueOnce(call() as never)
        .mockResolvedValue(
          call({ status: CallStatus.REJECTED, endReason: CallEndReason.DECLINED }) as never,
        );

      const view = await service.reject(CALLEE, CALL_ID);

      expect(view.status).toBe(CallStatus.REJECTED);
      expect(repo.terminate).toHaveBeenCalledWith(
        CALL_ID,
        [CallStatus.RINGING],
        expect.objectContaining({ status: CallStatus.REJECTED, endedBy: CALLEE }),
      );
      expect(published(CALL_EVENTS.REJECTED)).toBeDefined();
    });

    it('will not let the caller "reject" their own call', async () => {
      repo.findById.mockResolvedValue(call() as never);
      await expect(service.reject(CALLER, CALL_ID)).rejects.toMatchObject({
        errorCode: 'CALL_NOT_PARTICIPANT',
      });
    });

    it('lets the caller withdraw before it is answered', async () => {
      repo.findById
        .mockResolvedValueOnce(call() as never)
        .mockResolvedValue(call({ status: CallStatus.CANCELLED }) as never);

      const view = await service.cancel(CALLER, CALL_ID);

      expect(view.status).toBe(CallStatus.CANCELLED);
      expect(published(CALL_EVENTS.CANCELLED)).toBeDefined();
    });
  });

  describe('connect and end', () => {
    it('starts the duration clock only when media actually flows', async () => {
      repo.findById
        .mockResolvedValueOnce(call({ status: CallStatus.ACCEPTED }) as never)
        .mockResolvedValue(
          call({ status: CallStatus.CONNECTED, connectedAt: new Date() }) as never,
        );

      const view = await service.markConnected(CALLEE, CALL_ID);

      expect(repo.markConnected).toHaveBeenCalledWith(CALL_ID);
      expect(view.status).toBe(CallStatus.CONNECTED);
      expect(published(CALL_EVENTS.CONNECTED)).toBeDefined();
    });

    it('treats the second device reporting "connected" as success, not a conflict', async () => {
      repo.findById.mockResolvedValue(call({ status: CallStatus.CONNECTED }) as never);

      const view = await service.markConnected(CALLER, CALL_ID);

      expect(view.status).toBe(CallStatus.CONNECTED);
      expect(repo.markConnected).not.toHaveBeenCalled();
    });

    it('bills the duration from connectedAt, not from acceptedAt', async () => {
      const connectedAt = new Date(Date.now() - 65_000); // 65s of media
      repo.findById
        .mockResolvedValueOnce(call({ status: CallStatus.CONNECTED, connectedAt }) as never)
        .mockResolvedValue(
          call({ status: CallStatus.ENDED, connectedAt, durationSeconds: 65 }) as never,
        );

      await service.end(CALLER, CALL_ID);

      expect(repo.terminate).toHaveBeenCalledWith(
        CALL_ID,
        [CallStatus.ACCEPTED, CallStatus.CONNECTED],
        expect.objectContaining({
          status: CallStatus.ENDED,
          endedBy: CALLER,
          durationSeconds: 65,
        }),
      );
    });

    it('reports a call that never connected as zero seconds', async () => {
      repo.findById
        .mockResolvedValueOnce(call({ status: CallStatus.ACCEPTED, connectedAt: null }) as never)
        .mockResolvedValue(call({ status: CallStatus.ENDED }) as never);

      await service.end(CALLEE, CALL_ID);

      expect(repo.terminate).toHaveBeenCalledWith(
        CALL_ID,
        expect.anything(),
        expect.objectContaining({ durationSeconds: 0 }),
      );
    });

    it('routes a hang-up on a still-ringing call to cancel (caller) or reject (callee)', async () => {
      repo.findById
        .mockResolvedValueOnce(call() as never) // end() sees RINGING
        .mockResolvedValueOnce(call() as never) // cancel() re-reads
        .mockResolvedValue(call({ status: CallStatus.CANCELLED }) as never);

      const view = await service.end(CALLER, CALL_ID);

      expect(view.status).toBe(CallStatus.CANCELLED);
      expect(published(CALL_EVENTS.CANCELLED)).toBeDefined();
    });

    it('treats hanging up an already-ended call as a no-op, not an error', async () => {
      repo.findById.mockResolvedValue(
        call({ status: CallStatus.ENDED, durationSeconds: 12 }) as never,
      );

      const view = await service.end(CALLER, CALL_ID);

      expect(view.status).toBe(CallStatus.ENDED);
      expect(repo.terminate).not.toHaveBeenCalled();
    });
  });

  describe('deadlines', () => {
    it('marks an unanswered call MISSED with nobody blamed for hanging up', async () => {
      repo.findById.mockResolvedValue(
        call({ status: CallStatus.MISSED, endReason: CallEndReason.TIMEOUT }) as never,
      );

      await service.expireRinging(CALL_ID);

      expect(repo.terminate).toHaveBeenCalledWith(
        CALL_ID,
        [CallStatus.RINGING],
        expect.objectContaining({
          status: CallStatus.MISSED,
          endReason: CallEndReason.TIMEOUT,
          endedBy: null,
        }),
      );
      expect(published(CALL_EVENTS.MISSED)).toBeDefined();
    });

    it('does not re-settle a call the callee already answered', async () => {
      repo.terminate.mockResolvedValue(false); // lost the race to accept()

      await service.expireRinging(CALL_ID);

      expect(published(CALL_EVENTS.MISSED)).toBeUndefined();
    });

    it('FAILS a call that was answered but whose media never came up', async () => {
      repo.findById.mockResolvedValue(call({ status: CallStatus.FAILED }) as never);

      await service.expireConnecting(CALL_ID);

      expect(repo.terminate).toHaveBeenCalledWith(
        CALL_ID,
        [CallStatus.ACCEPTED],
        expect.objectContaining({
          status: CallStatus.FAILED,
          endReason: CallEndReason.NETWORK,
        }),
      );
      // FAILED, not MISSED: the callee said yes and the session broke, which is a
      // different thing to tell them about.
      expect(published(CALL_EVENTS.MISSED)).toBeUndefined();
      expect(published(CALL_EVENTS.FAILED)).toBeDefined();
    });

    it('reaps calls stranded by a crashed worker', async () => {
      repo.findExpiredRinging.mockResolvedValue([call() as never]);
      repo.findById.mockResolvedValue(call({ status: CallStatus.MISSED }) as never);

      const result = await service.reap();

      expect(result.missed).toBe(1);
      expect(repo.terminate).toHaveBeenCalled();
    });
  });

  describe('active (call recovery)', () => {
    it('hands a relaunching app back into its live call', async () => {
      repo.findLiveForUser.mockResolvedValue(call({ status: CallStatus.CONNECTED }) as never);

      const session = await service.active(CALLEE);

      expect(session!.call.status).toBe(CallStatus.CONNECTED);
      expect(session!.credentials).not.toBeNull();
    });

    it('returns null when there is nothing to rejoin', async () => {
      repo.findLiveForUser.mockResolvedValue(null);
      expect(await service.active(CALLEE)).toBeNull();
    });
  });

  describe('canCall', () => {
    it('allows a permitted call', async () => {
      expect(await service.canCall(CALLER, CALLEE)).toEqual({ allowed: true, reason: null });
    });

    it('reports the reason so the client can grey out the button', async () => {
      privacy.check.mockResolvedValue(false);
      expect(await service.canCall(CALLER, CALLEE)).toEqual({
        allowed: false,
        reason: 'CALL_NOT_ALLOWED',
      });
    });

    it('reports a block as a block', async () => {
      privacy.isBlockedEitherWay.mockResolvedValue(true);
      expect(await service.canCall(CALLER, CALLEE)).toEqual({
        allowed: false,
        reason: 'CALL_BLOCKED',
      });
    });
  });

  describe('renewToken', () => {
    it('re-issues a token so a long call is not dropped mid-sentence', async () => {
      repo.findById.mockResolvedValue(call({ status: CallStatus.CONNECTED }) as never);

      const creds = await service.renewToken(CALLER, CALL_ID);

      expect(creds.token).toBe('zego-token');
      expect(creds.zegoRoomId).toBe('zego-room-1');
    });

    it('refuses to issue a token for a call that is over', async () => {
      repo.findById.mockResolvedValue(call({ status: CallStatus.ENDED }) as never);
      await expect(service.renewToken(CALLER, CALL_ID)).rejects.toThrow(BusinessException);
    });
  });
});
