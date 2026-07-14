import { ModerationBanType, ModerationMuteType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import { QueueService } from 'src/infra/queue/queue.service';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ModerationService } from './moderation.service';
import { RoomPermissionService } from './room-permission.service';
import { VoiceService } from './voice.service';

const MOD: RoomActor = { id: 'mod-1', roles: ['USER'] };
const TARGET = 'target-1';

describe('ModerationService', () => {
  let repo: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let seats: Record<string, jest.Mock>;
  let presence: Record<string, jest.Mock>;
  let voice: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let queue: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let service: ModerationService;

  beforeEach(() => {
    repo = {
      findActiveKick: jest.fn().mockResolvedValue(null),
      createKick: jest.fn().mockResolvedValue({ id: 'kick-1', roomId: 'r', userId: TARGET }),
      liftKick: jest.fn().mockResolvedValue(undefined),
      listActiveKicks: jest.fn().mockResolvedValue([[], 0]),
      addKickCache: jest.fn().mockResolvedValue(undefined),
      removeKickCache: jest.fn().mockResolvedValue(undefined),
      isKickedCached: jest.fn().mockResolvedValue(false),
      resolveUserSummaries: jest.fn().mockResolvedValue(new Map()),
      findActiveBan: jest.fn().mockResolvedValue(null),
      getBan: jest.fn(),
      createBan: jest.fn().mockResolvedValue({ id: 'ban-1', roomId: 'r', userId: TARGET }),
      addBanCache: jest.fn().mockResolvedValue(undefined),
      removeBanCache: jest.fn().mockResolvedValue(undefined),
      liftBan: jest.fn().mockResolvedValue(undefined),
      isBannedCached: jest.fn().mockResolvedValue(false),
      findActiveMute: jest.fn().mockResolvedValue(null),
      getMute: jest.fn(),
      createMute: jest.fn().mockResolvedValue({ id: 'mute-1', roomId: 'r', userId: TARGET }),
      addMuteCache: jest.fn().mockResolvedValue(undefined),
      removeMuteCache: jest.fn().mockResolvedValue(undefined),
      liftMute: jest.fn().mockResolvedValue(undefined),
      isMutedCached: jest.fn().mockResolvedValue(false),
      appendAction: jest.fn().mockResolvedValue(undefined),
      addNote: jest.fn().mockResolvedValue(undefined),
      createReport: jest.fn().mockResolvedValue({ id: 'report-1' }),
      getReport: jest.fn(),
      findOpenReport: jest.fn().mockResolvedValue(null),
      reviewReport: jest.fn().mockResolvedValue(undefined),
      createAppeal: jest.fn().mockResolvedValue({ id: 'appeal-1' }),
      getAppeal: jest.fn(),
      findPendingAppeal: jest.fn().mockResolvedValue(null),
      resolveAppeal: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertCanModerate: jest.fn().mockResolvedValue(undefined),
      assertOutranks: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      deactivateMember: jest.fn().mockResolvedValue(undefined),
      removePresence: jest.fn().mockResolvedValue(undefined),
      bumpStatsOnLeave: jest.fn().mockResolvedValue(undefined),
      getOwnerId: jest.fn().mockResolvedValue('owner-1'),
      findRoomRow: jest.fn().mockResolvedValue({ id: 'r' }),
    };
    seats = { listElevatedMemberIds: jest.fn().mockResolvedValue(['owner-1']) };
    presence = {
      leaveRoom: jest.fn().mockResolvedValue(undefined),
      roomMemberCount: jest.fn().mockResolvedValue(3),
    };
    voice = {
      forceLeave: jest.fn().mockResolvedValue(undefined),
      forceMute: jest.fn().mockResolvedValue(undefined),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) as never };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };

    service = new ModerationService(
      repo as unknown as ModerationRepository,
      permissions as unknown as RoomPermissionService,
      rooms as unknown as AudioRoomsRepository,
      seats as unknown as AudioRoomSeatsRepository,
      presence as unknown as PresenceService,
      voice as unknown as VoiceService,
      locks as unknown as LockService,
      queue as unknown as QueueService,
      bus,
    );
  });

  describe('kick', () => {
    it('removes the member, tears down voice, and broadcasts', async () => {
      await service.kick(MOD, 'r', TARGET, 'spam');
      expect(rooms.deactivateMember).toHaveBeenCalledWith('r', TARGET, MOD.id);
      expect(presence.leaveRoom).toHaveBeenCalledWith('r', TARGET);
      expect(voice.forceLeave).toHaveBeenCalledWith('r', TARGET);
      expect(repo.appendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'KICK' }));
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_kicked' }),
      );
    });

    it('adds the user to the kick list and the Redis join gate', async () => {
      await service.kick(MOD, 'r', TARGET, 'spam');
      expect(repo.createKick).toHaveBeenCalledWith({
        roomId: 'r',
        userId: TARGET,
        moderatorId: MOD.id,
        reason: 'spam',
      });
      expect(repo.addKickCache).toHaveBeenCalledWith('r', TARGET);
    });

    it('does not stack a second kick row when one is already active', async () => {
      repo.findActiveKick.mockResolvedValue({ id: 'kick-existing' });
      await service.kick(MOD, 'r', TARGET, undefined);
      expect(repo.createKick).not.toHaveBeenCalled();
      expect(repo.addKickCache).toHaveBeenCalledWith('r', TARGET);
    });

    it('rejects kicking yourself', async () => {
      await expect(service.kick(MOD, 'r', MOD.id, undefined)).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('rejects kicking a non-member', async () => {
      rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(service.kick(MOD, 'r', TARGET, undefined)).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('propagates the hierarchy guard (cannot kick the owner)', async () => {
      permissions.assertOutranks.mockRejectedValue(new Error('CANNOT_MODERATE_OWNER'));
      await expect(service.kick(MOD, 'r', TARGET, undefined)).rejects.toBeDefined();
    });
  });

  describe('unkick', () => {
    it('lifts the kick, clears the join gate, audits and broadcasts', async () => {
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1', roomId: 'r', userId: TARGET });
      await service.unkick(MOD, 'r', TARGET);
      expect(repo.liftKick).toHaveBeenCalledWith('kick-1', MOD.id);
      expect(repo.removeKickCache).toHaveBeenCalledWith('r', TARGET);
      expect(repo.appendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'UNKICK' }));
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_unkicked' }),
      );
    });

    it('rejects restoring a user who is not on the kick list', async () => {
      repo.findActiveKick.mockResolvedValue(null);
      await expect(service.unkick(MOD, 'r', TARGET)).rejects.toBeInstanceOf(BusinessException);
    });

    it('requires moderator authority', async () => {
      permissions.assertCanModerate.mockRejectedValue(new Error('NOT_ROOM_ADMIN'));
      await expect(service.unkick(MOD, 'r', TARGET)).rejects.toBeDefined();
    });

    it('does not require outranking the target (they hold no role once kicked)', async () => {
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1', roomId: 'r', userId: TARGET });
      await service.unkick(MOD, 'r', TARGET);
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
    });
  });

  describe('isKicked', () => {
    it('short-circuits on the Redis gate', async () => {
      repo.isKickedCached.mockResolvedValue(true);
      await expect(service.isKicked('r', TARGET)).resolves.toBe(true);
      expect(repo.findActiveKick).not.toHaveBeenCalled();
    });

    it('falls back to the database on a cache miss', async () => {
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1' });
      await expect(service.isKicked('r', TARGET)).resolves.toBe(true);
    });

    it('is false when neither the cache nor the database has a kick', async () => {
      await expect(service.isKicked('r', TARGET)).resolves.toBe(false);
    });
  });

  describe('listKicks', () => {
    it('requires moderator authority to read the kick list', async () => {
      permissions.assertCanModerate.mockRejectedValue(new Error('NOT_ROOM_ADMIN'));
      await expect(
        service.listKicks(MOD, 'r', { page: 1, limit: 20, skip: 0 }),
      ).rejects.toBeDefined();
    });

    it('hydrates each row with the target and moderator display data', async () => {
      repo.listActiveKicks.mockResolvedValue([
        [
          {
            id: 'kick-1',
            roomId: 'r',
            userId: TARGET,
            moderatorId: MOD.id,
            reason: 'spam',
            createdAt: new Date('2026-07-13T10:00:00Z'),
          },
        ],
        1,
      ]);
      repo.resolveUserSummaries.mockResolvedValue(
        new Map([
          [TARGET, { username: 'kicked_user', avatarKey: 'avatars/kicked.png' }],
          [MOD.id, { username: 'the_mod', avatarKey: null }],
        ]),
      );

      const page = await service.listKicks(MOD, 'r', { page: 1, limit: 20, skip: 0 });

      expect(repo.resolveUserSummaries).toHaveBeenCalledWith([TARGET, MOD.id]);
      expect(page.total).toBe(1);
      expect(page.items[0]).toEqual({
        id: 'kick-1',
        roomId: 'r',
        targetUserId: TARGET,
        targetUsername: 'kicked_user',
        targetAvatarKey: 'avatars/kicked.png',
        moderatorId: MOD.id,
        moderatorUsername: 'the_mod',
        reason: 'spam',
        createdAt: new Date('2026-07-13T10:00:00Z'),
      });
    });
  });

  describe('ban', () => {
    it('creates a temporary ban with a TTL and caches it', async () => {
      await service.ban(MOD, 'r', TARGET, {
        type: ModerationBanType.TEMPORARY,
        durationMinutes: 60,
      });
      expect(repo.createBan).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TEMPORARY', expiresAt: expect.any(Date) }),
      );
      expect(repo.addBanCache).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_banned' }),
      );
    });

    it('creates a permanent ban with no expiry', async () => {
      await service.ban(MOD, 'r', TARGET, { type: ModerationBanType.PERMANENT });
      expect(repo.createBan).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
    });

    it('rejects a temporary ban without a duration', async () => {
      await expect(
        service.ban(MOD, 'r', TARGET, { type: ModerationBanType.TEMPORARY }),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('rejects a duplicate active ban', async () => {
      repo.findActiveBan.mockResolvedValue({ id: 'existing' });
      await expect(
        service.ban(MOD, 'r', TARGET, { type: ModerationBanType.PERMANENT }),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('unban', () => {
    it('lifts an active ban and clears the cache', async () => {
      repo.findActiveBan.mockResolvedValue({ id: 'ban-1', roomId: 'r', userId: TARGET });
      await service.unban(MOD, 'r', TARGET);
      expect(repo.liftBan).toHaveBeenCalledWith('ban-1', MOD.id, 'LIFTED');
      expect(repo.removeBanCache).toHaveBeenCalledWith('r', TARGET);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_unbanned' }),
      );
    });

    it('throws when there is no active ban', async () => {
      await expect(service.unban(MOD, 'r', TARGET)).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('mute', () => {
    it('creates a permanent mute and forces the mic off', async () => {
      await service.mute(MOD, 'r', TARGET, { type: ModerationMuteType.PERMANENT });
      expect(repo.createMute).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
      expect(voice.forceMute).toHaveBeenCalledWith('r', TARGET, true);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_muted' }),
      );
    });

    it('rejects a duplicate active mute', async () => {
      repo.findActiveMute.mockResolvedValue({ id: 'existing' });
      await expect(
        service.mute(MOD, 'r', TARGET, { type: ModerationMuteType.PERMANENT }),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('report', () => {
    it('creates a report and notifies moderators', async () => {
      await service.report({ id: 'reporter-1', roles: ['USER'] }, 'r', {
        targetUserId: TARGET,
        reason: 'HARASSMENT',
      } as never);
      expect(repo.createReport).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_reported' }),
      );
      expect(queue.enqueue).toHaveBeenCalledWith(
        'notifications',
        'moderation.report',
        expect.anything(),
      );
    });

    it('rejects a duplicate open report', async () => {
      repo.findOpenReport.mockResolvedValue({ id: 'existing' });
      await expect(
        service.report({ id: 'reporter-1', roles: ['USER'] }, 'r', {
          targetUserId: TARGET,
          reason: 'SPAM',
        } as never),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('rejects reporting yourself', async () => {
      await expect(
        service.report(MOD, 'r', { targetUserId: MOD.id, reason: 'SPAM' } as never),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('appeals', () => {
    it('approving a ban appeal lifts the ban', async () => {
      repo.getAppeal.mockResolvedValue({
        id: 'appeal-1',
        roomId: 'r',
        userId: TARGET,
        banId: 'ban-1',
        muteId: null,
        status: 'PENDING',
      });
      repo.getBan.mockResolvedValue({ id: 'ban-1', roomId: 'r', userId: TARGET, status: 'ACTIVE' });
      await service.resolveAppeal(MOD, 'r', 'appeal-1', { approve: true });
      expect(repo.resolveAppeal).toHaveBeenCalledWith('appeal-1', MOD.id, true, null);
      expect(repo.liftBan).toHaveBeenCalledWith('ban-1', MOD.id, 'LIFTED');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.appeal_resolved' }),
      );
    });

    it('rejects an appeal for a ban/mute mismatch (both provided)', async () => {
      await expect(
        service.submitAppeal({ id: TARGET, roles: ['USER'] }, 'r', {
          banId: 'ban-1',
          muteId: 'mute-1',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  describe('expiry', () => {
    it('expires a ban and emits unbanned(expired)', async () => {
      await service.expireBan({
        id: 'ban-1',
        roomId: 'r',
        userId: TARGET,
        moderatorId: MOD.id,
      } as never);
      expect(repo.liftBan).toHaveBeenCalledWith('ban-1', MOD.id, 'EXPIRED');
      expect(repo.removeBanCache).toHaveBeenCalledWith('r', TARGET);
    });
  });
});
