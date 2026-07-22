import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureProgressService } from './video-room-treasure-progress.service';

/**
 * Cross-service behaviour no single unit test can prove.
 *
 * These use the REAL progress service against an in-memory box store whose
 * `updateMany` honours its WHERE clause — so the compare-and-set and the
 * ACTIVE→UNLOCKING claim behave the way Postgres does, and the interaction
 * between the cascade, the CAS and the claim is genuinely exercised rather than
 * mocked away.
 */

interface FakeBox {
  id: string;
  level: number;
  sessionId: string;
  roomId: string;
  threshold: bigint;
  progress: bigint;
  status: TreasureBoxStatus;
}

/** Records every table the engine touched, so forbidden writes are detectable. */
class FakeStore {
  readonly boxes = new Map<string, FakeBox>();
  readonly contributions: { boxId: string; userId: string; amount: bigint }[] = [];
  readonly touchedTables = new Set<string>();
  claims = 0;

  constructor(boxes: FakeBox[]) {
    for (const b of boxes) this.boxes.set(b.id, { ...b });
  }

  get repo() {
    return {
      findCurrentSession: async () => ({
        id: 's1',
        roomId: 'r1',
        currentLevel: 1,
        status: TreasureSessionStatus.ACTIVE,
      }),
      listBoxes: async () => [...this.boxes.values()].map((b) => ({ ...b })),
      getBox: async (id: string) => {
        const b = this.boxes.get(id);
        return b ? { ...b } : null;
      },
      // Honours the WHERE progress = observed clause, exactly like the real CAS.
      addProgress: async (id: string, observed: bigint, delta: bigint) => {
        const b = this.boxes.get(id)!;
        this.touchedTables.add('treasureBox');
        if (b.progress !== observed) return null;
        b.progress = observed + delta;
        return { ...b };
      },
      // Honours the WHERE status = ACTIVE clause: exactly one caller wins.
      claimUnlock: async (id: string) => {
        const b = this.boxes.get(id)!;
        if (b.status !== TreasureBoxStatus.ACTIVE) return false;
        b.status = TreasureBoxStatus.UNLOCKING;
        this.claims += 1;
        return true;
      },
      addContribution: async (input: { boxId: string; userId: string; amount: bigint }) => {
        this.touchedTables.add('treasureContribution');
        this.contributions.push(input);
      },
      setSessionLevel: async () => {
        this.touchedTables.add('treasureSession');
      },
      activateBox: async (id: string) => {
        const b = this.boxes.get(id);
        if (b && b.status === TreasureBoxStatus.PENDING) b.status = TreasureBoxStatus.ACTIVE;
      },
    };
  }
}

const ladder = (): FakeBox[] => [
  {
    id: 'b1',
    level: 1,
    sessionId: 's1',
    roomId: 'r1',
    threshold: 15_000n,
    progress: 0n,
    status: TreasureBoxStatus.ACTIVE,
  },
  {
    id: 'b2',
    level: 2,
    sessionId: 's1',
    roomId: 'r1',
    threshold: 60_000n,
    progress: 0n,
    status: TreasureBoxStatus.PENDING,
  },
  {
    id: 'b3',
    level: 3,
    sessionId: 's1',
    roomId: 'r1',
    threshold: 200_000n,
    progress: 0n,
    status: TreasureBoxStatus.PENDING,
  },
  {
    id: 'b4',
    level: 4,
    sessionId: 's1',
    roomId: 'r1',
    threshold: 350_000n,
    progress: 0n,
    status: TreasureBoxStatus.PENDING,
  },
];

const build = (store: FakeStore) => {
  const cache = {
    get: async () => null,
    set: async () => undefined,
    increment: async () => 1,
    del: async () => 1,
  };
  const redis = { hincrby: async () => 1, expire: async () => 1 };
  const config = { get: () => ({ progressEmitPerSecond: '5' }) };
  return new VideoRoomTreasureProgressService(
    store.repo as never,
    cache as never,
    config as never,
    redis as never,
  );
};

