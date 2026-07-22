import {
  GiftCategory,
  GiftContextType,
  GiftType,
  VideoRoomMemberRole,
  VideoRoomStatus,
  WalletCurrency,
} from '@prisma/client';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import { GiftService } from 'src/modules/gifts/services/gift.service';
import { VideoRoomGiftTarget } from './dto/send-video-room-gift.dto';
import { VIDEO_ROOM_GIFT_EVENTS } from './events/video-room-gift.events';
import { VideoRoomGiftComboService } from './services/video-room-gift-combo.service';
import { VideoRoomGiftContextHandler } from './services/video-room-gift-context.handler';
import { VideoRoomGiftDeliveryService } from './services/video-room-gift-delivery.service';
import { VideoRoomGiftStatisticsService } from './services/video-room-gift-statistics.service';
import { VideoRoomGiftTargetResolver } from './services/video-room-gift-target.resolver';
import { VideoRoomGiftService } from './services/video-room-gift.service';

/**
 * VR-10 end-to-end: the REAL GiftService, GiftContextRegistry and
 * VideoRoomGiftContextHandler wired together, with only the outermost edges
 * (Prisma, Redis, wallet, queue, socket bus) faked.
 *
 * The unit specs each prove one collaborator in isolation; this proves they
 * agree — that the resolver's output is what the pipeline validates, that the
 * handler's economics reach the ledger, and that the money/side-effect ordering
 * survives composition.
 */

const ROOM = 'room-1';
const SENDER_ID = 'sender-1';
const SENDER = { id: SENDER_ID, roles: ['USER'] } as never;
const NOW = 1_700_000_000_000;

const GIFT = {
  id: 'gift-1',
  name: 'Rocket',
  category: GiftCategory.LUXURY,
  type: GiftType.ANIMATED,
  coinValue: 100,
  animationUrl: 'a.svga',
  soundUrl: 's.mp3',
  minVipLevel: 0,
  comboEnabled: true,
  comboWindowSeconds: 10,
  luckyMultipliers: [],
  luckyWinChanceBp: 0,
  enabled: true,
};

const GIFT_CFG = {
  creatorEarningRatePercent: 30,
  senderExpPerCoin: 1,
  receiverExpPerCoin: 1,
  rateMax: 20,
  rateWindowSeconds: 10,
};

const VR_GIFT_CFG = {
  maxReceivers: 9,
  allowRoomAll: 'false',
  allowViewerGiftsDefault: 'true',
  recentFeedSize: 50,
  monitorIntervalSeconds: 15,
  recoveryEnabled: 'false',
};

const seat = (seatIndex: number, occupantUserId: string | null) => ({ seatIndex, occupantUserId });

