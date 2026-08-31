import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { TreasureRepository } from '../repositories/treasure.repository';
import { RewardDistributor } from './reward-distributor.service';
import { TreasureService } from './treasure.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const ROOM = 'room-1';

function config(level: number) {
  return {
    id: `cfg-${level}`,
    level,
    threshold: 100n,
    rewards: [{ rank: 1, kind: 'COINS', coins: 50 }],
    enabled: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function box(overrides: Record<string, unknown> = {}) {
  return {
    id: 'box-1',
    sessionId: 'sess-1',
    roomId: ROOM,
    level: 1,
    threshold: 100n,
    progress: 0n,
    status: TreasureBoxStatus.ACTIVE,
    topGifters: null,
    openedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    roomId: ROOM,
    contextType: 'AUDIO_ROOM',
    startedBy: OWNER.id,
    status: TreasureSessionStatus.ACTIVE,
    currentLevel: 1,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

describe('TreasureService', () => {
  let repo: Record<string, jest.Mock>;
  let distributor: { distribute: jest.Mock };
  let locks: { withLock: jest.Mock };
  let cache: { increment: jest.Mock; del: jest.Mock; set: jest.Mock; get: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let rooms: Record<string, jest.Mock>;
  let wallet: { credit: jest.Mock };
  let service: TreasureService;

  beforeEach(() => {
    repo = {
      listEnabledConfigs: jest.fn().mockResolvedValue([1, 2, 3, 4, 5].map(config)),
      getConfig: jest.fn().mockImplementation((l: number) => Promise.resolve(config(l))),
      getActiveSession: jest.fn().mockResolvedValue(null),
      getLatestCompletedSession: jest.fn().mockResolvedValue(null),
      getLatestCompletedSessionCreatedAfter: jest.fn().mockResolvedValue(null),
      resolveUserProfiles: jest.fn().mockResolvedValue(new Map()),
      getUserPositionInBox: jest.fn().mockResolvedValue(null),
      getSession: jest.fn().mockResolvedValue(session()),
      createSession: jest.fn().mockResolvedValue(session()),
      setSessionLevel: jest.fn().mockResolvedValue(undefined),
      finishSession: jest.fn().mockResolvedValue(undefined),
      createBox: jest.fn().mockResolvedValue(box()),
      getBoxByLevel: jest.fn().mockResolvedValue(box()),
      listBoxes: jest.fn().mockResolvedValue([]),
      addContribution: jest.fn().mockResolvedValue(undefined),
      addProgress: jest.fn().mockResolvedValue(box({ progress: 50n })),
      activateBox: jest.fn().mockResolvedValue(undefined),
      openBox: jest.fn().mockResolvedValue(undefined),
      topContributors: jest
        .fn()
        .mockResolvedValue([{ userId: 'g1', amount: 60n, firstAt: new Date() }]),
      createReward: jest.fn().mockResolvedValue(undefined),
      listSessions: jest.fn().mockResolvedValue([[], 0]),
      listRewards: jest.fn().mockResolvedValue([[], 0]),
      incrementRoomContribution: jest.fn().mockResolvedValue(50n),
      incrementUserContribution: jest.fn().mockResolvedValue(50n),
      incrementRoomWeeklyContribution: jest
        .fn()
        .mockResolvedValue({ weekKey: '2026W36', amount: 50n }),
      incrementUserWeeklyContribution: jest
        .fn()
        .mockResolvedValue({ weekKey: '2026W36', amount: 50n }),
    };
    distributor = {
      distribute: jest.fn().mockResolvedValue([
        {
          userId: 'g1',
          rank: 1,
          kind: 'COINS',
          coins: 50n,
          itemType: null,
          itemName: null,
          walletTxnId: 'w1',
          backpackItemId: null,
        },
      ]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    cache = {
      increment: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    rooms = {
      getEffectiveRole: jest.fn().mockResolvedValue('OWNER'),
      isRoomLive: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue('owner-id'),
    };
    wallet = {
      credit: jest.fn().mockResolvedValue({ transactionId: 'host-reward-txn' }),
    };
    service = new TreasureService(
      repo as unknown as TreasureRepository,
      distributor as unknown as RewardDistributor,
      locks as unknown as LockService,
      cache as unknown as any,
      queue as unknown as QueueService,
      bus,
      rooms as unknown as IAudioRoomsService,
      wallet as unknown as any,
    );
  });

  describe('startSession', () => {
    it('creates a session with 5 boxes and activates box 1', async () => {
      await service.startSession(OWNER, ROOM);
      expect(repo.createSession).toHaveBeenCalled();
      expect(repo.createBox).toHaveBeenCalledTimes(5);
      expect(repo.createBox).toHaveBeenCalledWith(
        expect.objectContaining({ level: 1, status: TreasureBoxStatus.ACTIVE }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.session_started' }),
      );
    });

    it('rejects a non owner/admin', async () => {
      rooms.getEffectiveRole.mockResolvedValue('LISTENER');
      await expect(service.startSession(OWNER, ROOM)).rejects.toMatchObject({
        errorCode: 'TREASURE_NOT_AUTHORIZED',
      });
    });

    it('rejects when the 5 levels are not fully configured', async () => {
      repo.listEnabledConfigs.mockResolvedValue([1, 2, 3].map(config));
      await expect(service.startSession(OWNER, ROOM)).rejects.toMatchObject({
        errorCode: 'TREASURE_CONFIG_INCOMPLETE',
      });
    });

    // Auto-start (a682933) deliberately made same-day re-entry idempotent:
    // progress continues rather than erroring. This replaces the pre-auto-start
    // "one active session per room is an error" contract.
    it('returns the existing session on a same-day rejoin', async () => {
      const existing = session();
      repo.getActiveSession.mockResolvedValue(existing);
      await expect(service.startSession(OWNER, ROOM)).resolves.toBe(existing);
      expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('rejects when today’s boxes are all already completed', async () => {
      repo.getActiveSession.mockResolvedValue(null);
      repo.getLatestCompletedSessionCreatedAfter.mockResolvedValue(
        session({ status: TreasureSessionStatus.COMPLETED }),
      );
      await expect(service.startSession(OWNER, ROOM)).rejects.toMatchObject({
        errorCode: 'TREASURE_SESSION_EXISTS',
      });
    });
  });

  describe('handleContribution', () => {
    it('adds progress and broadcasts without opening below the threshold', async () => {
      repo.getActiveSession.mockResolvedValue(session());
      repo.addProgress.mockResolvedValue(box({ progress: 50n }));
      await service.handleContribution(ROOM, 'g1', 'host-1', 50, 'gtxn-1');
      expect(repo.addContribution).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.progress' }),
      );
      expect(repo.openBox).not.toHaveBeenCalled();
    });

    it('opens the box, distributes to Top-3, and advances when the threshold is met', async () => {
      repo.getActiveSession.mockResolvedValue(session());
      repo.addProgress.mockResolvedValue(box({ progress: 120n }));
      await service.handleContribution(ROOM, 'g1', 'host-1', 120, 'gtxn-1');
      expect(repo.topContributors).toHaveBeenCalledWith('box-1', 3);
      expect(distributor.distribute).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyPrefix: 'treasure:box-1' }),
      );
      expect(repo.createReward).toHaveBeenCalled();
      expect(repo.openBox).toHaveBeenCalled();
      expect(repo.setSessionLevel).toHaveBeenCalledWith('sess-1', 2);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.box_opened' }),
      );
    });

    it('completes the session after the 5th box opens', async () => {
      repo.getActiveSession.mockResolvedValue(session({ currentLevel: 5 }));
      repo.getSession.mockResolvedValue(session({ currentLevel: 5 }));
      repo.getBoxByLevel.mockResolvedValue(box({ level: 5 }));
      repo.addProgress.mockResolvedValue(box({ level: 5, progress: 120n }));
      await service.handleContribution(ROOM, 'g1', 'host-1', 120, 'gtxn-1');
      expect(repo.finishSession).toHaveBeenCalledWith('sess-1', TreasureSessionStatus.COMPLETED);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'treasure.session_completed' }),
      );
    });

    it('is a no-op when there is no active session', async () => {
      repo.getActiveSession.mockResolvedValue(null);
      await service.handleContribution(ROOM, 'g1', 'host-1', 50, 'gtxn-1');
      expect(repo.addContribution).not.toHaveBeenCalled();
    });
  });
});
