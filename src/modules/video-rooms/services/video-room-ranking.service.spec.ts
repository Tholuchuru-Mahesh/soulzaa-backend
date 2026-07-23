import { VideoRoomRankingService } from './video-room-ranking.service';
import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';
import {
  GifterRankingUpdatedEvent,
  HostRankingUpdatedEvent,
  PKRankingUpdatedEvent,
  RankingUpdatedEvent,
  RoomRankingUpdatedEvent,
  TreasureRankingUpdatedEvent,
} from '../events/video-room-ranking.events';

const AT = new Date('2026-07-22T14:35:00.000Z');

const giftInput = (over = {}) => ({
  transactionId: 'txn-1',
  roomId: 'room-1',
  senderId: 'sender-1',
  receiverId: 'receiver-1',
  totalCoinValue: 100,
  quantity: 1,
  receiverIsSeated: true,
  occurredAt: AT,
  ...over,
});

type Increment = { key: string; member: string; delta: number; ttlSeconds?: number };
type VersionPair = { scope: string; dimension: string };
type Geo = { country: string | null; city: string | null };

describe('VideoRoomRankingService', () => {
  let store: {
    key: jest.Mock;
    incrementMany: jest.Mock;
    markSeen: jest.Mock;
    bumpVersionMany: jest.Mock;
    top: jest.Mock;
  };
  let scopes: { geoForMany: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingService;

  const config = { get: () => ({}) } as never;

  beforeEach(() => {
    store = {
      key: jest.fn(
        (ns, scope, dim, period, dateKey) => `${ns}:{${scope}|${dim}}:${period}:${dateKey}`,
      ),
      incrementMany: jest.fn().mockResolvedValue(undefined),
      markSeen: jest.fn().mockResolvedValue(true),
      bumpVersionMany: jest.fn().mockResolvedValue(undefined),
      top: jest.fn().mockResolvedValue([{ member: 'sender-1', score: 100 }]),
    };
    // No geography by default: every delta fans out to global + room only
    // unless a test opts in with its own country/city.
    scopes = { geoForMany: jest.fn().mockResolvedValue(new Map<string, Geo>()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new VideoRoomRankingService(
      config,
      store as never,
      new RankingPeriodResolver(),
      new VideoRoomRankingScoreEngine(config),
      scopes as never,
      bus as never,
    );
  });

  describe('recordGift', () => {
    it('claims the transaction exactly once before writing', async () => {
      await service.recordGift(giftInput());
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'gift', 'txn-1', expect.any(Number));
    });

    it('writes nothing at all when the transaction was already applied', async () => {
      store.markSeen.mockResolvedValue(false);
      await service.recordGift(giftInput());
      expect(store.incrementMany).not.toHaveBeenCalled();
      expect(store.bumpVersionMany).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('never writes a rankings:* key — that namespace belongs to the platform module', async () => {
      await service.recordGift(giftInput());
      const keys = store.incrementMany.mock.calls[0][0].map((i: Increment) => i.key);
      expect(keys.every((k: string) => k.startsWith('vrank:'))).toBe(true);
      expect(keys.some((k: string) => k.startsWith('rankings:'))).toBe(false);
    });

    it('materialises exactly the five hot periods per scope+dimension', async () => {
      await service.recordGift(giftInput());
      const keys: string[] = store.incrementMany.mock.calls[0][0].map((i: Increment) => i.key);
      const gifterGlobal = keys.filter((k) => k.includes('{g|gifters}'));
      expect(gifterGlobal.sort()).toEqual(
        [
          'vrank:{g|gifters}:alltime:alltime',
          'vrank:{g|gifters}:daily:20260722',
          'vrank:{g|gifters}:hourly:2026072214',
          'vrank:{g|gifters}:monthly:202607',
          'vrank:{g|gifters}:weekly:2026W30',
        ].sort(),
      );
    });

    it('never materialises a derived period on the hot path', async () => {
      await service.recordGift(giftInput());
      const keys: string[] = store.incrementMany.mock.calls[0][0].map((i: Increment) => i.key);
      expect(keys.some((k) => k.includes(':quarterly:') || k.includes(':yearly:'))).toBe(false);
    });

    it('credits the sender as gifter and the receiver as receiver', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0];
      const gifter = incs.find((i: Increment) => i.key.includes('{g|gifters}'));
      const receiver = incs.find((i: Increment) => i.key.includes('{g|receivers}'));
      expect(gifter.member).toBe('sender-1');
      expect(gifter.delta).toBe(100);
      expect(receiver.member).toBe('receiver-1');
      expect(receiver.delta).toBe(100);
    });

    it('credits the hosts ladder only when the receiver holds a seat', async () => {
      await service.recordGift(giftInput());
      expect(
        store.incrementMany.mock.calls[0][0].some((i: Increment) => i.key.includes('|hosts}')),
      ).toBe(true);

      store.incrementMany.mockClear();
      await service.recordGift(giftInput({ transactionId: 'txn-2', receiverIsSeated: false }));
      expect(
        store.incrementMany.mock.calls[0][0].some((i: Increment) => i.key.includes('|hosts}')),
      ).toBe(false);
    });

    it('credits the hosts delta as coins x1 plus quantity x5', async () => {
      await service.recordGift(giftInput({ totalCoinValue: 100, quantity: 3 }));
      const incs = store.incrementMany.mock.calls[0][0] as Increment[];
      const host = incs.find((i) => i.key.includes('{g|hosts}'));
      // default weights: host.coins = 1, host.gifts = 5
      expect(host!.delta).toBe(100 * 1 + 3 * 5);
    });

    it('credits the rooms ladder against the room id, not a user id', async () => {
      await service.recordGift(giftInput());
      const room = store.incrementMany.mock.calls[0][0].find((i: Increment) =>
        i.key.includes('|rooms}'),
      );
      expect(room.member).toBe('room-1');
    });

    it('TTLs room-scoped keys so a dead room evicts, and never TTLs global ones', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0];
      const roomScoped = incs.filter((i: Increment) => i.key.includes('{r:room-1|'));
      const globalScoped = incs.filter((i: Increment) => i.key.includes('{g|'));
      expect(roomScoped.every((i: Increment) => i.ttlSeconds === 604_800)).toBe(true);
      expect(globalScoped.every((i: Increment) => i.ttlSeconds === undefined)).toBe(true);
    });

    it('bumps every touched ladder version in ONE pipelined call', async () => {
      await service.recordGift(giftInput());
      expect(store.bumpVersionMany).toHaveBeenCalledTimes(1);
      const pairs = store.bumpVersionMany.mock.calls[0][1] as VersionPair[];
      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.some((p) => p.scope === 'g' && p.dimension === 'gifters')).toBe(true);
    });

    it('publishes a movement event carrying the room id for socket routing', async () => {
      await service.recordGift(giftInput());
      expect(bus.publish).toHaveBeenCalled();
      const published = bus.publish.mock.calls.map((c) => c[0].payload);
      expect(published.some((p) => p.roomId === 'room-1')).toBe(true);
    });

    it('publishes the correct event class per dimension', async () => {
      await service.recordGift(giftInput());
      const published = bus.publish.mock.calls.map((c) => c[0]);
      expect(published.some((e) => e instanceof GifterRankingUpdatedEvent)).toBe(true);
      expect(published.some((e) => e instanceof HostRankingUpdatedEvent)).toBe(true);
      expect(published.some((e) => e instanceof RoomRankingUpdatedEvent)).toBe(true);
      // receivers has no dedicated event class — falls through to the default.
      expect(published.some((e) => e instanceof RankingUpdatedEvent)).toBe(true);
    });

    it('is a no-op when the engine is disabled', async () => {
      const disabled = new VideoRoomRankingService(
        { get: () => ({ enabled: 'false' }) } as never,
        store as never,
        new RankingPeriodResolver(),
        new VideoRoomRankingScoreEngine({ get: () => ({}) } as never),
        scopes as never,
        bus as never,
      );
      await disabled.recordGift(giftInput());
      expect(store.incrementMany).not.toHaveBeenCalled();
    });

    it('issues one batched write rather than one per key', async () => {
      await service.recordGift(giftInput());
      expect(store.incrementMany).toHaveBeenCalledTimes(1);
    });

    it('resolves every attributed user in ONE geoForMany call, not N sequential lookups', async () => {
      await service.recordGift(giftInput());
      expect(scopes.geoForMany).toHaveBeenCalledTimes(1);
      expect(scopes.geoForMany).toHaveBeenCalledWith(
        expect.arrayContaining(['sender-1', 'receiver-1']),
      );
    });

    it('claims the dedupe marker exactly once, strictly before the batched write', async () => {
      await service.recordGift(giftInput());
      expect(store.markSeen).toHaveBeenCalledTimes(1);
      const markSeenOrder = store.markSeen.mock.invocationCallOrder[0];
      const incrementManyOrder = store.incrementMany.mock.invocationCallOrder[0];
      expect(markSeenOrder).toBeLessThan(incrementManyOrder);
    });
  });

  describe('recordGiftRefund', () => {
    it('applies a negative delta under its own dedupe marker', async () => {
      await service.recordGiftRefund(giftInput());
      expect(store.markSeen).toHaveBeenCalledWith(
        'vrank',
        'gift-refund',
        'txn-1',
        expect.any(Number),
      );
      const incs = store.incrementMany.mock.calls[0][0];
      expect(incs.every((i: Increment) => i.delta <= 0)).toBe(true);
    });

    it('exactly mirrors the gift: same {key, member} set, every delta negated', async () => {
      await service.recordGift(giftInput());
      const giftIncs = store.incrementMany.mock.calls[0][0] as Increment[];
      store.incrementMany.mockClear();

      await service.recordGiftRefund(giftInput());
      const refundIncs = store.incrementMany.mock.calls[0][0] as Increment[];

      expect(refundIncs).toHaveLength(giftIncs.length);
      const byKeyMember = new Map(giftIncs.map((i) => [`${i.key}::${i.member}`, i]));
      for (const r of refundIncs) {
        const g = byKeyMember.get(`${r.key}::${r.member}`);
        expect(g).toBeDefined();
        // A refund emitting a uniform -1 (or any magnitude not tied to the
        // gift) would fail this — delta<=0 alone would not catch it.
        expect(r.delta).toBe(-(g as Increment).delta);
      }
    });
  });

  describe('recordPkResult', () => {
    it('scores a winner above a loser on the pk ladder', async () => {
      await service.recordPkResult({
        battleId: 'b1',
        roomId: 'room-1',
        occurredAt: AT,
        outcomes: [
          { userId: 'w', won: true, lost: false, score: 100 },
          { userId: 'l', won: false, lost: true, score: 100 },
        ],
      });
      const incs = store.incrementMany.mock.calls[0][0];
      const w = incs.find(
        (i: { member: string; key: string }) => i.member === 'w' && i.key.includes('|pk}'),
      );
      const l = incs.find(
        (i: { member: string; key: string }) => i.member === 'l' && i.key.includes('|pk}'),
      );
      expect(w.delta).toBeGreaterThan(l.delta);
    });

    it('dedupes on the battle id', async () => {
      await service.recordPkResult({
        battleId: 'b1',
        roomId: 'r',
        occurredAt: AT,
        outcomes: [{ userId: 'w', won: true, lost: false, score: 10 }],
      });
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'pk', 'b1', expect.any(Number));
    });

    it('publishes a PKRankingUpdatedEvent', async () => {
      await service.recordPkResult({
        battleId: 'b1',
        roomId: 'room-1',
        occurredAt: AT,
        outcomes: [{ userId: 'w', won: true, lost: false, score: 10 }],
      });
      expect(bus.publish.mock.calls.some((c) => c[0] instanceof PKRankingUpdatedEvent)).toBe(true);
    });

    it('does NOT claim the dedupe marker for an empty outcomes list — nothing to redeliver-drop', async () => {
      await service.recordPkResult({ battleId: 'b1', roomId: 'r', occurredAt: AT, outcomes: [] });
      expect(store.markSeen).not.toHaveBeenCalled();
      expect(store.incrementMany).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('recordTreasureWin', () => {
    it('dedupes on the reward id and credits the treasure ladder', async () => {
      await service.recordTreasureWin({
        rewardId: 'rw-1',
        roomId: 'room-1',
        userId: 'u1',
        amount: 250,
        occurredAt: AT,
      });
      expect(store.markSeen).toHaveBeenCalledWith('vrank', 'treasure', 'rw-1', expect.any(Number));
      const inc = store.incrementMany.mock.calls[0][0].find((i: Increment) =>
        i.key.includes('|treasure}'),
      );
      expect(inc.member).toBe('u1');
      expect(inc.delta).toBe(250);
    });

    it('publishes a TreasureRankingUpdatedEvent', async () => {
      await service.recordTreasureWin({
        rewardId: 'rw-1',
        roomId: 'room-1',
        userId: 'u1',
        amount: 250,
        occurredAt: AT,
      });
      expect(bus.publish.mock.calls.some((c) => c[0] instanceof TreasureRankingUpdatedEvent)).toBe(
        true,
      );
    });
  });

  describe('recordRoomActivity', () => {
    it('dedupes on the activity id and credits the rooms ladder with the composite value', async () => {
      await service.recordRoomActivity({
        activityId: 'tick-1',
        roomId: 'room-1',
        occurredAt: AT,
        peakViewers: 50,
        avgWatchSeconds: 120,
        pkCount: 2,
        treasureCount: 1,
      });
      expect(store.markSeen).toHaveBeenCalledWith(
        'vrank',
        'room-activity',
        'tick-1',
        expect.any(Number),
      );
      const inc = (store.incrementMany.mock.calls[0][0] as Increment[]).find((i) =>
        i.key.includes('{g|rooms}'),
      );
      expect(inc!.member).toBe('room-1');
      // default weights: peakViewers 10, avgWatchSeconds 0.05, pkCount 100, treasureCount 25
      expect(inc!.delta).toBe(50 * 10 + 120 * 0.05 + 2 * 100 + 1 * 25);
    });

    it('publishes a RoomRankingUpdatedEvent', async () => {
      await service.recordRoomActivity({
        activityId: 'tick-1',
        roomId: 'room-1',
        occurredAt: AT,
        peakViewers: 50,
      });
      expect(bus.publish.mock.calls.some((c) => c[0] instanceof RoomRankingUpdatedEvent)).toBe(
        true,
      );
    });

    it('never scopes the rooms ladder by country or city — no user to attribute it to', async () => {
      await service.recordRoomActivity({
        activityId: 'tick-2',
        roomId: 'room-1',
        occurredAt: AT,
        peakViewers: 10,
      });
      expect(scopes.geoForMany).not.toHaveBeenCalled();
      const keys = (store.incrementMany.mock.calls[0][0] as Increment[]).map((i) => i.key);
      expect(keys.every((k) => k.includes('{g|') || k.includes('{r:room-1|'))).toBe(true);
    });

    it('is a no-op — and never claims its dedupe marker — when every metric is absent', async () => {
      await service.recordRoomActivity({
        activityId: 'tick-noop',
        roomId: 'room-1',
        occurredAt: AT,
      });
      expect(store.markSeen).not.toHaveBeenCalled();
      expect(store.incrementMany).not.toHaveBeenCalled();
      expect(store.bumpVersionMany).not.toHaveBeenCalled();
    });
  });

  describe('per-dimension geography attribution', () => {
    beforeEach(() => {
      scopes.geoForMany.mockImplementation(async (ids: string[]) => {
        const map = new Map<string, Geo>();
        for (const id of ids) {
          if (id === 'sender-1') map.set(id, { country: 'IN', city: null });
          else if (id === 'receiver-1') map.set(id, { country: 'US', city: null });
          else map.set(id, { country: null, city: null });
        }
        return map;
      });
    });

    it('scopes the gifter entry under the SENDER country and the receiver/host entries under the RECEIVER country', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0] as Increment[];

      expect(incs.some((i) => i.key.includes('{c:IN|gifters}') && i.member === 'sender-1')).toBe(
        true,
      );
      expect(incs.some((i) => i.key.includes('{c:US|gifters}'))).toBe(false);

      expect(
        incs.some((i) => i.key.includes('{c:US|receivers}') && i.member === 'receiver-1'),
      ).toBe(true);
      expect(incs.some((i) => i.key.includes('{c:IN|receivers}'))).toBe(false);

      expect(incs.some((i) => i.key.includes('{c:US|hosts}') && i.member === 'receiver-1')).toBe(
        true,
      );
      expect(incs.some((i) => i.key.includes('{c:IN|hosts}'))).toBe(false);
    });

    it('never places a rooms entry under any country or city scope', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0] as Increment[];
      const roomEntries = incs.filter((i) => i.key.includes('|rooms}'));
      expect(roomEntries.length).toBeGreaterThan(0);
      expect(roomEntries.every((i) => !i.key.includes('{c:') && !i.key.includes('{y:'))).toBe(true);
      expect(
        roomEntries.every((i) => i.key.includes('{g|rooms}') || i.key.includes('{r:room-1|rooms}')),
      ).toBe(true);
    });

    it('the SENDER, not the receiver, drives gifter scope resolution', async () => {
      await service.recordGift(giftInput());
      const incs = store.incrementMany.mock.calls[0][0] as Increment[];
      const gifters = incs.filter((i) => i.key.includes('|gifters}'));
      expect(gifters.some((i) => i.key.includes('{c:IN|gifters}'))).toBe(true);
      expect(gifters.some((i) => i.key.includes('{c:US|gifters}'))).toBe(false);
    });

    it('does not corrupt version-key packing when a resolved city id contains a pipe', async () => {
      scopes.geoForMany.mockResolvedValueOnce(
        new Map<string, Geo>([
          ['sender-1', { country: null, city: 'evil|city' }],
          ['receiver-1', { country: null, city: null }],
        ]),
      );
      await service.recordGift(giftInput());

      const pairs = store.bumpVersionMany.mock.calls[0][1] as VersionPair[];
      const cityPairs = pairs.filter((p) => p.scope === 'y:evil|city');
      expect(cityPairs).toHaveLength(1);
      expect(cityPairs[0].dimension).toBe('gifters');

      // The increments themselves must also carry the intact scope.
      const incs = store.incrementMany.mock.calls[0][0] as Increment[];
      expect(incs.some((i) => i.key.includes('{y:evil|city|gifters}'))).toBe(true);
    });
  });

  describe('never-throw guarantee', () => {
    it('swallows a store failure — a ranking write must never fail a gift', async () => {
      store.incrementMany.mockRejectedValue(new Error('redis down'));
      await expect(service.recordGift(giftInput())).resolves.toBeUndefined();
    });

    it('does not reject when store.incrementMany rejects with undefined (a bare Promise.reject())', async () => {
      store.incrementMany.mockRejectedValue(undefined);
      await expect(service.recordGift(giftInput())).resolves.toBeUndefined();
    });

    it('does not reject when bus.publish rejects with undefined for every dimension', async () => {
      bus.publish.mockRejectedValue(undefined);
      await expect(service.recordGift(giftInput())).resolves.toBeUndefined();
    });
  });

  describe('concurrent, fault-isolated publish', () => {
    it('publishes all four dimension events even when the first publish rejects', async () => {
      bus.publish.mockRejectedValueOnce(new Error('socket bridge down'));
      await service.recordGift(giftInput());
      expect(bus.publish).toHaveBeenCalledTimes(4);
    });

    it('does not throw and does not block on a rejecting publish', async () => {
      bus.publish.mockRejectedValue(new Error('socket bridge down'));
      await expect(service.recordGift(giftInput())).resolves.toBeUndefined();
      // The write itself must still have gone through — a publish failure is
      // not a write failure.
      expect(store.incrementMany).toHaveBeenCalledTimes(1);
    });
  });
});
