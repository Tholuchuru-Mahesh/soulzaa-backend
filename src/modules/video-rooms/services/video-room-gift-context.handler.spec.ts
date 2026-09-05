import { HttpStatus } from '@nestjs/common';
import { GiftContextType, VideoRoomMemberRole, VideoRoomStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { IGiftContextHandler } from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { PkScoreUpdatedEvent, VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VideoRoomGiftContextHandler } from './video-room-gift-context.handler';

const ROOM = 'r1';
const SENDER = 'sender-1';

const REQ = {
  contextType: GiftContextType.VIDEO_ROOM,
  contextId: ROOM,
  senderId: SENDER,
  receiverIds: ['u1'],
  gift: { id: 'g1', name: 'Rocket', coinValue: 100 },
  quantity: 1,
};

const GIFT_CFG = {};
const VR_GIFT_CFG = {
  blockedCountries: '',
  maxReceivers: 9,
  allowRoomAll: 'false',
  allowViewerGiftsDefault: 'true',
  recentFeedSize: 50,
  monitorIntervalSeconds: 15,
  recoveryEnabled: 'false',
};

const member = (overrides: Record<string, unknown> = {}) => ({
  isActive: true,
  role: VideoRoomMemberRole.PARTICIPANT,
  ...overrides,
});

describe('VideoRoomGiftContextHandler', () => {
  let rooms: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let registry: { register: jest.Mock };
  let treasureProgress: Record<string, jest.Mock>;
  let pkScoring: Record<string, jest.Mock>;
  let queue: { enqueue: jest.Mock };
  let bus: { publish: jest.Mock };
  let giftLockAccessRepo: { grantAccess: jest.Mock; hasGrantedAccess: jest.Mock };
  let handler: VideoRoomGiftContextHandler;

  const setGiftConfig = (overrides: Record<string, unknown> = {}) => {
    config.get.mockImplementation((ns: string) =>
      ns === 'gift' ? GIFT_CFG : { ...VR_GIFT_CFG, ...overrides },
    );
  };

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue({ id: ROOM, status: VideoRoomStatus.LIVE }),
      getSettings: jest.fn().mockResolvedValue({ allowGifts: true, metadata: null }),
      // Mirrors `getSettings` by default (delegates to it) so every test that
      // overrides `getSettings` keeps working now that the service reads
      // `requireSettings` instead; tests targeting the missing-row path
      // override this mock directly.
      requireSettings: jest.fn(),
      getMember: jest.fn().mockResolvedValue(member()),
    };
    rooms.requireSettings.mockImplementation(async () => {
      const row = await rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    moderation = { isActivelyBlocked: jest.fn().mockResolvedValue(false) };
    config = { get: jest.fn() };
    registry = { register: jest.fn() };
    treasureProgress = {
      apply: jest.fn().mockResolvedValue({
        sessionId: null,
        applied: 0,
        events: [],
        claimedBoxId: null,
        claimedLevel: null,
        correlationId: 'c1',
        mirror: null,
      }),
      shouldEmit: jest.fn().mockResolvedValue(true),
      mirror: jest.fn().mockResolvedValue(undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
    };
    pkScoring = {
      apply: jest.fn().mockResolvedValue({ battleId: null, applied: 0, events: [], mirror: null }),
      mirror: jest.fn().mockResolvedValue(undefined),
      shouldEmit: jest.fn().mockResolvedValue(true),
      reverse: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    giftLockAccessRepo = {
      grantAccess: jest.fn().mockResolvedValue({ id: 'access-1' }),
      hasGrantedAccess: jest.fn().mockResolvedValue(false),
    };
    setGiftConfig();
    handler = new VideoRoomGiftContextHandler(
      rooms as never,
      moderation as never,
      config as never,
      registry as never,
      treasureProgress as never,
      queue as never,
      pkScoring as never,
      giftLockAccessRepo as never,
      bus as never,
    );
  });

  it('registers itself on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('declares the VIDEO_ROOM context', () => {
    expect(handler.contextType).toBe(GiftContextType.VIDEO_ROOM);
  });

  // VR-11 supersedes the VR-10 contract "declares NO onSend". Video rooms now
  // contribute exactly one Postgres write inside the money transaction — the
  // treasure counter — and still take NO extra distributed lock, because the
  // counter is guarded by a conditional UPDATE rather than by Redis.
  it('declares onSend but still no contextLockKeys', () => {
    const asPort: IGiftContextHandler = handler;
    expect(asPort.onSend).toEqual(expect.any(Function));
    expect(asPort.contextLockKeys).toBeUndefined();
  });

  it('reads maxReceivers from config', () => {
    expect(handler.maxReceivers).toBe(9);
  });

  describe('validate', () => {
    it('accepts a valid send', async () => {
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('rejects a missing room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('rejects a room that is not LIVE', async () => {
      rooms.findById.mockResolvedValue({ id: ROOM, status: VideoRoomStatus.OFFLINE });
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
      });
    });

    it('rejects when settings.allowGifts is false', async () => {
      rooms.getSettings.mockResolvedValue({ allowGifts: false, metadata: null });
      rooms.requireSettings.mockResolvedValue({ allowGifts: false, metadata: null });
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_GIFTS_DISABLED,
      });
    });

    // Guard hardening: a missing settings row must NOT read as "allowed".
    it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
      rooms.requireSettings.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      });
    });

    it('rejects a blocked sender even with a stale membership row', async () => {
      moderation.isActivelyBlocked.mockResolvedValue(true);
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
      });
    });

    it('rejects a sender who is not an active member when not an entry gift', async () => {
      rooms.getMember.mockResolvedValue(member({ isActive: false }));
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
      });
    });

    it('allows a non-member sender when paying the required entry gift to the room owner', async () => {
      rooms.findById.mockResolvedValue({
        id: ROOM,
        status: VideoRoomStatus.LIVE,
        ownerId: 'owner-1',
        giftLockEnabled: true,
        requiredEntryGiftId: 'g1',
      });
      // Sender is not in the room; receiver is the room owner
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(userId === 'owner-1' ? member({ role: VideoRoomMemberRole.HOST }) : null),
      );

      const entryGiftReq = {
        ...REQ,
        receiverIds: ['owner-1'],
        gift: { id: 'g1', name: 'Rose', coinValue: 10 },
      };

      await expect(handler.validate(entryGiftReq as never)).resolves.toBeUndefined();
    });

    it('rejects a receiver who is not in the room', async () => {
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(userId === SENDER ? member() : null),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('rejects a viewer receiver when the room disables viewer gifts', async () => {
      rooms.getSettings.mockResolvedValue({
        allowGifts: true,
        metadata: { allowViewerGifts: false },
      });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('allows a viewer receiver when the room enables viewer gifts', async () => {
      rooms.getSettings.mockResolvedValue({
        allowGifts: true,
        metadata: { allowViewerGifts: true },
      });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('falls back to the config default when the room sets no override', async () => {
      setGiftConfig({ allowViewerGiftsDefault: 'false' });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('rejects more receivers than the configured cap', async () => {
      setGiftConfig({ maxReceivers: 2 });
      await expect(
        handler.validate({ ...REQ, receiverIds: ['a', 'b', 'c'] } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
    });

    it('validates every receiver in a batch, not just the first', async () => {
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(userId === 'u2' ? null : member()),
      );
      await expect(
        handler.validate({ ...REQ, receiverIds: ['u1', 'u2'] } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
    });

    it('rejects a sender from a blocked country', async () => {
      setGiftConfig({ blockedCountries: 'XX,YY' });
      rooms.getMember.mockResolvedValue(member({ country: 'xx' }));
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_COUNTRY_RESTRICTED,
      });
    });

    it('allows a sender from a permitted country', async () => {
      setGiftConfig({ blockedCountries: 'XX' });
      rooms.getMember.mockResolvedValue(member({ country: 'IN' }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    /** Blocking on unknown would bar every member who joined before the column was populated. */
    it('allows a member with no recorded country', async () => {
      setGiftConfig({ blockedCountries: 'XX' });
      rooms.getMember.mockResolvedValue(member({ country: null }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('allows everyone when no countries are blocked', async () => {
      rooms.getMember.mockResolvedValue(member({ country: 'XX' }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    // Guard hardening: this used to assert "treats absent settings as
    // gifting-allowed" — a missing settings row must NOT read as "allowed".
    it('no longer treats absent settings as gifting-allowed', async () => {
      rooms.getSettings.mockResolvedValue(null);
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      });
    });
  });

  describe('onSend (VR-11 treasure)', () => {
    const tx = {} as never;
    const CTX = {
      ...REQ,
      transactionId: 't1',
      batchId: 'batch1',
      idempotencyKey: 'idem1',
      totalCoinValue: 5_000,
    } as never;

    const progressed = (over: Record<string, unknown> = {}) => ({
      sessionId: 's1',
      applied: 5_000,
      events: [],
      claimedBoxId: null,
      claimedLevel: null,
      correlationId: 'c1',
      mirror: { level: 1, progress: 5_000 },
      ...over,
    });

    // Progress is a counter, not an escrow: there is nothing to refund because
    // nothing was taken beyond the gift the sender already paid for.
    it('accepts the whole amount and never refunds', async () => {
      treasureProgress.apply.mockResolvedValue(progressed());
      const effects = await handler.onSend(tx, CTX);
      expect(effects.acceptedAmount).toBe(5_000);
      expect(effects.refundAmount).toBe(0);
    });

    it('performs no wallet work inside the gift transaction', async () => {
      treasureProgress.apply.mockResolvedValue(progressed());
      const effects = await handler.onSend(tx, CTX);
      // The only in-transaction call is the counter; nothing else is invoked.
      expect(treasureProgress.apply).toHaveBeenCalledTimes(1);
      expect(effects).not.toHaveProperty('walletTxnId');
    });

    it('returns progress events for post-commit publication when the throttle allows', async () => {
      const evt = { name: 'video_room.treasure.progress_updated' };
      treasureProgress.apply.mockResolvedValue(progressed({ events: [evt] }));
      treasureProgress.shouldEmit.mockResolvedValue(true);
      expect((await handler.onSend(tx, CTX)).events).toEqual([evt]);
    });

    it('drops throttled progress events when nothing was claimed', async () => {
      treasureProgress.apply.mockResolvedValue(progressed({ events: [{ name: 'x' }] }));
      treasureProgress.shouldEmit.mockResolvedValue(false);
      expect((await handler.onSend(tx, CTX)).events).toEqual([]);
    });

    it('lets a threshold crossing bypass the throttle', async () => {
      const evt = { name: 'video_room.treasure.progress_updated' };
      treasureProgress.apply.mockResolvedValue(
        progressed({ events: [evt], claimedBoxId: 'b1', claimedLevel: 1 }),
      );
      treasureProgress.shouldEmit.mockResolvedValue(false);
      expect((await handler.onSend(tx, CTX)).events).toEqual([evt]);
      expect(treasureProgress.shouldEmit).not.toHaveBeenCalled();
    });

    it('is inert when the room has no ladder', async () => {
      treasureProgress.apply.mockResolvedValue({ sessionId: null, events: [], mirror: null });
      const effects = await handler.onSend(tx, CTX);
      expect(effects.events).toEqual([]);
      expect(effects.postCommit).toBeUndefined();
    });

    // The enqueue MUST be post-commit: a rolled-back gift must not schedule a payout.
    it('enqueues the unlock only from postCommit, never inside the transaction', async () => {
      treasureProgress.apply.mockResolvedValue(progressed({ claimedBoxId: 'b1', claimedLevel: 1 }));
      const effects = await handler.onSend(tx, CTX);
      expect(queue.enqueue).not.toHaveBeenCalled();

      await effects.postCommit?.();
      expect(queue.enqueue).toHaveBeenCalledWith(
        'gift-processing',
        'video-room.treasure.unlock',
        { roomId: ROOM, sessionId: 's1', boxId: 'b1', level: 1, correlationId: 'c1' },
        expect.objectContaining({ jobId: 'treasure-unlock:b1' }),
      );
    });

    it('enqueues nothing when no box was claimed', async () => {
      treasureProgress.apply.mockResolvedValue(progressed());
      await (await handler.onSend(tx, CTX)).postCommit?.();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('mirrors progress and records activity after commit', async () => {
      treasureProgress.apply.mockResolvedValue(progressed());
      await (await handler.onSend(tx, CTX)).postCommit?.();
      expect(treasureProgress.mirror).toHaveBeenCalledWith(ROOM, 1, 5_000);
      expect(treasureProgress.recordActivity).toHaveBeenCalledWith(ROOM, 's1', SENDER);
    });

    // A treasure fault must never fail a gift the sender already paid for.
    it('degrades to inert when treasure processing throws', async () => {
      treasureProgress.apply.mockRejectedValue(new Error('treasure exploded'));
      const effects = await handler.onSend(tx, CTX);
      expect(effects).toEqual(
        expect.objectContaining({ acceptedAmount: 5_000, refundAmount: 0, events: [] }),
      );
    });

    it('survives a post-commit Redis failure without throwing', async () => {
      treasureProgress.apply.mockResolvedValue(progressed());
      treasureProgress.mirror.mockRejectedValue(new Error('redis down'));
      const effects = await handler.onSend(tx, CTX);
      await expect(effects.postCommit?.()).resolves.toBeUndefined();
    });
  });

  // VR-12: PK scoring is wired into the same send transaction, guarded
  // SEPARATELY from treasure so neither subsystem can fail the other.
  describe('onSend (VR-12 PK)', () => {
    const tx = {} as never;
    const CTX_OBJ = {
      ...REQ,
      transactionId: 't1',
      batchId: 'batch1',
      idempotencyKey: 'idem1',
      totalCoinValue: 5_000,
    };
    const CTX = CTX_OBJ as never;

    const scored = (over: Record<string, unknown> = {}) => ({
      battleId: 'b1',
      applied: 100,
      events: [new PkScoreUpdatedEvent({ roomId: 'r1', battleId: 'b1' } as never)],
      mirror: { battleId: 'b1', teams: [], giftCount: 1, baseTotal: 100 },
      ...over,
    });

    // Review fix: PK's broadcast is no longer part of onSend's synchronous
    // `events` — it is published directly onto the bus from `postCommit`,
    // alongside the mirror write, once the throttle (a Redis read) has been
    // consulted entirely post-commit.
    it('publishes PK events via the bus after commit, not synchronously from onSend', async () => {
      pkScoring.apply.mockResolvedValue(scored());
      const effects = await handler.onSend(tx, CTX);
      expect(effects.events).toHaveLength(0);
      expect(bus.publish).not.toHaveBeenCalled();

      await effects.postCommit?.();
      expect(bus.publish).toHaveBeenCalledTimes(1);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED }),
      );
    });

    // The whole point of the seam: PK must not be able to fail a paid gift.
    it('still returns the gift as accepted when PK scoring throws', async () => {
      pkScoring.apply.mockRejectedValue(new Error('pk exploded'));
      const effects = await handler.onSend(tx, CTX);
      expect(effects.acceptedAmount).toBe(CTX_OBJ.totalCoinValue);
      expect(effects.refundAmount).toBe(0);
    });

    // Review fix: `shouldEmit` reads/writes a Redis throttle key. It MUST NOT
    // run inside `onSend` (the gift's own `$transaction`) at all — a Redis
    // blip there previously propagated out of `onSend` and aborted an
    // already-paid gift. Proven by running this against the pre-fix code
    // first: it rejected because `onSend` awaited `shouldEmit` directly.
    it('resolves onSend normally even when shouldEmit rejects (no Redis call in onSend)', async () => {
      pkScoring.shouldEmit.mockRejectedValue(new Error('redis timeout'));
      pkScoring.apply.mockResolvedValue(scored());
      const effects = await handler.onSend(tx, CTX);
      expect(effects.acceptedAmount).toBe(CTX_OBJ.totalCoinValue);
      expect(effects.refundAmount).toBe(0);
    });

    // The throttle decision now lives entirely in postCommit, so a Redis
    // fault there must degrade to "skip this broadcast", never throw.
    it('survives a shouldEmit rejection in postCommit without throwing', async () => {
      pkScoring.shouldEmit.mockRejectedValue(new Error('redis timeout'));
      pkScoring.apply.mockResolvedValue(scored());
      const effects = await handler.onSend(tx, CTX);
      await expect(effects.postCommit?.()).resolves.toBeUndefined();
      expect(pkScoring.mirror).toHaveBeenCalledTimes(1);
    });

    it('mirrors PK score only after commit', async () => {
      pkScoring.apply.mockResolvedValue(scored({ events: [] }));
      const effects = await handler.onSend(tx, CTX);
      expect(pkScoring.mirror).not.toHaveBeenCalled(); // not during onSend

      await effects.postCommit?.();
      expect(pkScoring.mirror).toHaveBeenCalledTimes(1); // only after commit
    });

    it('throttles the score broadcast', async () => {
      pkScoring.shouldEmit.mockResolvedValue(false);
      pkScoring.apply.mockResolvedValue(
        scored({ applied: 10, mirror: null, events: [new PkScoreUpdatedEvent({} as never)] }),
      );
      expect((await handler.onSend(tx, CTX)).events).toHaveLength(0);
    });

    // The brief's own throttle test above sets `mirror: null`, which drops the
    // events by short-circuiting BEFORE `shouldEmit` is even consulted — it
    // never actually exercises `shouldEmit() === false`. This test does: a
    // real battle/mirror is present, and the throttle alone is what empties
    // the events.
    it('drops events when shouldEmit denies, even with a live battle', async () => {
      pkScoring.shouldEmit.mockResolvedValue(false);
      pkScoring.apply.mockResolvedValue(scored());
      const effects = await handler.onSend(tx, CTX);
      expect(effects.events).toEqual([]);

      // The throttle check itself now happens in postCommit, not in onSend.
      await effects.postCommit?.();
      expect(pkScoring.shouldEmit).toHaveBeenCalledWith('b1');
      expect(bus.publish).not.toHaveBeenCalled();
    });

    // shouldEmit is only meaningful once there IS a battle; skip the throttle
    // check entirely when apply() returned no battle at all.
    it('does not call shouldEmit when PK produced no battle', async () => {
      pkScoring.apply.mockResolvedValue({ battleId: null, applied: 0, events: [], mirror: null });
      await handler.onSend(tx, CTX);
      expect(pkScoring.shouldEmit).not.toHaveBeenCalled();
    });

    it('does not let a treasure failure suppress PK scoring', async () => {
      treasureProgress.apply.mockRejectedValue(new Error('treasure down'));
      // `mirror` must be truthy for the broadcast to reach the bus at all
      // (see the "throttles the score broadcast" test above) — otherwise this
      // would pass even with the two subsystems wrongly coupled.
      pkScoring.apply.mockResolvedValue(scored({ applied: 10 }));
      const effects = await handler.onSend(tx, CTX);
      await effects.postCommit?.();
      expect(bus.publish).toHaveBeenCalledTimes(1);
    });

    // The mirror image of the test above: a PK fault must not touch treasure's
    // own events, which is what would happen if the two shared one try/catch.
    it('does not let a PK failure suppress treasure events', async () => {
      const evt = { name: 'video_room.treasure.progress_updated' };
      treasureProgress.apply.mockResolvedValue({
        sessionId: 's1',
        applied: 5_000,
        events: [evt],
        claimedBoxId: null,
        claimedLevel: null,
        correlationId: 'c1',
        mirror: null,
      });
      pkScoring.apply.mockRejectedValue(new Error('pk exploded'));
      const effects = await handler.onSend(tx, CTX);
      expect(effects.events).toEqual([evt]);
    });

    // A PK postCommit fault (e.g. Redis down) must not skip treasure's own
    // postCommit work — the two are independently guarded there too.
    it('runs the treasure postCommit even when the PK mirror throws', async () => {
      treasureProgress.apply.mockResolvedValue({
        sessionId: 's1',
        applied: 5_000,
        events: [],
        claimedBoxId: null,
        claimedLevel: null,
        correlationId: 'c1',
        mirror: { level: 1, progress: 5_000 },
      });
      pkScoring.apply.mockResolvedValue(scored({ events: [] }));
      pkScoring.mirror.mockRejectedValue(new Error('pk redis down'));

      const effects = await handler.onSend(tx, CTX);
      await expect(effects.postCommit?.()).resolves.toBeUndefined();
      expect(treasureProgress.mirror).toHaveBeenCalledWith('r1', 1, 5_000);
    });

    // And the reverse: a treasure postCommit fault must not skip PK's mirror.
    // `queue.enqueue` is the one call inside treasure's postCommit that is NOT
    // individually `.catch()`-guarded (mirror/recordActivity already are), so
    // it is the one lever that makes treasure's own postCommit actually reject.
    it('runs the PK mirror even when the treasure postCommit throws', async () => {
      treasureProgress.apply.mockResolvedValue({
        sessionId: 's1',
        applied: 5_000,
        events: [],
        claimedBoxId: 'b1',
        claimedLevel: 1,
        correlationId: 'c1',
        mirror: null,
      });
      queue.enqueue.mockRejectedValue(new Error('queue down'));
      pkScoring.apply.mockResolvedValue(scored({ events: [] }));

      const effects = await handler.onSend(tx, CTX);
      await expect(effects.postCommit?.()).resolves.toBeUndefined();
      expect(pkScoring.mirror).toHaveBeenCalledTimes(1);
    });
  });
});

describe('VideoRoomGiftContextHandler — gift-lock grant', () => {
  let handler: VideoRoomGiftContextHandler;
  let rooms: any;
  let giftLockAccessRepo: any;
  let tx: any;

  beforeEach(() => {
    rooms = {
      findById: jest.fn(),
      getActiveBroadcastSession: jest.fn(),
    };
    giftLockAccessRepo = {
      grantAccess: jest.fn().mockResolvedValue({ id: 'access-1' }),
      hasGrantedAccess: jest.fn().mockResolvedValue(false),
    };
    tx = {};

    // Construct with the handler's other existing collaborators as no-op
    // mocks (moderation/config/registry/treasureProgress/queue/pkScoring/bus)
    // — mirrors the top-level describe block's construction of `handler`,
    // with `giftLockAccessRepo` inserted in its new constructor position.
    const moderation: any = { isActivelyBlocked: jest.fn() };
    const config: any = { get: jest.fn().mockReturnValue({}) };
    const registry: any = { register: jest.fn() };
    const treasureProgress: any = { apply: jest.fn(), shouldEmit: jest.fn(), mirror: jest.fn() };
    const queue: any = { enqueue: jest.fn() };
    const pkScoring: any = { apply: jest.fn(), mirror: jest.fn(), shouldEmit: jest.fn() };
    const bus: any = { publish: jest.fn() };

    handler = new VideoRoomGiftContextHandler(
      rooms,
      moderation,
      config,
      registry,
      treasureProgress,
      queue,
      pkScoring,
      giftLockAccessRepo,
      bus,
    );
  });

  it('grants gift-lock access when the required gift is sent to the room owner', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });

    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });

    expect(giftLockAccessRepo.grantAccess).toHaveBeenCalledWith(
      {
        userId: 'sender-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        giftId: 'gift-required',
        giftTransactionId: 'txn-1',
      },
      tx,
    );
  });

  it('does nothing when the room does not have gift-lock enabled', async () => {
    rooms.findById.mockResolvedValue({ id: 'room-1', ownerId: 'owner-1', giftLockEnabled: false });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  it('does nothing when the sent gift is not the required gift', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-OTHER' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  it('does nothing when the owner is not among the receivers', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });
    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['someone-else'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  // Regression coverage: `grantAccess` targets the same `(userId, sessionId)`
  // unique key on every qualifying send. Without this check, a repeat send
  // would attempt a second INSERT on that key inside the caller's Postgres
  // transaction — a unique-constraint violation there aborts the whole
  // transaction, and the try/catch around this method cannot un-abort it, so
  // the receiver's wallet credit later in the same transaction would fail
  // too. Checking `hasGrantedAccess` first keeps a repeat send a true no-op.
  it('does nothing when access was already granted for this sender and session', async () => {
    rooms.findById.mockResolvedValue({
      id: 'room-1',
      ownerId: 'owner-1',
      giftLockEnabled: true,
      requiredEntryGiftId: 'gift-required',
    });
    rooms.getActiveBroadcastSession.mockResolvedValue({ id: 'session-1' });
    giftLockAccessRepo.hasGrantedAccess.mockResolvedValue(true);

    await (handler as any).grantGiftLockAccessIfApplicable(tx, {
      contextId: 'room-1',
      senderId: 'sender-1',
      receiverIds: ['owner-1'],
      gift: { id: 'gift-required' },
      transactionId: 'txn-1',
    });

    expect(giftLockAccessRepo.hasGrantedAccess).toHaveBeenCalledWith('sender-1', 'session-1', tx);
    expect(giftLockAccessRepo.grantAccess).not.toHaveBeenCalled();
  });

  describe('gift-lock entry send suppressReceiverCashback', () => {
    it('returns suppressReceiverCashback: true when sending the required entry gift to the room owner', async () => {
      rooms.findById.mockResolvedValue({
        id: ROOM,
        ownerId: 'owner-1',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-entry-1',
      });
      const effects = await handler.onSend(tx, {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: ROOM,
        senderId: SENDER,
        receiverIds: ['owner-1'],
        gift: { id: 'gift-entry-1', name: 'Key', coinValue: 1500 } as any,
        quantity: 1,
        transactionId: 't1',
        batchId: 'b1',
        idempotencyKey: 'i1',
        totalCoinValue: 1500,
      });
      expect(effects.suppressReceiverCashback).toBe(true);
      // Gift-lock entry: no gold cashback to anyone — soul gems only to receiver.
      expect(effects.redirectCashbackToSender).toBe(false);
    });

    it('returns suppressReceiverCashback: false and redirectCashbackToSender: false when room has gift-lock disabled (normal video gift)', async () => {
      rooms.findById.mockResolvedValue({
        id: ROOM,
        ownerId: 'owner-1',
        giftLockEnabled: false,
        requiredEntryGiftId: 'gift-entry-1',
      });
      const effects = await handler.onSend(tx, {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: ROOM,
        senderId: SENDER,
        receiverIds: ['owner-1'],
        gift: { id: 'gift-entry-1', name: 'Key', coinValue: 1500 } as any,
        quantity: 1,
        transactionId: 't1',
        batchId: 'b1',
        idempotencyKey: 'i1',
        totalCoinValue: 1500,
      });
      // Normal video room gift: receiver earns soul gems + gold cashback (cashback stays with receiver).
      expect(effects.suppressReceiverCashback).toBe(false);
      expect(effects.redirectCashbackToSender).toBe(false);
    });

    it('returns suppressReceiverCashback: false and redirectCashbackToSender: false when sending a different gift than the required entry gift (normal video gift)', async () => {
      rooms.findById.mockResolvedValue({
        id: ROOM,
        ownerId: 'owner-1',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-entry-1',
      });
      const effects = await handler.onSend(tx, {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: ROOM,
        senderId: SENDER,
        receiverIds: ['owner-1'],
        gift: { id: 'different-gift', name: 'Rose', coinValue: 1500 } as any,
        quantity: 1,
        transactionId: 't1',
        batchId: 'b1',
        idempotencyKey: 'i1',
        totalCoinValue: 1500,
      });
      // Normal video room gift: receiver earns soul gems + gold cashback.
      expect(effects.suppressReceiverCashback).toBe(false);
      expect(effects.redirectCashbackToSender).toBe(false);
    });

    it('returns suppressReceiverCashback: false and redirectCashbackToSender: false when recipient is not the room owner (normal video gift)', async () => {
      rooms.findById.mockResolvedValue({
        id: ROOM,
        ownerId: 'owner-1',
        giftLockEnabled: true,
        requiredEntryGiftId: 'gift-entry-1',
      });
      const effects = await handler.onSend(tx, {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: ROOM,
        senderId: SENDER,
        receiverIds: ['speaker-2'],
        gift: { id: 'gift-entry-1', name: 'Key', coinValue: 1500 } as any,
        quantity: 1,
        transactionId: 't1',
        batchId: 'b1',
        idempotencyKey: 'i1',
        totalCoinValue: 1500,
      });
      // Normal video room gift: receiver earns soul gems + gold cashback (cashback stays with receiver).
      expect(effects.suppressReceiverCashback).toBe(false);
      expect(effects.redirectCashbackToSender).toBe(false);
    });
  });
});
