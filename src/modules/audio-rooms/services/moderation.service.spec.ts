import { ForbiddenException } from '@nestjs/common';
import { ModerationBanType, ModerationMuteType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import { QueueService } from 'src/infra/queue/queue.service';
import type { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import type { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import type { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import type { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import type { ModerationApprovalService } from 'src/modules/moderation-approval/services/moderation-approval.service';
import type { INotificationService } from 'src/modules/notification/interfaces/notification.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ChatRepository } from '../repositories/chat.repository';
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
  let chatRepo: Record<string, jest.Mock>;
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
      assignReport: jest.fn().mockResolvedValue(undefined),
      updateReportNotes: jest.fn().mockResolvedValue(undefined),
      dismissReport: jest.fn().mockResolvedValue(undefined),
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
    seats = {
      listElevatedMemberIds: jest.fn().mockResolvedValue(['owner-1']),
      getSeatByOccupant: jest.fn().mockResolvedValue(null),
      setOccupant: jest.fn().mockResolvedValue(undefined),
      setSeatMuted: jest.fn().mockResolvedValue(undefined),
      invalidateStage: jest.fn().mockResolvedValue(undefined),
      appendSeatHistory: jest.fn().mockResolvedValue(undefined),
      onMemberLeave: jest.fn().mockResolvedValue(undefined),
    };
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
    chatRepo = {
      createMessage: jest.fn().mockResolvedValue({
        id: 'msg-1',
        roomId: 'room-1',
        senderId: '00000000-0000-0000-0000-000000000000',
        type: 'SYSTEM',
        content: 'be nice',
        gifUrl: null,
        mentions: [],
        replyToId: null,
        createdAt: new Date(),
      }),
    };

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
      {
        assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
      } as unknown as WorkforceScopeService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      chatRepo as unknown as ChatRepository,
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

  describe('warn — scope', () => {
    it('defaults to PRIVATE and does not touch chat (existing behavior preserved)', async () => {
      await service.warn(MOD, 'room-1', TARGET, 'be nice');
      expect(chatRepo.createMessage).not.toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: expect.any(String) }),
      );
    });

    it('scope=ROOM persists a SYSTEM chat message attributed to SYSTEM_MODERATOR_ID', async () => {
      await service.warn(MOD, 'room-1', TARGET, 'be nice', 'ROOM');
      expect(chatRepo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'room-1',
          senderId: '00000000-0000-0000-0000-000000000000',
          type: 'SYSTEM',
          content: 'be nice',
        }),
      );
    });

    it('scope=ROOM still sends the existing private notification too', async () => {
      const notifySpy = jest.spyOn(service as never, 'notifyUser');
      await service.warn(MOD, 'room-1', TARGET, 'be nice', 'ROOM');
      expect(notifySpy).toHaveBeenCalled();
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
  });

  describe('reviewReport — recommendedAction', () => {
    beforeEach(() => {
      repo.getReport.mockResolvedValue({
        id: 'report-1',
        roomId: 'r',
        status: 'PENDING',
        targetUserId: TARGET,
      });
    });

    it('executes the recommended action immediately, tagged as a report-review decision', async () => {
      await service.reviewReport(MOD, 'r', 'report-1', {
        status: 'ACTIONED',
        recommendedAction: 'KICK',
        resolution: 'confirmed harassment',
      } as never);

      expect(repo.createKick).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: '[Report #report-1 review] confirmed harassment',
        }),
      );
    });

    it('does nothing beyond recording the review when no action is recommended', async () => {
      await service.reviewReport(MOD, 'r', 'report-1', { status: 'DISMISSED' } as never);

      expect(repo.createKick).not.toHaveBeenCalled();
      expect(repo.createMute).not.toHaveBeenCalled();
      expect(repo.createBan).not.toHaveBeenCalled();
    });

    describe('BAN recommendation goes through approval', () => {
      let approvalService: { propose: jest.Mock };
      let approvingService: ModerationService;

      beforeEach(() => {
        approvalService = { propose: jest.fn().mockResolvedValue({ id: 'approval-1' }) };
        rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
        approvingService = new ModerationService(
          repo as unknown as ModerationRepository,
          permissions as unknown as RoomPermissionService,
          rooms as unknown as AudioRoomsRepository,
          seats as unknown as AudioRoomSeatsRepository,
          presence as unknown as PresenceService,
          voice as unknown as VoiceService,
          locks as unknown as LockService,
          queue as unknown as QueueService,
          bus,
          {
            assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
          } as unknown as WorkforceScopeService,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          approvalService as unknown as ModerationApprovalService,
        );
      });

      it('proposes the ban for approval instead of executing it', async () => {
        await approvingService.reviewReport(MOD, 'r', 'report-1', {
          status: 'ACTIONED',
          recommendedAction: 'BAN',
          resolution: 'confirmed harassment',
        } as never);

        expect(approvalService.propose).toHaveBeenCalledWith(
          expect.objectContaining({
            roomType: 'AUDIO_ROOM',
            roomId: 'r',
            reportId: 'report-1',
            proposedBy: MOD.id,
            targetUserId: TARGET,
            ownerId: 'owner-eu-west',
          }),
        );
        expect(repo.createBan).not.toHaveBeenCalled();
      });

      it('leaves the recommendation unactioned when no approval service is wired', async () => {
        await service.reviewReport(MOD, 'r', 'report-1', {
          status: 'ACTIONED',
          recommendedAction: 'BAN',
        } as never);
        expect(repo.createBan).not.toHaveBeenCalled();
      });
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

    describe('false-moderation tracking (upheld appeal)', () => {
      let performanceStats: { recordFalseModeration: jest.Mock; recordAction: jest.Mock };
      let trackedService: ModerationService;

      beforeEach(() => {
        performanceStats = {
          recordFalseModeration: jest.fn().mockResolvedValue(undefined),
          recordAction: jest.fn().mockResolvedValue(undefined),
        };
        trackedService = new ModerationService(
          repo as unknown as ModerationRepository,
          permissions as unknown as RoomPermissionService,
          rooms as unknown as AudioRoomsRepository,
          seats as unknown as AudioRoomSeatsRepository,
          presence as unknown as PresenceService,
          voice as unknown as VoiceService,
          locks as unknown as LockService,
          queue as unknown as QueueService,
          bus,
          {
            assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
          } as unknown as WorkforceScopeService,
          undefined,
          performanceStats as unknown as ModeratorPerformanceService,
        );
      });

      it('credits the ORIGINAL banning moderator, not the appeal resolver', async () => {
        repo.getAppeal.mockResolvedValue({
          id: 'appeal-1',
          roomId: 'r',
          userId: TARGET,
          banId: 'ban-1',
          muteId: null,
          status: 'PENDING',
        });
        repo.getBan.mockResolvedValue({
          id: 'ban-1',
          roomId: 'r',
          userId: TARGET,
          status: 'ACTIVE',
          moderatorId: 'original-mod',
        });

        await trackedService.resolveAppeal(MOD, 'r', 'appeal-1', { approve: true });

        expect(performanceStats.recordFalseModeration).toHaveBeenCalledWith('original-mod');
        expect(performanceStats.recordFalseModeration).not.toHaveBeenCalledWith(MOD.id);
      });

      it('credits the original muting moderator on an upheld mute appeal', async () => {
        repo.getAppeal.mockResolvedValue({
          id: 'appeal-2',
          roomId: 'r',
          userId: TARGET,
          banId: null,
          muteId: 'mute-1',
          status: 'PENDING',
        });
        repo.getMute.mockResolvedValue({
          id: 'mute-1',
          roomId: 'r',
          userId: TARGET,
          status: 'ACTIVE',
          moderatorId: 'original-mod-2',
        });

        await trackedService.resolveAppeal(MOD, 'r', 'appeal-2', { approve: true });

        expect(performanceStats.recordFalseModeration).toHaveBeenCalledWith('original-mod-2');
      });

      it('does not record false moderation on a rejected appeal', async () => {
        repo.getAppeal.mockResolvedValue({
          id: 'appeal-3',
          roomId: 'r',
          userId: TARGET,
          banId: 'ban-1',
          muteId: null,
          status: 'PENDING',
        });
        repo.getBan.mockResolvedValue({
          id: 'ban-1',
          roomId: 'r',
          userId: TARGET,
          status: 'ACTIVE',
          moderatorId: 'original-mod',
        });

        await trackedService.resolveAppeal(MOD, 'r', 'appeal-3', { approve: false });

        expect(performanceStats.recordFalseModeration).not.toHaveBeenCalled();
      });

      it('still credits the original moderator even if the ban already expired/was lifted', async () => {
        repo.getAppeal.mockResolvedValue({
          id: 'appeal-4',
          roomId: 'r',
          userId: TARGET,
          banId: 'ban-1',
          muteId: null,
          status: 'PENDING',
        });
        repo.getBan.mockResolvedValue({
          id: 'ban-1',
          roomId: 'r',
          userId: TARGET,
          status: 'EXPIRED',
          moderatorId: 'original-mod',
        });

        await trackedService.resolveAppeal(MOD, 'r', 'appeal-4', { approve: true });

        expect(repo.liftBan).not.toHaveBeenCalled();
        expect(performanceStats.recordFalseModeration).toHaveBeenCalledWith('original-mod');
      });
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

  describe('owner scope enforcement', () => {
    let scopeService: { assertModeratorInScope: jest.Mock };
    let scopedService: ModerationService;

    beforeEach(() => {
      scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
      scopedService = new ModerationService(
        repo as unknown as ModerationRepository,
        permissions as unknown as RoomPermissionService,
        rooms as unknown as AudioRoomsRepository,
        seats as unknown as AudioRoomSeatsRepository,
        presence as unknown as PresenceService,
        voice as unknown as VoiceService,
        locks as unknown as LockService,
        queue as unknown as QueueService,
        bus,
        scopeService as unknown as WorkforceScopeService,
      );
    });

    it("passes the room's real owner to the scope check instead of a hardcoded null", async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      await scopedService.kick(MOD, 'r', TARGET, 'spam');
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it("rejects a moderator acting outside the room owner's assigned scope", async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      scopeService.assertModeratorInScope.mockRejectedValue(
        new ForbiddenException('You are not authorized to perform moderation for this user.'),
      );
      await expect(scopedService.kick(MOD, 'r', TARGET, 'spam')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repo.createKick).not.toHaveBeenCalled();
    });

    // A room that EXISTS but carries no owner is the documented safety
    // valve: the assertion is still invoked (with null), and
    // `assertModeratorInScope` permits on a null target owner. That is
    // deliberately different from a room that does not exist at all, which
    // now 404s — see "missing room 404s before the action runs".
    it('permits the action when the room exists but has no owner set', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: null });
      await scopedService.kick(MOD, 'r', TARGET, 'spam');
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, null);
      expect(repo.createKick).toHaveBeenCalled();
    });

    it('unkick checks the room owner before lifting the kick', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1' });
      await scopedService.unkick(MOD, 'r', TARGET);
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('unkick rejects a moderator outside the room owner scope', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1' });
      scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(scopedService.unkick(MOD, 'r', TARGET)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repo.liftKick).not.toHaveBeenCalled();
    });

    it('unban checks the room owner before lifting the ban', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.findActiveBan.mockResolvedValue({ id: 'ban-1', status: 'ACTIVE' });
      await scopedService.unban(MOD, 'r', TARGET);
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('unmute checks the room owner before lifting the mute', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.findActiveMute.mockResolvedValue({ id: 'mute-1', status: 'ACTIVE' });
      await scopedService.unmute(MOD, 'r', TARGET);
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });
  });

  describe('report/appeal lifecycle owner scope enforcement', () => {
    let scopeService: { assertModeratorInScope: jest.Mock };
    let scopedService: ModerationService;

    beforeEach(() => {
      scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
      scopedService = new ModerationService(
        repo as unknown as ModerationRepository,
        permissions as unknown as RoomPermissionService,
        rooms as unknown as AudioRoomsRepository,
        seats as unknown as AudioRoomSeatsRepository,
        presence as unknown as PresenceService,
        voice as unknown as VoiceService,
        locks as unknown as LockService,
        queue as unknown as QueueService,
        bus,
        scopeService as unknown as WorkforceScopeService,
      );
    });

    it('assignReport checks the room owner', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r', status: 'PENDING' });
      await scopedService.assignReport(MOD, 'r', 'rep-1', 'assignee-1');
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('addReportNotes checks the room owner', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r' });
      await scopedService.addReportNotes(MOD, 'r', 'rep-1', 'notes');
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
      expect(repo.updateReportNotes).toHaveBeenCalledWith('rep-1', MOD.id, 'notes');
    });

    it('dismissReport checks the room owner', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'r', createdAt: new Date() });
      await scopedService.dismissReport(MOD, 'r', 'rep-1', 'reason');
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('resolveAppeal checks the room owner', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.getAppeal.mockResolvedValue({
        id: 'appeal-1',
        roomId: 'r',
        status: 'PENDING',
        userId: TARGET,
      });
      await scopedService.resolveAppeal(MOD, 'r', 'appeal-1', { approve: false });
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('reviewReport checks the room owner even for a bare dismiss (no recommendedAction)', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      repo.getReport.mockResolvedValue({
        id: 'rep-1',
        roomId: 'r',
        status: 'PENDING',
        targetUserId: TARGET,
        createdAt: new Date(),
      });
      await scopedService.reviewReport(MOD, 'r', 'rep-1', { status: 'REVIEWED' } as never);
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(MOD.id, 'owner-eu-west');
    });

    it('reviewReport rejects a moderator outside scope before touching the report', async () => {
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(
        scopedService.reviewReport(MOD, 'r', 'rep-1', { status: 'REVIEWED' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.reviewReport).not.toHaveBeenCalled();
    });

    // The scope check authorizes the roomId in the URL. Without binding the
    // reportId to that same room, a moderator scoped to room "r" could pass
    // an out-of-scope room's reportId alongside "r" and mutate it unchecked.
    describe('reportId is bound to the roomId that was scope-checked', () => {
      beforeEach(() => {
        rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      });

      it('addReportNotes 404s when the report belongs to a different room', async () => {
        repo.getReport.mockResolvedValue({ id: 'rep-1', roomId: 'other-room' });
        await expect(
          scopedService.addReportNotes(MOD, 'r', 'rep-1', 'notes'),
        ).rejects.toBeInstanceOf(BusinessException);
        expect(repo.updateReportNotes).not.toHaveBeenCalled();
      });

      it('addReportNotes 404s when the report does not exist', async () => {
        repo.getReport.mockResolvedValue(null);
        await expect(
          scopedService.addReportNotes(MOD, 'r', 'missing', 'notes'),
        ).rejects.toBeInstanceOf(BusinessException);
        expect(repo.updateReportNotes).not.toHaveBeenCalled();
      });

      it('dismissReport 404s when the report belongs to a different room', async () => {
        repo.getReport.mockResolvedValue({
          id: 'rep-1',
          roomId: 'other-room',
          createdAt: new Date(),
        });
        await expect(
          scopedService.dismissReport(MOD, 'r', 'rep-1', 'reason'),
        ).rejects.toBeInstanceOf(BusinessException);
        expect(repo.dismissReport).not.toHaveBeenCalled();
      });

      it('dismissReport 404s when the report does not exist', async () => {
        repo.getReport.mockResolvedValue(null);
        await expect(
          scopedService.dismissReport(MOD, 'r', 'missing', 'reason'),
        ).rejects.toBeInstanceOf(BusinessException);
        expect(repo.dismissReport).not.toHaveBeenCalled();
      });
    });
  });

  // A `null` room used to make `if (room?.ownerId)` simply not fire, so the
  // owner-scope check was skipped entirely and the action proceeded against
  // a room that does not exist. Video Rooms (`requireRoom`) and Live
  // Streaming (`getStream`) always 404 first; audio rooms now match.
  describe('missing room 404s before the action runs', () => {
    beforeEach(() => {
      rooms.findRoomRow.mockResolvedValue(null);
    });

    it('kick 404s instead of proceeding unscoped', async () => {
      await expect(service.kick(MOD, 'missing-room', TARGET, 'spam')).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(repo.createKick).not.toHaveBeenCalled();
    });

    it('unkick 404s instead of proceeding unscoped', async () => {
      repo.findActiveKick.mockResolvedValue({ id: 'kick-1', roomId: 'r', userId: TARGET });
      await expect(service.unkick(MOD, 'missing-room', TARGET)).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(repo.liftKick).not.toHaveBeenCalled();
    });

    it('dismissReport 404s instead of proceeding unscoped', async () => {
      repo.getReport.mockResolvedValue({
        id: 'rep-1',
        roomId: 'missing-room',
        createdAt: new Date(),
      });
      await expect(
        service.dismissReport(MOD, 'missing-room', 'rep-1', 'reason'),
      ).rejects.toBeInstanceOf(BusinessException);
      expect(repo.dismissReport).not.toHaveBeenCalled();
    });

    it('resolveAppeal 404s instead of proceeding unscoped', async () => {
      repo.getAppeal.mockResolvedValue({
        id: 'appeal-1',
        roomId: 'missing-room',
        status: 'PENDING',
        userId: TARGET,
      });
      await expect(
        service.resolveAppeal(MOD, 'missing-room', 'appeal-1', { approve: true }),
      ).rejects.toBeInstanceOf(BusinessException);
      expect(repo.resolveAppeal).not.toHaveBeenCalled();
    });
  });

  describe('escalateViolation', () => {
    let scopeService: { assertModeratorInScope: jest.Mock; resolveEscalationRecipients: jest.Mock };
    let notifications: { create: jest.Mock };
    let escalatingService: ModerationService;

    beforeEach(() => {
      scopeService = {
        assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
        resolveEscalationRecipients: jest.fn().mockResolvedValue(['official-1']),
      };
      notifications = { create: jest.fn().mockResolvedValue({}) };
      rooms.findRoomRow.mockResolvedValue({ id: 'r', ownerId: 'owner-eu-west' });
      escalatingService = new ModerationService(
        repo as unknown as ModerationRepository,
        permissions as unknown as RoomPermissionService,
        rooms as unknown as AudioRoomsRepository,
        seats as unknown as AudioRoomSeatsRepository,
        presence as unknown as PresenceService,
        voice as unknown as VoiceService,
        locks as unknown as LockService,
        queue as unknown as QueueService,
        bus,
        scopeService as unknown as WorkforceScopeService,
        undefined,
        undefined,
        undefined,
        notifications as unknown as INotificationService,
      );
    });

    it('routes a HIGH escalation through resolveEscalationRecipients and notifies each recipient', async () => {
      await escalatingService.escalateViolation(MOD, 'r', TARGET, 'repeated harassment', 'HIGH');

      expect(scopeService.resolveEscalationRecipients).toHaveBeenCalledWith(
        'HIGH',
        'owner-eu-west',
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'official-1',
          type: 'MODERATION_CASE_ESCALATED',
          actorId: MOD.id,
          entityType: 'audio_room',
          entityId: 'r',
        }),
      );
    });

    it('notifies every resolved recipient, not just the first', async () => {
      scopeService.resolveEscalationRecipients.mockResolvedValue(['official-1', 'official-2']);
      await escalatingService.escalateViolation(MOD, 'r', TARGET, 'reason', 'CRITICAL');
      expect(notifications.create).toHaveBeenCalledTimes(2);
    });

    it('does not attempt notification dispatch when notifications is not wired', async () => {
      const bareService = new ModerationService(
        repo as unknown as ModerationRepository,
        permissions as unknown as RoomPermissionService,
        rooms as unknown as AudioRoomsRepository,
        seats as unknown as AudioRoomSeatsRepository,
        presence as unknown as PresenceService,
        voice as unknown as VoiceService,
        locks as unknown as LockService,
        queue as unknown as QueueService,
        bus,
        {
          assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
        } as unknown as WorkforceScopeService,
      );
      await expect(
        bareService.escalateViolation(MOD, 'r', TARGET, 'reason', 'EMERGENCY'),
      ).resolves.toBeUndefined();
    });
  });

  describe('request metadata + evidence in audit logging', () => {
    let investigationRecording: {
      beginRecording: jest.Mock;
      completeRecording: jest.Mock;
      findActiveRecording: jest.Mock;
    };
    let auditLog: { logAction: jest.Mock };
    let auditedService: ModerationService;
    const REQUEST_META = { ip: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome/1.0', timestamp: 'now' };

    beforeEach(() => {
      investigationRecording = {
        beginRecording: jest.fn().mockResolvedValue({ id: 'rec-1', evidenceId: 'EVD-TEST0001' }),
        completeRecording: jest.fn().mockResolvedValue(undefined),
        findActiveRecording: jest.fn().mockResolvedValue(null),
      };
      auditLog = { logAction: jest.fn().mockResolvedValue(undefined) };
      auditedService = new ModerationService(
        repo as unknown as ModerationRepository,
        permissions as unknown as RoomPermissionService,
        rooms as unknown as AudioRoomsRepository,
        seats as unknown as AudioRoomSeatsRepository,
        presence as unknown as PresenceService,
        voice as unknown as VoiceService,
        locks as unknown as LockService,
        queue as unknown as QueueService,
        bus,
        {
          assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
        } as unknown as WorkforceScopeService,
        investigationRecording as unknown as InvestigationRecordingService,
        undefined,
        auditLog as unknown as AuditLogService,
      );
    });

    it('kick: forwards ip/user-agent from requestMeta and the evidenceId from investigation recording', async () => {
      await auditedService.kick(MOD, 'r', TARGET, 'spam', REQUEST_META);

      expect(investigationRecording.beginRecording).toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0 Chrome/1.0',
          targetUserId: TARGET,
          violationReason: 'spam',
          evidenceId: 'EVD-TEST0001',
        }),
      );
    });

    it('mute: forwards ip/user-agent from requestMeta and the evidenceId from investigation recording', async () => {
      await auditedService.mute(
        MOD,
        'r',
        TARGET,
        { type: ModerationMuteType.PERMANENT, reason: 'harassment' },
        REQUEST_META,
      );

      expect(investigationRecording.beginRecording).toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0 Chrome/1.0',
          targetUserId: TARGET,
          violationReason: 'harassment',
          evidenceId: 'EVD-TEST0001',
        }),
      );
    });

    it('kick: completes an already-open (join-triggered) recording instead of opening a new one', async () => {
      investigationRecording.findActiveRecording.mockResolvedValue({
        id: 'rec-open-at-join',
        evidenceId: 'EVD-JOIN0001',
      });
      await auditedService.kick(MOD, 'r', TARGET, 'spam', REQUEST_META);

      expect(investigationRecording.findActiveRecording).toHaveBeenCalledWith(MOD.id, TARGET, {
        roomId: 'r',
      });
      expect(investigationRecording.beginRecording).not.toHaveBeenCalled();
      expect(investigationRecording.completeRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          recordingId: 'rec-open-at-join',
          actionTaken: 'KICK',
          violationReason: 'spam',
        }),
      );
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ evidenceId: 'EVD-JOIN0001' }),
      );
    });

    it('escalateViolation: forwards ip/user-agent + targetUserId but no evidenceId (no investigation recording hook)', async () => {
      await auditedService.escalateViolation(
        MOD,
        'r',
        TARGET,
        'repeated abuse',
        'CRITICAL',
        REQUEST_META,
      );

      expect(investigationRecording.beginRecording).not.toHaveBeenCalled();
      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0 Chrome/1.0',
          targetUserId: TARGET,
          violationReason: 'repeated abuse',
        }),
      );
      expect(auditLog.logAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ evidenceId: expect.anything() }),
      );
    });
  });

  /**
   * The asymmetry this guards: `mute` runs through `assertModerationPrereqs`,
   * which rank-checks the actor against the target. `unmute` and `unban` did
   * not, so an Admin could lift a restriction they had no authority to apply —
   * including one the Owner imposed on another Admin.
   */
  describe('lifting a restriction is rank-checked like applying one', () => {
    it('rejects an unmute when the actor does not outrank the target', async () => {
      permissions.assertOutranks.mockRejectedValue(new Error('INSUFFICIENT_AUTHORITY'));

      await expect(service.unmute(MOD, 'r', 'admin-a')).rejects.toThrow('INSUFFICIENT_AUTHORITY');
      expect(permissions.assertOutranks).toHaveBeenCalledWith('r', MOD, 'admin-a');
    });

    it('rejects an unban when the actor does not outrank the target', async () => {
      permissions.assertOutranks.mockRejectedValue(new Error('INSUFFICIENT_AUTHORITY'));

      await expect(service.unban(MOD, 'r', 'admin-a')).rejects.toThrow('INSUFFICIENT_AUTHORITY');
      expect(permissions.assertOutranks).toHaveBeenCalledWith('r', MOD, 'admin-a');
    });

    it('checks authority before looking the mute up, so a lift never half-runs', async () => {
      permissions.assertOutranks.mockRejectedValue(new Error('INSUFFICIENT_AUTHORITY'));

      await expect(service.unmute(MOD, 'r', 'admin-a')).rejects.toThrow('INSUFFICIENT_AUTHORITY');
      expect(repo.findActiveMute).not.toHaveBeenCalled();
    });
  });
});
