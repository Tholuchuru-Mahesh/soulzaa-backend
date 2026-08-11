import { PkMode, PkResult, PkSide, PkStatus } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { QueueService } from 'src/infra/queue/queue.service';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { PkBattleRepository } from '../repositories/pk-battle.repository';
import { RoomPermissionService } from './room-permission.service';
import { PkBattleService } from './pk-battle.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const ROOM = 'room-1';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function battle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'battle-1',
    roomId: ROOM,
    mode: PkMode.ONE_VS_ONE,
    status: PkStatus.ACTIVE,
    durationSeconds: 300,
    startedBy: OWNER.id,
    redScore: 0n,
    blueScore: 0n,
    result: null,
    startedAt: new Date(),
    endsAt: new Date(Date.now() + 300000),
    completedAt: null,
    ...overrides,
  };
}

describe('PkBattleService', () => {
  let repo: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let cache: Record<string, jest.Mock>;
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let cosmetics: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let service: PkBattleService;

  beforeEach(() => {
    repo = {
      getActive: jest.fn().mockResolvedValue(null),
      getBattle: jest.fn().mockResolvedValue(battle()),
      createBattle: jest.fn().mockResolvedValue(battle()),
      createParticipants: jest.fn().mockResolvedValue({ count: 2 }),
      listParticipants: jest.fn().mockResolvedValue([
        { id: 'p1', userId: A, side: PkSide.RED, score: 100n },
        { id: 'p2', userId: B, side: PkSide.BLUE, score: 40n },
      ]),
      findParticipant: jest
        .fn()
        .mockResolvedValue({ id: 'p1', userId: A, side: PkSide.RED, score: 0n }),
      applyContribution: jest.fn().mockResolvedValue(battle({ redScore: 50n })),
      complete: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      findExpired: jest.fn().mockResolvedValue([]),
      createReward: jest.fn().mockResolvedValue(undefined),
      listBattles: jest.fn().mockResolvedValue([[], 0]),
      listParticipantBattles: jest.fn().mockResolvedValue([]),
    };
    rooms = {
      findLiveRoomRow: jest.fn().mockResolvedValue({ id: ROOM }),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      findRoomRow: jest.fn().mockResolvedValue({ id: ROOM, name: 'Music Night' }),
    };
    permissions = { getEffectiveRole: jest.fn().mockResolvedValue('OWNER') };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    cache = { addScore: jest.fn().mockResolvedValue(1), top: jest.fn().mockResolvedValue([]) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    cosmetics = {
      ensureCosmetic: jest.fn().mockResolvedValue('badge-1'),
      grantToUser: jest.fn().mockResolvedValue({ backpackItemId: 'i1', duplicate: false }),
    };
    users = { findById: jest.fn().mockResolvedValue({ id: A, username: 'alice' }) };
    service = new PkBattleService(
      repo as unknown as PkBattleRepository,
      rooms as unknown as AudioRoomsRepository,
      permissions as unknown as RoomPermissionService,
      locks as unknown as LockService,
      cache as unknown as CacheService,
      queue as unknown as QueueService,
      bus,
      cosmetics as unknown as ICosmeticsService,
      users as unknown as IUsersService,
    );
  });

  describe('start', () => {
    it('creates a 1v1 battle with participants and broadcasts', async () => {
      await service.start(OWNER, ROOM, {
        mode: PkMode.ONE_VS_ONE,
        durationSeconds: 300,
        red: [A],
        blue: [B],
      });
      expect(repo.createBattle).toHaveBeenCalled();
      expect(repo.createParticipants).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.pk_started' }),
      );
    });

    it('rejects a non owner/admin', async () => {
      permissions.getEffectiveRole.mockResolvedValue('LISTENER');
      await expect(
        service.start(OWNER, ROOM, {
          mode: PkMode.ONE_VS_ONE,
          durationSeconds: 300,
          red: [A],
          blue: [B],
        }),
      ).rejects.toMatchObject({ errorCode: 'PK_NOT_AUTHORIZED' });
    });

    it('rejects 1v1 with more than one per side', async () => {
      await expect(
        service.start(OWNER, ROOM, {
          mode: PkMode.ONE_VS_ONE,
          durationSeconds: 300,
          red: [A, B],
          blue: [B],
        }),
      ).rejects.toMatchObject({ errorCode: 'PK_INVALID_PARTICIPANTS' });
    });

    it('rejects overlapping participants', async () => {
      await expect(
        service.start(OWNER, ROOM, {
          mode: PkMode.TEAM,
          durationSeconds: 300,
          red: [A],
          blue: [A],
        }),
      ).rejects.toMatchObject({ errorCode: 'PK_INVALID_PARTICIPANTS' });
    });

    it('rejects a non-member participant', async () => {
      rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(
        service.start(OWNER, ROOM, {
          mode: PkMode.ONE_VS_ONE,
          durationSeconds: 300,
          red: [A],
          blue: [B],
        }),
      ).rejects.toMatchObject({ errorCode: 'PK_PARTICIPANT_NOT_MEMBER' });
    });

    it('rejects a second active battle', async () => {
      repo.getActive.mockResolvedValue(battle());
      await expect(
        service.start(OWNER, ROOM, {
          mode: PkMode.ONE_VS_ONE,
          durationSeconds: 300,
          red: [A],
          blue: [B],
        }),
      ).rejects.toMatchObject({ errorCode: 'PK_ALREADY_ACTIVE' });
    });
  });

  describe('handleGift', () => {
    it('adds a gift to the receiver’s side and broadcasts the live score', async () => {
      repo.getActive.mockResolvedValue(battle());
      await service.handleGift(ROOM, A, 50, 'gtxn-1');
      expect(repo.applyContribution).toHaveBeenCalledWith(
        expect.objectContaining({ participantId: 'p1', side: PkSide.RED, amount: 50n }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.pk_score' }),
      );
    });

    it('ignores a gift to a non-participant', async () => {
      repo.getActive.mockResolvedValue(battle());
      repo.findParticipant.mockResolvedValue(null);
      await service.handleGift(ROOM, 'someone', 50, 'gtxn-2');
      expect(repo.applyContribution).not.toHaveBeenCalled();
    });

    it('is a no-op when no battle is active', async () => {
      repo.getActive.mockResolvedValue(null);
      await service.handleGift(ROOM, A, 50, 'gtxn-3');
      expect(repo.applyContribution).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('picks the higher side, grants winner badges + ranking, and broadcasts', async () => {
      repo.getBattle.mockResolvedValue(battle({ redScore: 100n, blueScore: 40n }));
      await service.complete(battle({ id: 'battle-1' }) as never);
      expect(repo.complete).toHaveBeenCalledWith('battle-1', PkResult.RED);
      expect(cosmetics.grantToUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: A,
          grantKey: 'pk:battle-1:11111111-1111-1111-1111-111111111111',
        }),
      );
      expect(cache.addScore).toHaveBeenCalledWith('pk:wins', A, 1);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.pk_ended' }),
      );
    });

    it('records a DRAW without granting badges', async () => {
      repo.getBattle.mockResolvedValue(battle({ redScore: 50n, blueScore: 50n }));
      await service.complete(battle({ id: 'battle-1' }) as never);
      expect(repo.complete).toHaveBeenCalledWith('battle-1', PkResult.DRAW);
      expect(cosmetics.grantToUser).not.toHaveBeenCalled();
    });

    it('is a no-op for an already-completed battle', async () => {
      repo.getBattle.mockResolvedValue(battle({ status: PkStatus.COMPLETED }));
      await service.complete(battle({ id: 'battle-1' }) as never);
      expect(repo.complete).not.toHaveBeenCalled();
    });
  });

  describe('historyForCreator (Creator Center — PK History)', () => {
    function row(overrides: {
      side?: PkSide;
      result?: PkResult | null;
      score?: bigint;
    } = {}) {
      return {
        participant: { id: 'p1', battleId: 'battle-1', userId: A, side: overrides.side ?? PkSide.RED, score: overrides.score ?? 100n },
        battle: battle({ status: PkStatus.COMPLETED, result: overrides.result ?? PkResult.RED, completedAt: new Date() }),
      };
    }

    it('filters to wins, losses, or draws relative to the caller\'s own side', async () => {
      repo.listParticipantBattles.mockResolvedValue([
        row({ side: PkSide.RED, result: PkResult.RED }), // win
        row({ side: PkSide.RED, result: PkResult.BLUE }), // loss
        row({ side: PkSide.RED, result: PkResult.DRAW }), // draw
      ]);

      const wins = await service.historyForCreator(A, { skip: 0, limit: 20, page: 1, filter: 'wins' });
      const losses = await service.historyForCreator(A, { skip: 0, limit: 20, page: 1, filter: 'losses' });
      const draws = await service.historyForCreator(A, { skip: 0, limit: 20, page: 1, filter: 'draws' });
      const all = await service.historyForCreator(A, { skip: 0, limit: 20, page: 1, filter: 'all' });

      expect(wins.total).toBe(1);
      expect(losses.total).toBe(1);
      expect(draws.total).toBe(1);
      expect(all.total).toBe(3);
    });

    it('only ever returns battles the caller actually participated in', async () => {
      // The repository itself is what scopes by userId (queried by userId), so
      // a caller who never fought never gets rows back — verify the id is passed through.
      repo.listParticipantBattles.mockResolvedValue([]);
      await service.historyForCreator(B, { skip: 0, limit: 20, page: 1, filter: 'all' });
      expect(repo.listParticipantBattles).toHaveBeenCalledWith(B);
    });

    it('resolves opponent identity and reports the caller\'s own result label', async () => {
      repo.listParticipantBattles.mockResolvedValue([row({ side: PkSide.RED, result: PkResult.RED })]);
      repo.listParticipants.mockResolvedValue([
        { id: 'p1', userId: A, side: PkSide.RED, score: 100n },
        { id: 'p2', userId: B, side: PkSide.BLUE, score: 40n },
      ]);
      users.findById.mockResolvedValue({ id: B, username: 'bob' });

      const result = await service.historyForCreator(A, { skip: 0, limit: 20, page: 1, filter: 'all' });

      const entry = result.items[0] as {
        opponents: { userId: string; username: string | null }[];
        myResult: string;
        roomName: string | null;
      };
      expect(entry.opponents).toEqual([{ userId: B, username: 'bob', score: 40 }]);
      expect(entry.myResult).toBe('WIN');
      expect(entry.roomName).toBe('Music Night');
    });
  });

  describe('getCreatorBattleDetail (Creator Center — PK History)', () => {
    it('returns null when the caller was never a participant in that battle', async () => {
      repo.findParticipant.mockResolvedValue(null);
      const detail = await service.getCreatorBattleDetail(A, 'battle-1');
      expect(detail).toBeNull();
    });

    it('returns the enriched detail when the caller did participate', async () => {
      repo.findParticipant.mockResolvedValue({ id: 'p1', userId: A, side: PkSide.RED, score: 100n });
      repo.getBattle.mockResolvedValue(battle({ status: PkStatus.COMPLETED, result: PkResult.RED }));

      const detail = (await service.getCreatorBattleDetail(A, 'battle-1')) as { myResult: string } | null;

      expect(detail?.myResult).toBe('WIN');
    });
  });
});
