import { TreasureSessionStatus } from '@prisma/client';
import { TreasureBoxException } from '../exceptions/video-room-treasure.exceptions';
import { VideoRoomTreasureService } from './video-room-treasure.service';

const ACTOR = { id: 'owner-1', roles: ['USER'] } as never;

const LEVELS = [1, 2].map((level) => ({
  level,
  threshold: BigInt(level * 15_000),
  poolStrategy: 'PERCENTAGE',
  poolPercentBps: 1000,
  poolFixedAmount: null,
  winnerAlgorithm: 'RANDOM',
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
}));

describe('VideoRoomTreasureService', () => {
  let repo: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let perms: { assertPermission: jest.Mock };
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomTreasureService;

  const config = { get: () => ({ enabled: 'true' }) };
  const names = () => bus.publish.mock.calls.map((c) => (c[0] as { name: string }).name);

  beforeEach(() => {
    repo = {
      listEnabledLevels: jest.fn().mockResolvedValue(LEVELS),
      findCurrentSession: jest.fn().mockResolvedValue(null),
      createSession: jest.fn().mockResolvedValue({ id: 's1', roomId: 'r1', currentLevel: 1 }),
      transitionSession: jest.fn().mockResolvedValue({ id: 's1', roomId: 'r1', currentLevel: 1 }),
      listBoxes: jest.fn().mockResolvedValue([{ id: 'b1', level: 1, threshold: 15_000n }]),
      listSessions: jest.fn().mockResolvedValue([[], 0]),
      activateBox: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner-1' }),
      getSettings: jest.fn().mockResolvedValue({ allowTreasure: true }),
    };
    perms = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomTreasureService(
      repo as never,
      rooms as never,
      perms as never,
      locks as never,
      bus as never,
      config as never,
    );
  });

  describe('create', () => {
    it('freezes the whole ladder into the session snapshot', async () => {
      await service.create(ACTOR, 'r1');
      const arg = repo.createSession.mock.calls[0][0];
      expect(arg.levelSnapshot).toEqual([
        expect.objectContaining({ level: 1, threshold: 15_000, winnerCount: 3 }),
        expect.objectContaining({ level: 2, threshold: 30_000 }),
      ]);
      expect(arg.boxes).toEqual([
        { level: 1, threshold: 15_000n },
        { level: 2, threshold: 30_000n },
      ]);
    });

    it('switches every level to ADMIN_OVERRIDE when a pool override is supplied', async () => {
      await service.create(ACTOR, 'r1', { poolOverride: 2_500 });
      const snapshot = repo.createSession.mock.calls[0][0].levelSnapshot;
      for (const level of snapshot) {
        expect(level.poolStrategy).toBe('ADMIN_OVERRIDE');
        expect(level.poolFixedAmount).toBe(2_500);
      }
    });

    it('requires MANAGE_TREASURE against the resolved room ref', async () => {
      await service.create(ACTOR, 'r1');
      expect(perms.assertPermission).toHaveBeenCalledWith(
        ACTOR,
        { id: 'r1', ownerId: 'owner-1' },
        'MANAGE_TREASURE',
      );
    });

    it('publishes TreasureCreated', async () => {
      await service.create(ACTOR, 'r1');
      expect(names()).toEqual(['video_room.treasure.created']);
    });

    it('carries the originating request id onto the event', async () => {
      await service.create(ACTOR, 'r1', {}, 'req-abc');
      expect(bus.publish.mock.calls[0][0].payload.requestId).toBe('req-abc');
    });

    it('refuses when a ladder already exists in the room', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's0' });
      await expect(service.create(ACTOR, 'r1')).rejects.toThrow(TreasureBoxException);
      expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('refuses when the room disabled treasure', async () => {
      rooms.getSettings.mockResolvedValue({ allowTreasure: false });
      await expect(service.create(ACTOR, 'r1')).rejects.toThrow(TreasureBoxException);
    });

    // A configuration fault must not masquerade as a state conflict — the exact
    // defect this phase fixed in the audio engine.
    it('reports an unconfigured ladder as 424, not as "already active"', async () => {
      repo.listEnabledLevels.mockResolvedValue([]);
      await expect(service.create(ACTOR, 'r1')).rejects.toMatchObject({ status: 424 });
    });

    it('refuses when the room does not exist', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(service.create(ACTOR, 'r1')).rejects.toMatchObject({ status: 404 });
    });

    it('refuses when the engine is disabled by config', async () => {
      service = new VideoRoomTreasureService(
        repo as never,
        rooms as never,
        perms as never,
        locks as never,
        bus as never,
        { get: () => ({ enabled: 'false' }) } as never,
      );
      await expect(service.create(ACTOR, 'r1')).rejects.toMatchObject({ status: 503 });
    });

    it('serialises the read-then-write on the per-room lock', async () => {
      await service.create(ACTOR, 'r1');
      expect(locks.withLock).toHaveBeenCalledWith(
        'video-room:treasure:lifecycle:{r1}',
        expect.any(Function),
      );
    });
  });

  describe('start', () => {
    beforeEach(() => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1', status: TreasureSessionStatus.DRAFT });
    });

    it('moves DRAFT to ACTIVE and activates level 1', async () => {
      await service.start(ACTOR, 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        [TreasureSessionStatus.DRAFT],
        TreasureSessionStatus.ACTIVE,
      );
      expect(repo.activateBox).toHaveBeenCalledWith('b1');
      expect(names()).toEqual(['video_room.treasure.started']);
    });

    it('carries the originating request id onto the started event', async () => {
      await service.start(ACTOR, 'r1', 'req-xyz');
      expect(bus.publish.mock.calls[0][0].payload.requestId).toBe('req-xyz');
    });

    // The conditional UPDATE resolves two concurrent owner clicks; the loser
    // must not also emit an event for work it did not do.
    it('throws and publishes nothing when the session was not in DRAFT', async () => {
      repo.transitionSession.mockResolvedValue(null);
      await expect(service.start(ACTOR, 'r1')).rejects.toThrow(TreasureBoxException);
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('pause / resume', () => {
    beforeEach(() => repo.findCurrentSession.mockResolvedValue({ id: 's1' }));

    it('pauses only from ACTIVE', async () => {
      await service.pause(ACTOR, 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        [TreasureSessionStatus.ACTIVE],
        TreasureSessionStatus.PAUSED,
      );
    });

    it('resumes only from PAUSED', async () => {
      await service.resume(ACTOR, 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        [TreasureSessionStatus.PAUSED],
        TreasureSessionStatus.ACTIVE,
      );
    });

    it('throws when there is no ladder at all', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      await expect(service.pause(ACTOR, 'r1')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('close', () => {
    it('closes from DRAFT, ACTIVE or PAUSED and publishes TreasureClosed', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await service.close(ACTOR, 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's1',
        [TreasureSessionStatus.DRAFT, TreasureSessionStatus.ACTIVE, TreasureSessionStatus.PAUSED],
        TreasureSessionStatus.CLOSED,
      );
      expect(names()).toEqual(['video_room.treasure.closed']);
    });

    it('carries the originating request id onto the closed event', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await service.close(ACTOR, 'r1', 'req-close');
      expect(bus.publish.mock.calls[0][0].payload.requestId).toBe('req-close');
    });
  });

  describe('archive', () => {
    it('archives only a finished ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      repo.listSessions.mockResolvedValue([[{ id: 's-old' }], 1]);
      await service.archive(ACTOR, 'r1');
      expect(repo.transitionSession).toHaveBeenCalledWith(
        's-old',
        [TreasureSessionStatus.COMPLETED, TreasureSessionStatus.CLOSED],
        TreasureSessionStatus.ARCHIVED,
      );
    });

    it('refuses while a ladder is still live', async () => {
      repo.findCurrentSession.mockResolvedValue({ id: 's1' });
      await expect(service.archive(ACTOR, 'r1')).rejects.toThrow(TreasureBoxException);
    });

    it('404s when the room has never had a ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      repo.listSessions.mockResolvedValue([[], 0]);
      await expect(service.archive(ACTOR, 'r1')).rejects.toMatchObject({ status: 404 });
    });
  });
});
