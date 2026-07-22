import { Logger } from '@nestjs/common';
import type { GiftRefundedPayload } from 'src/modules/gifts/events/gift.events';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import { VideoRoomPkReversalListener } from './video-room-pk-reversal.listener';

// Spec §6.5. Without this listener, VideoRoomPkScoringService.reverse() exists
// and is unit-tested but is never called by anything — a refunded gift would
// keep its PK score forever.
//
// `GiftRefundedPayload` (the gifts module's real, read-only contract) carries
// no `contextType` tag — only a bare `roomId`. This listener substitutes a
// `VideoRoomsRepository.findById` existence check for that missing tag: a
// refund for a room that isn't a video room at all (every refund on the bus
// today, since AUDIO_ROOM's treasure-overflow refund is the only current
// emitter) is filtered out exactly as a `contextType !== VIDEO_ROOM` check
// would have filtered it, without touching gifts-module code to add the tag.
describe('VideoRoomPkReversalListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let prisma: { $transaction: jest.Mock };
  let rooms: { findById: jest.Mock };
  let pkRepo: { findCurrent: jest.Mock };
  let pkScoring: { reverse: jest.Mock };
  let listener: VideoRoomPkReversalListener;
  let warnSpy: jest.SpyInstance;

  const TX = { marker: 'tx' };

  const fire = (name: string, payload: object) => bus.handlers.get(name)!({ name, payload });

  const REFUND: GiftRefundedPayload = {
    transactionId: 'txn-1',
    senderId: 'sender-1',
    roomId: 'r1',
    giftId: 'g1',
    giftName: 'Rocket',
    totalRefundAmount: 100,
    createdAt: '2026-07-22T00:00:00.000Z',
  };

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => Promise<void>) => handlers.set(n, f)),
    };
    prisma = { $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(TX)) };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1' }) };
    pkRepo = { findCurrent: jest.fn().mockResolvedValue({ id: 'battle-1' }) };
    pkScoring = { reverse: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomPkReversalListener(
      bus as never,
      prisma as never,
      rooms as never,
      pkRepo as never,
      pkScoring as never,
    );
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('compensates PK score when a video-room gift is refunded', async () => {
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, REFUND);
    expect(pkScoring.reverse).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ roomId: 'r1', giftTxnId: 'txn-1' }),
    );
  });

  // Adapted from the brief's "ignores refunds from other gift contexts": the
  // real payload has no contextType, so the substitute signal is "this roomId
  // is not a video room at all" — which is what every AUDIO_ROOM refund is.
  it('ignores refunds from other gift contexts', async () => {
    rooms.findById.mockResolvedValue(null);
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, REFUND);
    expect(pkScoring.reverse).not.toHaveBeenCalled();
    // Must not even query the PK battle table for a room we've already
    // determined is irrelevant.
    expect(pkRepo.findCurrent).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Post-settlement refunds are NOT unwound (spec §6.5). Rewards are paid;
  // retroactively rewriting a finished battle's winner would be worse.
  it('records an anomaly instead of unwinding a COMPLETED battle', async () => {
    pkRepo.findCurrent.mockResolvedValue(null); // no non-terminal battle
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, REFUND);
    expect(pkScoring.reverse).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('txn-1'));
  });

  // Extra coverage lesson from Tasks 7-13: a null `findCurrent` must be a
  // hard gate, not merely a log line that reverse still runs alongside.
  it('never calls reverse when findCurrent returns null', async () => {
    pkRepo.findCurrent.mockResolvedValue(null);
    listener.onModuleInit();
    await fire(GIFT_EVENTS.REFUNDED, REFUND);
    expect(pkScoring.reverse).not.toHaveBeenCalled();
  });

  // Best-effort throughout: a compensation failure must never fail the
  // refund itself (there is nothing further downstream to fail here, but the
  // handler must resolve rather than reject either way).
  it('swallows a failure anywhere in the compensation pipeline', async () => {
    rooms.findById.mockRejectedValue(new Error('db down'));
    listener.onModuleInit();
    await expect(fire(GIFT_EVENTS.REFUNDED, REFUND)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('txn-1'));
  });

  it('swallows a failure from reverse itself without throwing', async () => {
    pkScoring.reverse.mockRejectedValue(new Error('reverse exploded'));
    listener.onModuleInit();
    await expect(fire(GIFT_EVENTS.REFUNDED, REFUND)).resolves.toBeUndefined();
  });
});