describe('VR-11 treasure integration', () => {
  describe('concurrent gifts crossing one threshold', () => {
    it('produces exactly one claim across N racing transactions', async () => {
      const store = new FakeStore([{ ...ladder()[0], progress: 14_000n }, ...ladder().slice(1)]);
      const service = build(store);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          service.apply({} as never, {
            roomId: 'r1',
            senderId: `u${i}`,
            amount: 2_000,
            giftTxnId: `g${i}`,
          }),
        ),
      );

      // The DB-level claim fired once; exactly one caller is the enqueuer.
      expect(store.claims).toBe(1);
      expect(results.filter((r) => r.claimedBoxId !== null)).toHaveLength(1);
    });

    it('never records more contribution value than was actually applied', async () => {
      const store = new FakeStore(ladder());
      const service = build(store);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          service.apply({} as never, {
            roomId: 'r1',
            senderId: `u${i}`,
            amount: 1_000,
            giftTxnId: `g${i}`,
          }),
        ),
      );

      const recorded = store.contributions.reduce((s, c) => s + c.amount, 0n);
      const reported = results.reduce((s, r) => s + BigInt(r.applied), 0n);
      // The CAS-delta bug would have inflated both of these past the real total.
      expect(recorded).toBe(reported);
      expect(recorded).toBeLessThanOrEqual(6_000n);
    });
  });

  describe('combo gift across four levels', () => {
    it('claims every crossed level but reports only the lowest for enqueue', async () => {
      const store = new FakeStore(ladder());
      const service = build(store);

      // 400,000 into a fresh 15k/60k/200k/350k ladder crosses L1..L3 and
      // partially fills L4.
      const res = await service.apply({} as never, {
        roomId: 'r1',
        senderId: 'whale',
        amount: 400_000,
        giftTxnId: 'g-combo',
      });

      expect(res.applied).toBe(400_000);
      // Only the lowest crossed box is enqueued; the unlock handler chains the
      // rest, which is what keeps payouts and animations in level order.
      expect(res.claimedLevel).toBe(1);
      expect(res.claimedBoxId).toBe('b1');

      const status = (id: string) => store.boxes.get(id)!.status;
      expect(status('b1')).toBe(TreasureBoxStatus.UNLOCKING);
      expect(status('b2')).toBe(TreasureBoxStatus.UNLOCKING);
      expect(status('b3')).toBe(TreasureBoxStatus.UNLOCKING);
      expect(status('b4')).toBe(TreasureBoxStatus.ACTIVE);
      expect(store.boxes.get('b4')!.progress).toBe(125_000n);
    });

    it('stops counting past the final box and refunds nothing', async () => {
      const store = new FakeStore(ladder());
      const service = build(store);
      const res = await service.apply({} as never, {
        roomId: 'r1',
        senderId: 'whale',
        amount: 5_000_000,
        giftTxnId: 'g-huge',
      });
      // Ladder capacity is 15k + 60k + 200k + 350k = 625,000.
      expect(res.applied).toBe(625_000);
    });
  });

  // Spec D10: UserContributionCounter is keyed by userId alone, so writing it
  // from video would move totals displayed inside AUDIO rooms.
  describe('BC: audio-room contribution counters', () => {
    it('never writes RoomContributionCounter or UserContributionCounter', async () => {
      const store = new FakeStore(ladder());
      const service = build(store);
      await service.apply({} as never, {
        roomId: 'r1',
        senderId: 'u1',
        amount: 20_000,
        giftTxnId: 'g1',
      });
      expect(store.touchedTables.has('roomContributionCounter')).toBe(false);
      expect(store.touchedTables.has('userContributionCounter')).toBe(false);
      expect([...store.touchedTables].sort()).toEqual([
        'treasureBox',
        'treasureContribution',
        'treasureSession',
      ]);
    });

    it('exposes no counter method on the video treasure repository', async () => {
      const { VideoRoomTreasureRepository } =
        await import('../repositories/video-room-treasure.repository');
      const methods = Object.getOwnPropertyNames(VideoRoomTreasureRepository.prototype);
      expect(methods).not.toContain('incrementRoomContribution');
      expect(methods).not.toContain('incrementUserContribution');
    });
  });
});