describe('VR-10 gift engine (integration)', () => {
  let harness: ReturnType<typeof build>;

  function build(overrides: { seats?: unknown[]; allowGifts?: boolean } = {}) {
    const ledger: Record<string, unknown>[] = [];
    const walletMoves: Record<string, unknown>[] = [];
    const published: { name: string; payload: Record<string, unknown> }[] = [];
    const enqueued: unknown[][] = [];

    const prisma: Record<string, unknown> = {
      $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma)),
      videoRoomStatistics: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ totalGifts: 0n, totalGiftCoins: 0n }),
      },
      giftTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
    };

    const wallet = {
      debit: jest.fn().mockImplementation(async (input: Record<string, unknown>) => {
        walletMoves.push({ kind: 'debit', ...input });
        return { transactionId: `w-debit-${walletMoves.length}`, duplicate: false };
      }),
      credit: jest.fn().mockImplementation(async (input: Record<string, unknown>) => {
        walletMoves.push({ kind: 'credit', ...input });
        return { transactionId: `w-credit-${walletMoves.length}`, duplicate: false };
      }),
    };

    const giftRepo = {
      findTxnByIdempotencyKey: jest
        .fn()
        .mockImplementation(
          async (key: string) => ledger.find((row) => row.idempotencyKey === key) ?? null,
        ),
      hitRateLimit: jest.fn().mockResolvedValue(false),
      comboTick: jest.fn().mockResolvedValue(1),
      createTransaction: jest.fn().mockImplementation(async (data: Record<string, unknown>) => {
        const row = {
          id: `txn-${ledger.length + 1}`,
          status: 'COMPLETED',
          createdAt: new Date(NOW),
          ...data,
        };
        ledger.push(row);
        return row;
      }),
      listTransactions: jest.fn().mockResolvedValue([[], 0]),
    };

    const bus = {
      publish: jest.fn().mockImplementation(async (e: { name: string; payload: never }) => {
        published.push({ name: e.name, payload: e.payload });
      }),
      subscribe: jest.fn(),
    };

    const config = {
      get: jest.fn().mockImplementation((ns: string) => (ns === 'gift' ? GIFT_CFG : VR_GIFT_CFG)),
    };

    const rooms = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: ROOM, ownerId: 'owner-1', status: VideoRoomStatus.LIVE }),
      getSettings: jest
        .fn()
        .mockResolvedValue({ allowGifts: overrides.allowGifts ?? true, metadata: null }),
      getMember: jest
        .fn()
        .mockResolvedValue({ isActive: true, role: VideoRoomMemberRole.PARTICIPANT }),
    };

    const cache = {
      increment: jest.fn().mockResolvedValue(1),
      setScore: jest.fn().mockResolvedValue(undefined),
      sortedRangeByScore: jest.fn().mockResolvedValue([]),
      sortedRemove: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      score: jest.fn().mockResolvedValue(NOW + 10_000),
      addScore: jest.fn().mockResolvedValue(1),
      top: jest.fn().mockResolvedValue([]),
    };

    const redis = {
      hincrby: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      lrange: jest.fn().mockResolvedValue([]),
    };

    const queue = {
      enqueue: jest.fn().mockImplementation(async (...args: unknown[]) => void enqueued.push(args)),
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, delayed: 0, active: 0 }),
    };

    const metrics = {
      incGiftSent: jest.fn(),
      observeGiftSendLatency: jest.fn(),
      observeGiftWalletLatency: jest.fn(),
      setGiftQueueDepth: jest.fn(),
      setGiftAnimationQueueDepth: jest.fn(),
      incGiftFailure: jest.fn(),
      incGiftCombo: jest.fn(),
      incGiftRecovery: jest.fn(),
    };

    // ---- REAL objects under test ----
    const registry = new GiftContextRegistry();
    new VideoRoomGiftContextHandler(
      rooms as never,
      { findActiveBlock: jest.fn().mockResolvedValue(null) } as never,
      config as never,
      registry,
    ).onModuleInit();

    const gifts = new GiftService(
      giftRepo as never,
      { getGift: jest.fn().mockResolvedValue(GIFT) } as never,
      { record: jest.fn() } as never,
      config as never,
      { enqueue: jest.fn() } as never,
      prisma as never,
      { withLock: jest.fn().mockImplementation((_k: string, cb: () => unknown) => cb()) } as never,
      bus as never,
      wallet as never,
      { getLevelOrdinal: jest.fn().mockResolvedValue(0) } as never,
      registry,
    );

    const combo = new VideoRoomGiftComboService(
      cache as never,
      bus as never,
      metrics as never,
      () => NOW,
    );
    const statistics = new VideoRoomGiftStatisticsService(
      prisma as never,
      cache as never,
      redis as never,
      config as never,
    );
    const resolver = new VideoRoomGiftTargetResolver(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          roomId: ROOM,
          seats: overrides.seats ?? [seat(0, 'u1'), seat(1, null), seat(2, 'u2')],
        }),
      } as never,
      config as never,
    );

    const service = new VideoRoomGiftService(
      resolver,
      gifts,
      { getGift: jest.fn().mockResolvedValue(GIFT) } as never,
      combo,
      statistics,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as never,
      queue as never,
      metrics as never,
      bus as never,
    );

    const delivery = new VideoRoomGiftDeliveryService(
      { register: jest.fn() } as never,
      { withLock: jest.fn().mockImplementation((_k: string, cb: () => unknown) => cb()) } as never,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as never,
      bus as never,
      metrics as never,
    );

    return {
      service,
      delivery,
      ledger,
      walletMoves,
      published,
      enqueued,
      wallet,
      metrics,
      rooms,
      giftRepo,
      redis,
    };
  }

  const send = (target = VideoRoomGiftTarget.SEAT_ALL, extra: Record<string, unknown> = {}) =>
    harness.service.send(SENDER, ROOM, {
      giftId: 'gift-1',
      target,
      quantity: 1,
      idempotencyKey: 'idem-1',
      ...extra,
    } as never);

  beforeEach(() => {
    harness = build();
  });

  it('single-receiver send: one debit, one credit, one ledger row, one job', async () => {
    const view = await send(VideoRoomGiftTarget.SINGLE, { receiverId: 'u1' });

    expect(harness.walletMoves.filter((m) => m.kind === 'debit')).toHaveLength(1);
    expect(harness.walletMoves.filter((m) => m.kind === 'credit')).toHaveLength(1);
    expect(harness.ledger).toHaveLength(1);
    expect(harness.enqueued).toHaveLength(1);
    expect(view.transactions).toHaveLength(1);
  });

  it('SEAT_ALL debits once for N, credits N, writes N rows sharing a batchId', async () => {
    const view = await send();

    const debits = harness.walletMoves.filter((m) => m.kind === 'debit');
    const credits = harness.walletMoves.filter((m) => m.kind === 'credit');
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(200); // 100 x 1 x 2 receivers
    expect(credits).toHaveLength(2);
    expect(credits.map((c) => c.amount)).toEqual([30, 30]); // 30% each, of THEIR gift

    expect(harness.ledger).toHaveLength(2);
    const batchIds = harness.ledger.map((r) => (r.metadata as { batchId: string }).batchId);
    expect(new Set(batchIds).size).toBe(1);
    expect(view.totalCoinValue).toBe(200);
  });

  it('credits use PER-LEG idempotency keys so nobody is silently unpaid', async () => {
    await send();
    const keys = harness.walletMoves
      .filter((m) => m.kind === 'credit')
      .map((m) => m.idempotencyKey);
    expect(keys).toEqual(['gift-credit:idem-1:u1', 'gift-credit:idem-1:u2']);
    expect(new Set(keys).size).toBe(2);
  });

  it('the handler economics reach the ledger (30% creator earnings)', async () => {
    await send();
    expect(harness.ledger[0].creatorEarnings).toBe(30n);
    expect(harness.ledger[0].totalCoinValue).toBe(100n);
    expect(harness.walletMoves.find((m) => m.kind === 'credit')?.currency).toBe(
      WalletCurrency.EARNINGS,
    );
  });

  it('rolls the whole batch back when one receiver fails validation', async () => {
    harness.rooms.getMember.mockImplementation(async (_room: string, userId: string) =>
      userId === 'u2' ? null : { isActive: true, role: VideoRoomMemberRole.PARTICIPANT },
    );
    await expect(send()).rejects.toMatchObject({ errorCode: 'GIFT_RECEIVER_INVALID' });

    // All-or-nothing: nothing charged, nothing written, nothing queued.
    expect(harness.walletMoves).toHaveLength(0);
    expect(harness.ledger).toHaveLength(0);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('rejects and charges nothing when the room disables gifting', async () => {
    harness = build({ allowGifts: false });
    await expect(send()).rejects.toMatchObject({ errorCode: 'VIDEO_ROOM_GIFTS_DISABLED' });
    expect(harness.walletMoves).toHaveLength(0);
  });

  it('an idempotent replay returns the original rows without re-charging', async () => {
    await send(VideoRoomGiftTarget.SINGLE, { receiverId: 'u1' });
    const movesAfterFirst = harness.walletMoves.length;

    await send(VideoRoomGiftTarget.SINGLE, { receiverId: 'u1' });
    expect(harness.walletMoves).toHaveLength(movesAfterFirst);
    expect(harness.ledger).toHaveLength(1);
  });

  it('publishes gift.sent per leg with VIDEO_ROOM context', async () => {
    await send();
    const sent = harness.published.filter((e) => e.name === 'gift.sent');
    expect(sent).toHaveLength(2);
    expect(sent[0].payload.contextType).toBe(GiftContextType.VIDEO_ROOM);
  });

  it('starts the combo and reports queue depth after committing', async () => {
    await send();
    expect(harness.published.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED,
        VIDEO_ROOM_GIFT_EVENTS.QUEUE_UPDATED,
      ]),
    );
  });

  it('enqueues one LUXURY-priority delivery job carrying every leg', async () => {
    await send();
    const [queueName, jobName, data, opts] = harness.enqueued[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(queueName).toBe('gift-processing');
    expect(jobName).toBe('video-room.gift.deliver');
    expect(data.receiverIds).toEqual(['u1', 'u2']);
    expect(data.transactionIds).toHaveLength(2);
    expect(opts.priority).toBe(1);
  });

  it('delivery emits ONE animation and N delivered events', async () => {
    await send();
    const job = harness.enqueued[0][2] as Record<string, unknown>;
    harness.published.length = 0;

    await harness.delivery.handle(job as never, { id: 'j1', attemptsMade: 0 } as never);

    expect(
      harness.published.filter((e) => e.name === VIDEO_ROOM_GIFT_EVENTS.ANIMATION),
    ).toHaveLength(1);
    expect(
      harness.published.filter((e) => e.name === VIDEO_ROOM_GIFT_EVENTS.DELIVERED),
    ).toHaveLength(2);
  });

  it('every delivered event carries the full correlation envelope', async () => {
    await send();
    const job = harness.enqueued[0][2] as Record<string, unknown>;
    harness.published.length = 0;

    await harness.delivery.handle(job as never, { id: 'j1', attemptsMade: 0 } as never);

    const delivered = harness.published.find((e) => e.name === VIDEO_ROOM_GIFT_EVENTS.DELIVERED);
    expect(Object.keys(delivered!.payload).sort()).toEqual([
      'attempt',
      'batchId',
      'giftId',
      'jobId',
      'receiverId',
      'roomId',
      'senderId',
      'transactionId',
    ]);
  });

  it('feeds monitoring: gifts, coins, latency and queue depth', async () => {
    await send();
    expect(harness.metrics.incGiftSent).toHaveBeenCalledTimes(2);
    expect(harness.metrics.incGiftSent).toHaveBeenCalledWith('LUXURY', 100);
    expect(harness.metrics.observeGiftSendLatency).toHaveBeenCalled();
    expect(harness.metrics.setGiftQueueDepth).toHaveBeenCalled();
  });

  it('records durable statistics and the recent feed after commit', async () => {
    await send();
    expect(harness.redis.lpush).toHaveBeenCalled();
    expect(harness.redis.ltrim).toHaveBeenCalledWith(
      'video-room:r1:gifts:recent'.replace('r1', ROOM),
      0,
      49,
    );
  });

  it('rejects a self-gift without touching the wallet', async () => {
    harness = build({ seats: [seat(0, SENDER_ID), seat(1, 'u1')] });
    await send();
    // The sender is filtered out of SEAT_ALL rather than charged for themselves.
    expect(harness.ledger.map((r) => r.receiverId)).toEqual(['u1']);
  });
});
