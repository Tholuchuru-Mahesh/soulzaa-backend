import { HttpStatus } from '@nestjs/common';
import {
  PlatformRole,
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomReportReason,
} from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import { SYSTEM_MODERATOR_ID } from '../constants/video-room-moderation.constants';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_MODERATION_EVENTS } from '../events/video-room-moderation.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationService } from './video-room-moderation.service';

const ROOM = { id: 'room-1', ownerId: 'owner-1' };
const OWNER: RoomActor = { id: 'owner-1', roles: [] as PlatformRole[] };
const ACTOR: RoomActor = { id: 'admin-1', roles: [] as PlatformRole[] };
const TARGET = 'user-2';

/**
 * A full `VideoRoomSettings` row so `updateSettings`'s mock can spread a
 * write patch over it and hand `toSettingsView` something it can safely
 * project (task 4: the settings_updated broadcast projects the full view,
 * not just the patched keys).
 */
const settingsRow = {
  roomId: ROOM.id,
  allowChat: true,
  allowViewerChat: true,
  chatMode: VideoRoomChatMode.NORMAL,
  chatMaxMessageLength: 500,
  chatMaxAttachments: 1,
  chatRateLimitPerMinute: 20,
  slowModeSeconds: 0,
  allowGifts: true,
  allowTreasure: true,
  allowPk: true,
  allowBeauty: true,
  allowCameraSwitch: true,
  allowScreenShare: false,
  allowRecording: false,
  joinApprovalRequired: false,
  allowJoinRequest: true,
  allowShare: true,
  allowInvite: true,
  allowFollow: true,
  allowReporting: true,
  allowAnnouncements: true,
  isRoomMuted: false,
  maxDurationMinutes: null as number | null,
  hostSeatCount: 9,
  guestSeatCount: 0,
  seatApprovalRequired: true,
  metadata: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('VideoRoomModerationService', () => {
  let rooms: any;
  let moderationRepo: any;
  let permissions: any;
  let session: any;
  let sockets: any;
  let locks: any;
  let metrics: any;
  let queue: any;
  let bus: any;
  let media: any;
  let warningRepo: any;
  let reportService: any;
  let config: any;
  let subject: VideoRoomModerationService;
  let callOrder: string[];
  let published: { name: string; payload: any }[];

  beforeEach(() => {
    callOrder = [];
    published = [];
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ userId: TARGET, isActive: true }),
      deactivateMember: jest.fn().mockImplementation(async () => {
        callOrder.push('deactivateMember');
      }),
      updateSettings: jest.fn().mockImplementation(async (_roomId: string, data: any) => ({
        ...settingsRow,
        ...data,
      })),
    };
    moderationRepo = {
      appendAction: jest.fn().mockImplementation(async () => {
        callOrder.push('appendAction');
      }),
      createBlock: jest.fn().mockImplementation(({ roomId, userId, moderatorId, reason }) =>
        Promise.resolve({
          id: 'block-1',
          roomId,
          userId,
          moderatorId,
          reason: reason ?? null,
          status: 'ACTIVE',
        }),
      ),
      findActiveBlock: jest.fn().mockResolvedValue(null),
      liftBlock: jest.fn().mockResolvedValue(undefined),
      addBlockMirror: jest.fn().mockResolvedValue(undefined),
      removeBlockMirror: jest.fn().mockResolvedValue(undefined),
      findActiveMute: jest.fn().mockResolvedValue(null),
      createMute: jest.fn().mockImplementation(({ roomId, userId, moderatorId, type, reason }) =>
        Promise.resolve({
          id: 'mute-1',
          roomId,
          userId,
          moderatorId,
          type,
          reason: reason ?? null,
          status: 'ACTIVE',
        }),
      ),
      liftMute: jest.fn().mockResolvedValue(undefined),
      addMuteMirror: jest.fn().mockResolvedValue(undefined),
      removeMuteMirror: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      assertOutranks: jest.fn().mockResolvedValue(undefined),
      resolveEffectiveRole: jest.fn().mockResolvedValue(null),
    };
    session = {
      endUserRoomSessions: jest.fn().mockImplementation(async () => {
        callOrder.push('endUserRoomSessions');
        return [];
      }),
    };
    sockets = {
      disconnectUserInNamespace: jest.fn().mockImplementation(() => {
        callOrder.push('disconnectUserInNamespace');
      }),
    };
    locks = { withLock: jest.fn((_k: string, fn: () => unknown) => fn()) };
    metrics = {
      incKick: jest.fn(),
      incBlacklist: jest.fn(),
      incMute: jest.fn(),
      incWarning: jest.fn(),
      incAutoAction: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    bus = {
      publish: jest.fn().mockImplementation(async (event: { name: string; payload: unknown }) => {
        callOrder.push(`publish:${event.name}`);
        published.push({ name: event.name, payload: event.payload });
      }),
    };
    media = {
      forceMute: jest.fn().mockImplementation(async () => {
        callOrder.push('forceMute');
      }),
      getMediaState: jest.fn().mockResolvedValue({ participants: [] }),
    };
    warningRepo = {
      create: jest.fn().mockImplementation(async () => {
        callOrder.push('warningRepo.create');
        return { id: 'warning-1' };
      }),
    };
    reportService = {
      createSystemReport: jest.fn().mockImplementation(async () => {
        callOrder.push('createSystemReport');
        return { id: 'report-1', reporterId: SYSTEM_MODERATOR_ID };
      }),
    };
    config = {
      get: jest.fn().mockReturnValue({ moderation: { autoMuteMinutes: 15 } }),
    };
    subject = new VideoRoomModerationService(
      rooms,
      moderationRepo,
      permissions,
      session,
      sockets,
      locks,
      metrics,
      queue,
      bus,
      media,
      warningRepo,
      reportService,
      config,
    );
  });

  // ======================= kick =======================

  describe('kick', () => {
    it('rejects moderating yourself', async () => {
      await expect(subject.kick(ACTOR, ROOM.id, ACTOR.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(permissions.assertPermission).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(subject.kick(ACTOR, ROOM.id, TARGET)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('propagates a permission denial', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(subject.kick(ACTOR, ROOM.id, TARGET)).rejects.toThrow('forbidden');
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
    });

    it('protects the room owner from being kicked', async () => {
      await expect(subject.kick(ACTOR, ROOM.id, OWNER.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
        status: HttpStatus.FORBIDDEN,
      });
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
    });

    it('lets a platform admin bypass owner protection', async () => {
      const staff: RoomActor = { id: 'staff-1', roles: [PlatformRole.ADMIN] };
      await subject.kick(staff, ROOM.id, OWNER.id);
      expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM.id, OWNER.id, staff.id);
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
    });

    it('propagates an outranks failure', async () => {
      permissions.assertOutranks.mockRejectedValue(new Error('cannot act on equal/higher rank'));
      await expect(subject.kick(ACTOR, ROOM.id, TARGET)).rejects.toThrow(
        'cannot act on equal/higher rank',
      );
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
    });

    it('rejects a target who is not an active member', async () => {
      rooms.getMember.mockResolvedValue({ userId: TARGET, isActive: false });
      await expect(subject.kick(ACTOR, ROOM.id, TARGET)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
    });

    it('deactivates, hard-disconnects, audits and publishes on success', async () => {
      await subject.kick(ACTOR, ROOM.id, TARGET, 'spamming');

      expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM.id, TARGET, ACTOR.id);
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(VIDEO_ROOM_NAMESPACE, TARGET);
      expect(session.endUserRoomSessions).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.KICK,
          reason: 'spamming',
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.KICKED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: ACTOR.id,
            targetUserId: TARGET,
            reason: 'spamming',
          }),
        }),
      );
      expect(metrics.incKick).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();

      // the eject must land before the audit row, and the audit before the publish
      expect(callOrder.indexOf('deactivateMember')).toBeLessThan(callOrder.indexOf('appendAction'));
      expect(callOrder.indexOf('disconnectUserInNamespace')).toBeLessThan(
        callOrder.indexOf('appendAction'),
      );
      expect(callOrder.indexOf('endUserRoomSessions')).toBeLessThan(
        callOrder.indexOf('appendAction'),
      );
      expect(callOrder.indexOf('appendAction')).toBeLessThan(
        callOrder.indexOf(`publish:${VIDEO_ROOM_MODERATION_EVENTS.KICKED}`),
      );
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.kick(ACTOR, ROOM.id, TARGET);
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= kickMany =======================

  describe('kickMany', () => {
    it('kicks every target and reports none skipped', async () => {
      const result = await subject.kickMany(ACTOR, ROOM.id, ['user-2', 'user-3'], 'raid');
      expect(result.kicked.sort()).toEqual(['user-2', 'user-3']);
      expect(result.skipped).toEqual([]);
      expect(rooms.deactivateMember).toHaveBeenCalledTimes(2);
    });

    it('returns a partial result when one target cannot be kicked', async () => {
      permissions.assertOutranks.mockImplementation(
        (_ref: unknown, _actorId: string, id: string) =>
          id === 'user-3'
            ? Promise.reject(new Error('cannot act on equal/higher rank'))
            : Promise.resolve(),
      );

      const result = await subject.kickMany(ACTOR, ROOM.id, ['user-2', 'user-3']);
      expect(result.kicked).toEqual(['user-2']);
      expect(result.skipped).toEqual([
        { userId: 'user-3', reason: 'cannot act on equal/higher rank' },
      ]);
    });
  });

  // ======================= blacklist =======================

  describe('blacklist', () => {
    it('runs the same prereq chain as kick (self-target rejected)', async () => {
      await expect(subject.blacklist(ACTOR, ROOM.id, ACTOR.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
      });
    });

    it('protects the room owner from being blacklisted', async () => {
      await expect(subject.blacklist(ACTOR, ROOM.id, OWNER.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
      });
    });

    it('rejects a duplicate active blacklist entry', async () => {
      moderationRepo.findActiveBlock.mockResolvedValue({ id: 'block-existing', status: 'ACTIVE' });
      await expect(subject.blacklist(ACTOR, ROOM.id, TARGET, 'abuse')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ALREADY_BLOCKED,
        status: HttpStatus.CONFLICT,
      });
      expect(moderationRepo.createBlock).not.toHaveBeenCalled();
    });

    it('creates the block, mirrors it, and does not eject an absent/inactive member', async () => {
      rooms.getMember.mockResolvedValue(null);
      await subject.blacklist(ACTOR, ROOM.id, TARGET, 'abuse');

      expect(moderationRepo.createBlock).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          userId: TARGET,
          moderatorId: ACTOR.id,
          reason: 'abuse',
        }),
      );
      expect(moderationRepo.addBlockMirror).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(sockets.disconnectUserInNamespace).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.BLOCK,
          reason: 'abuse',
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: VIDEO_ROOM_MODERATION_EVENTS.BLACKLISTED }),
      );
      expect(metrics.incBlacklist).toHaveBeenCalled();
    });

    it('also ejects the user when they are currently an active member', async () => {
      rooms.getMember.mockResolvedValue({ userId: TARGET, isActive: true });
      await subject.blacklist(ACTOR, ROOM.id, TARGET, 'abuse');

      expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM.id, TARGET, ACTOR.id);
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(VIDEO_ROOM_NAMESPACE, TARGET);
      expect(session.endUserRoomSessions).toHaveBeenCalledWith(ROOM.id, TARGET);
    });
  });

  // ======================= unblacklist =======================

  describe('unblacklist', () => {
    it('404s when there is no active block to lift', async () => {
      moderationRepo.findActiveBlock.mockResolvedValue(null);
      await expect(subject.unblacklist(ACTOR, ROOM.id, TARGET)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_BLOCK_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('lifts the block, removes the mirror, audits and publishes', async () => {
      moderationRepo.findActiveBlock.mockResolvedValue({ id: 'block-1', status: 'ACTIVE' });
      await subject.unblacklist(ACTOR, ROOM.id, TARGET);

      expect(moderationRepo.liftBlock).toHaveBeenCalledWith('block-1', ACTOR.id);
      expect(moderationRepo.removeBlockMirror).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.UNBLOCK,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.UNBLACKLISTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: ACTOR.id,
            targetUserId: TARGET,
          }),
        }),
      );
    });
  });

  // ======================= mute =======================

  describe('mute', () => {
    const baseDto = { userId: TARGET, type: VideoRoomModerationMuteType.PERMANENT } as const;

    it('rejects moderating yourself', async () => {
      await expect(
        subject.mute(ACTOR, ROOM.id, { ...baseDto, userId: ACTOR.id }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF });
      expect(permissions.assertPermission).not.toHaveBeenCalled();
    });

    it('protects the room owner from being muted', async () => {
      await expect(
        subject.mute(ACTOR, ROOM.id, { ...baseDto, userId: OWNER.id }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER });
    });

    it('mutes chat only when channels is ["chat"]: dup-guards, creates the mute, mirrors, audits, publishes — no media call', async () => {
      await subject.mute(ACTOR, ROOM.id, { ...baseDto, channels: ['chat'], reason: 'spam' });

      expect(moderationRepo.findActiveMute).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(moderationRepo.createMute).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          userId: TARGET,
          moderatorId: ACTOR.id,
          type: VideoRoomModerationMuteType.PERMANENT,
          reason: 'spam',
          expiresAt: null,
        }),
      );
      expect(moderationRepo.addMuteMirror).toHaveBeenCalledWith(ROOM.id, TARGET, null);
      expect(media.forceMute).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.MUTE_PERMANENT,
          reason: 'spam',
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.MUTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            targetUserId: TARGET,
            channels: ['chat'],
          }),
        }),
      );
      expect(metrics.incMute).toHaveBeenCalledWith('chat');
    });

    it('rejects a duplicate active chat mute', async () => {
      moderationRepo.findActiveMute.mockResolvedValue({ id: 'mute-existing', status: 'ACTIVE' });
      await expect(
        subject.mute(ACTOR, ROOM.id, { ...baseDto, channels: ['chat'] }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED,
        status: HttpStatus.CONFLICT,
      });
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
    });

    it('mutes mic only when channels is ["mic"]: calls media.forceMute, no createMute', async () => {
      await subject.mute(ACTOR, ROOM.id, { ...baseDto, channels: ['mic'] });

      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: TARGET,
        muted: true,
      });
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.findActiveMute).not.toHaveBeenCalled();
      expect(metrics.incMute).toHaveBeenCalledWith('mic');
    });

    it('defaults to both channels when channels is omitted', async () => {
      await subject.mute(ACTOR, ROOM.id, baseDto);

      expect(moderationRepo.createMute).toHaveBeenCalled();
      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: TARGET,
        muted: true,
      });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ channels: ['chat', 'mic'] }),
        }),
      );
    });

    it('requires durationMinutes > 0 for a TEMPORARY mute', async () => {
      await expect(
        subject.mute(ACTOR, ROOM.id, {
          userId: TARGET,
          type: VideoRoomModerationMuteType.TEMPORARY,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
    });

    it('mic-only TEMPORARY mute succeeds without durationMinutes and creates no chat mute row', async () => {
      await subject.mute(ACTOR, ROOM.id, {
        userId: TARGET,
        type: VideoRoomModerationMuteType.TEMPORARY,
        channels: ['mic'],
      });

      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: TARGET,
        muted: true,
      });
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.findActiveMute).not.toHaveBeenCalled();
    });

    it('chat-only TEMPORARY mute still requires durationMinutes', async () => {
      await expect(
        subject.mute(ACTOR, ROOM.id, {
          userId: TARGET,
          type: VideoRoomModerationMuteType.TEMPORARY,
          channels: ['chat'],
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
    });

    it('resolves a TEMPORARY expiry as now + durationMinutes * 60000', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await subject.mute(ACTOR, ROOM.id, {
        userId: TARGET,
        type: VideoRoomModerationMuteType.TEMPORARY,
        durationMinutes: 10,
        channels: ['chat'],
      });

      expect(moderationRepo.createMute).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: new Date(now + 10 * 60_000) }),
      );

      jest.restoreAllMocks();
    });

    it('enqueues a notify job', async () => {
      await subject.mute(ACTOR, ROOM.id, baseDto);
      expect(queue.add).toHaveBeenCalled();
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.mute(ACTOR, ROOM.id, baseDto);
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= unmute =======================

  describe('unmute', () => {
    it('unmutes chat: lifts the mute, removes the mirror, audits and publishes', async () => {
      moderationRepo.findActiveMute.mockResolvedValue({ id: 'mute-1', status: 'ACTIVE' });
      await subject.unmute(ACTOR, ROOM.id, TARGET, ['chat']);

      expect(moderationRepo.liftMute).toHaveBeenCalledWith('mute-1', ACTOR.id);
      expect(moderationRepo.removeMuteMirror).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(media.forceMute).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.UNMUTE,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.UNMUTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            targetUserId: TARGET,
            channels: ['chat'],
          }),
        }),
      );
    });

    it('404s when there is no active chat mute to lift', async () => {
      moderationRepo.findActiveMute.mockResolvedValue(null);
      await expect(subject.unmute(ACTOR, ROOM.id, TARGET, ['chat'])).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_MUTE_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
      expect(moderationRepo.liftMute).not.toHaveBeenCalled();
    });

    it('unmutes mic via media.forceMute(muted:false)', async () => {
      await subject.unmute(ACTOR, ROOM.id, TARGET, ['mic']);

      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: TARGET,
        muted: false,
      });
      expect(moderationRepo.findActiveMute).not.toHaveBeenCalled();
    });

    it('defaults to both channels when channels is omitted', async () => {
      moderationRepo.findActiveMute.mockResolvedValue({ id: 'mute-1', status: 'ACTIVE' });
      await subject.unmute(ACTOR, ROOM.id, TARGET);

      expect(moderationRepo.liftMute).toHaveBeenCalled();
      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: TARGET,
        muted: false,
      });
    });

    it('requires the MUTE_USERS permission', async () => {
      await subject.unmute(ACTOR, ROOM.id, TARGET, ['mic']);
      expect(permissions.assertPermission).toHaveBeenCalledWith(ACTOR, ROOM, expect.any(String));
    });
  });

  // ======================= muteAll =======================

  describe('muteAll', () => {
    it('requires the ROOM_MUTE permission', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['chat']);
      expect(permissions.assertPermission).toHaveBeenCalledWith(ACTOR, ROOM, expect.any(String));
    });

    it('chat: sets the room chat mode to read-only', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['chat']);
      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ chatMode: 'READ_ONLY' }),
      );
    });

    it('chat: also publishes ChatModeChangedEvent with the new mode, so chat clients get the realtime flip', async () => {
      rooms.updateSettings.mockResolvedValueOnce({
        chatMode: 'READ_ONLY',
        allowChat: true,
        slowModeSeconds: 0,
      });

      await subject.muteAll(ACTOR, ROOM.id, ['chat']);

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            chatMode: 'READ_ONLY',
            allowChat: true,
            slowModeSeconds: 0,
            actorId: ACTOR.id,
          }),
        }),
      );
    });

    it('mic-only: does not publish ChatModeChangedEvent (chat channel untouched)', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['mic']);

      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED }),
      );
    });

    it('mic: sweeps every non-elevated seated speaker via media.forceMute, skipping elevated roles', async () => {
      media.getMediaState.mockResolvedValue({
        participants: [{ userId: 'speaker-1' }, { userId: 'speaker-2' }],
      });
      permissions.resolveEffectiveRole.mockImplementation((_ref: unknown, userId: string) =>
        Promise.resolve(userId === 'speaker-2' ? VideoRoomMemberRole.MODERATOR : null),
      );

      await subject.muteAll(ACTOR, ROOM.id, ['mic']);

      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: 'speaker-1',
        muted: true,
      });
      expect(media.forceMute).not.toHaveBeenCalledWith(
        ACTOR,
        ROOM.id,
        expect.objectContaining({ targetUserId: 'speaker-2' }),
      );
      // A mic-only mute still writes the settings row (isRoomMuted) — see the
      // "mute-all settings state" tests below. It just doesn't touch chatMode.
      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ isRoomMuted: true }),
      );
    });

    it('audits the room-wide action with a null target and publishes RoomModerationUpdatedEvent', async () => {
      await subject.muteAll(ACTOR, ROOM.id);

      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: null,
          action: VideoRoomModerationActionType.ROOM_MUTED,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.ROOM_MODERATION_UPDATED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: ACTOR.id,
            channels: ['chat', 'mic'],
            muted: true,
          }),
        }),
      );
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.muteAll(ACTOR, ROOM.id);
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= unmuteAll =======================

  describe('unmuteAll', () => {
    it('requires the ROOM_MUTE permission', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id, ['chat']);
      expect(permissions.assertPermission).toHaveBeenCalledWith(ACTOR, ROOM, expect.any(String));
    });

    it('chat: sets the room chat mode back to normal', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id, ['chat']);
      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ chatMode: 'NORMAL', allowViewerChat: true }),
      );
    });

    it('chat: also publishes ChatModeChangedEvent with the restored mode', async () => {
      rooms.updateSettings.mockResolvedValueOnce({
        chatMode: 'NORMAL',
        allowChat: true,
        slowModeSeconds: 0,
      });

      await subject.unmuteAll(ACTOR, ROOM.id, ['chat']);

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            chatMode: 'NORMAL',
            actorId: ACTOR.id,
          }),
        }),
      );
    });

    it('mic: un-force-mutes every non-elevated seated speaker via media.forceMute, skipping elevated roles', async () => {
      media.getMediaState.mockResolvedValue({
        participants: [{ userId: 'speaker-1' }, { userId: 'speaker-2' }],
      });
      permissions.resolveEffectiveRole.mockImplementation((_ref: unknown, userId: string) =>
        Promise.resolve(userId === 'speaker-2' ? VideoRoomMemberRole.MODERATOR : null),
      );

      await subject.unmuteAll(ACTOR, ROOM.id, ['mic']);

      expect(media.forceMute).toHaveBeenCalledWith(ACTOR, ROOM.id, {
        targetUserId: 'speaker-1',
        muted: false,
      });
      expect(media.forceMute).not.toHaveBeenCalledWith(
        ACTOR,
        ROOM.id,
        expect.objectContaining({ targetUserId: 'speaker-2' }),
      );
      // A mic-only unmute still writes the settings row (isRoomMuted) — see
      // the "mute-all settings state" tests below. It doesn't touch chatMode.
      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ isRoomMuted: false }),
      );
    });

    it('mic-only: does not publish ChatModeChangedEvent (chat channel untouched)', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id, ['mic']);

      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED }),
      );
    });

    it('audits the room-wide action (ROOM_UNMUTED) with a null target and publishes RoomModerationUpdatedEvent(muted:false)', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id);

      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: null,
          action: VideoRoomModerationActionType.ROOM_UNMUTED,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.ROOM_MODERATION_UPDATED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: ACTOR.id,
            channels: ['chat', 'mic'],
            muted: false,
          }),
        }),
      );
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id);
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= muteAll/unmuteAll settings integrity =======================

  describe('mute-all settings state', () => {
    it('sets isRoomMuted when the mic channel is included', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['mic']);

      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ isRoomMuted: true }),
      );
    });

    // Chat state is carried by chatMode; isRoomMuted is the mic signal only.
    it('leaves isRoomMuted untouched for a chat-only mute', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['chat']);

      const patch = rooms.updateSettings.mock.calls[0][1];
      expect(patch).not.toHaveProperty('isRoomMuted');
      expect(patch).toMatchObject({ chatMode: VideoRoomChatMode.READ_ONLY });
    });

    it('writes both channels in ONE updateSettings call', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['chat', 'mic']);

      expect(rooms.updateSettings).toHaveBeenCalledTimes(1);
      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({
          chatMode: VideoRoomChatMode.READ_ONLY,
          isRoomMuted: true,
        }),
      );
    });

    it('clears isRoomMuted on unmuteAll of the mic channel', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id, ['mic']);

      expect(rooms.updateSettings).toHaveBeenCalledWith(
        ROOM.id,
        expect.objectContaining({ isRoomMuted: false }),
      );
    });
  });

  describe('mute-all broadcast', () => {
    const settingsEvents = () =>
      published.filter((e) => e.name === VIDEO_ROOM_EVENTS.SETTINGS_UPDATED);

    it('publishes RoomSettingsUpdatedEvent after muteAll', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['mic']);

      expect(settingsEvents()).toHaveLength(1);
      expect(settingsEvents()[0].payload).toMatchObject({
        roomId: ROOM.id,
        actorId: ACTOR.id,
      });
      expect(settingsEvents()[0].payload.settings.isRoomMuted).toBe(true);
    });

    it('publishes RoomSettingsUpdatedEvent after unmuteAll', async () => {
      await subject.unmuteAll(ACTOR, ROOM.id, ['mic']);

      expect(settingsEvents()).toHaveLength(1);
      expect(settingsEvents()[0].payload.settings.isRoomMuted).toBe(false);
    });

    it('lists exactly the written fields in `changed`', async () => {
      await subject.muteAll(ACTOR, ROOM.id, ['chat', 'mic']);

      expect([...settingsEvents()[0].payload.changed].sort()).toEqual(
        ['allowViewerChat', 'chatMode', 'isRoomMuted'].sort(),
      );
    });

    // An empty patch must not produce a phantom settings broadcast.
    it('does not publish when no channel writes settings', async () => {
      await subject.muteAll(ACTOR, ROOM.id, []);

      expect(settingsEvents()).toHaveLength(0);
      expect(rooms.updateSettings).not.toHaveBeenCalled();
    });
  });

  // ======================= warn =======================

  describe('warn', () => {
    it('rejects moderating yourself', async () => {
      await expect(subject.warn(ACTOR, ROOM.id, ACTOR.id, 'be nice')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
      });
    });

    it('protects the room owner from being warned', async () => {
      await expect(subject.warn(ACTOR, ROOM.id, OWNER.id, 'be nice')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
      });
    });

    it('creates the warning, audits, publishes, increments metrics and notifies — no escalation', async () => {
      await subject.warn(ACTOR, ROOM.id, TARGET, 'spamming', { messageId: 'msg-1' });

      expect(warningRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          userId: TARGET,
          moderatorId: ACTOR.id,
          reason: 'spamming',
          metadata: { messageId: 'msg-1' },
        }),
      );
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.WARN,
          reason: 'spamming',
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.WARNED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            targetUserId: TARGET,
            reason: 'spamming',
          }),
        }),
      );
      expect(metrics.incWarning).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();

      // no escalation: nothing mute/block/kick related is ever touched by warn
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.createBlock).not.toHaveBeenCalled();
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
    });
  });

  // ======================= forceDisconnect =======================

  describe('forceDisconnect', () => {
    it('rejects moderating yourself', async () => {
      await expect(subject.forceDisconnect(ACTOR, ROOM.id, ACTOR.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
      });
    });

    it('protects the room owner from being force-disconnected', async () => {
      await expect(subject.forceDisconnect(ACTOR, ROOM.id, OWNER.id)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
      });
    });

    it('ends sessions, hard-disconnects, audits and publishes — no membership deactivation, no mute/block row', async () => {
      await subject.forceDisconnect(ACTOR, ROOM.id, TARGET, 'disruptive');

      expect(session.endUserRoomSessions).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(VIDEO_ROOM_NAMESPACE, TARGET);
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: ACTOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.FORCE_DISCONNECT,
          reason: 'disruptive',
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.FORCE_DISCONNECTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            targetUserId: TARGET,
            reason: 'disruptive',
          }),
        }),
      );
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.createBlock).not.toHaveBeenCalled();
    });

    it('requires the KICK_USERS permission', async () => {
      await subject.forceDisconnect(ACTOR, ROOM.id, TARGET);
      expect(permissions.assertPermission).toHaveBeenCalledWith(ACTOR, ROOM, expect.any(String));
    });
  });

  // ======================= autoMute =======================

  describe('autoMute', () => {
    it('is a no-op when the user already has an active mute (idempotent)', async () => {
      moderationRepo.findActiveMute.mockResolvedValue({ id: 'mute-existing', status: 'ACTIVE' });

      await subject.autoMute(ROOM.id, TARGET, 'spam-detected');

      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('creates a TEMPORARY mute for the configured autoMuteMinutes, audits, and publishes as SYSTEM', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await subject.autoMute(ROOM.id, TARGET, 'spam-detected', { detector: 'spam' });

      expect(config.get).toHaveBeenCalledWith('videoRoom');
      expect(moderationRepo.createMute).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          userId: TARGET,
          moderatorId: SYSTEM_MODERATOR_ID,
          type: VideoRoomModerationMuteType.TEMPORARY,
          reason: 'spam-detected',
          expiresAt: new Date(now + 15 * 60_000),
        }),
      );
      expect(moderationRepo.addMuteMirror).toHaveBeenCalledWith(ROOM.id, TARGET, 15 * 60_000);
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: SYSTEM_MODERATOR_ID,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.AUTO_MUTED,
          reason: 'spam-detected',
          metadata: expect.objectContaining({ system: true, detector: 'spam' }),
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.MUTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: SYSTEM_MODERATOR_ID,
            targetUserId: TARGET,
            type: VideoRoomModerationMuteType.TEMPORARY,
          }),
        }),
      );
      expect(metrics.incAutoAction).toHaveBeenCalledWith('spam', 'auto_mute');

      jest.restoreAllMocks();
    });

    it('performs no permission/outranks checks against a regular target (system actor bypasses human RBAC)', async () => {
      await subject.autoMute(ROOM.id, TARGET, 'spam-detected');
      expect(permissions.assertPermission).not.toHaveBeenCalled();
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
      expect(moderationRepo.createMute).toHaveBeenCalled();
    });

    it('is a no-op when the target is the room owner (auto actions must never punish the owner)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.OWNER);

      await subject.autoMute(ROOM.id, OWNER.id, 'spam-detected');

      expect(permissions.resolveEffectiveRole).toHaveBeenCalledWith(ROOM, OWNER.id);
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('is a no-op when the target holds an elevated in-room role (ADMIN/MODERATOR)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);

      await subject.autoMute(ROOM.id, TARGET, 'spam-detected');

      expect(moderationRepo.createMute).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('still acts on a regular participant (the owner/elevated-role exemption does not block normal targets)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.PARTICIPANT);

      await subject.autoMute(ROOM.id, TARGET, 'spam-detected');

      expect(moderationRepo.createMute).toHaveBeenCalled();
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.autoMute(ROOM.id, TARGET, 'spam-detected');
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= autoKick =======================

  describe('autoKick', () => {
    it('is a no-op when the member is not active (idempotent)', async () => {
      rooms.getMember.mockResolvedValue({ userId: TARGET, isActive: false });

      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');

      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('is a no-op when the member is absent entirely', async () => {
      rooms.getMember.mockResolvedValue(null);

      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');

      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
    });

    it('ejects the member, audits AUTO_KICKED, and publishes as SYSTEM', async () => {
      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave', { detector: 'rapid_join_leave' });

      expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM.id, TARGET, SYSTEM_MODERATOR_ID);
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(VIDEO_ROOM_NAMESPACE, TARGET);
      expect(session.endUserRoomSessions).toHaveBeenCalledWith(ROOM.id, TARGET);
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: SYSTEM_MODERATOR_ID,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.AUTO_KICKED,
          reason: 'rapid-join-leave',
          metadata: expect.objectContaining({ system: true, detector: 'rapid_join_leave' }),
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.KICKED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            moderatorId: SYSTEM_MODERATOR_ID,
            targetUserId: TARGET,
            reason: 'rapid-join-leave',
          }),
        }),
      );
      expect(metrics.incAutoAction).toHaveBeenCalledWith('rapid_join_leave', 'auto_kick');
    });

    it('performs no permission/outranks checks against a regular target (system actor bypasses human RBAC)', async () => {
      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');
      expect(permissions.assertPermission).not.toHaveBeenCalled();
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
      expect(rooms.deactivateMember).toHaveBeenCalled();
    });

    it('is a no-op when the target is the room owner (a flaky-connection rapid-join-leave burst must never auto-kick the owner)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.OWNER);

      await subject.autoKick(ROOM.id, OWNER.id, 'rapid-join-leave');

      expect(permissions.resolveEffectiveRole).toHaveBeenCalledWith(ROOM, OWNER.id);
      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(session.endUserRoomSessions).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('is a no-op when the target holds an elevated in-room role (ADMIN/MODERATOR)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.ADMIN);

      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');

      expect(rooms.deactivateMember).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
    });

    it('still acts on a regular participant (the owner/elevated-role exemption does not block normal targets)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.PARTICIPANT);

      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');

      expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM.id, TARGET, SYSTEM_MODERATOR_ID);
    });

    it('runs the mutation under the per-room moderation lock', async () => {
      await subject.autoKick(ROOM.id, TARGET, 'rapid-join-leave');
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });

  // ======================= autoFlag =======================

  describe('autoFlag', () => {
    it('opens a system report via VideoRoomReportService.createSystemReport and audits AUTO_FLAGGED', async () => {
      await subject.autoFlag(ROOM.id, TARGET, VideoRoomReportReason.SPAM, {
        detector: 'excessive_reports',
        count: 5,
      });

      expect(reportService.createSystemReport).toHaveBeenCalledWith(
        ROOM.id,
        TARGET,
        VideoRoomReportReason.SPAM,
        { detector: 'excessive_reports', count: 5 },
      );
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: SYSTEM_MODERATOR_ID,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.AUTO_FLAGGED,
          metadata: expect.objectContaining({ system: true, detector: 'excessive_reports' }),
        }),
      );
      expect(metrics.incAutoAction).toHaveBeenCalledWith('excessive_reports', 'auto_flag');

      // report creation must land before the audit row
      expect(callOrder.indexOf('createSystemReport')).toBeLessThan(
        callOrder.indexOf('appendAction'),
      );
    });

    it('rejects an unknown room without calling the report service', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(
        subject.autoFlag(ROOM.id, TARGET, VideoRoomReportReason.SPAM),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND });
      expect(reportService.createSystemReport).not.toHaveBeenCalled();
    });

    it('performs no permission/outranks checks against a regular target (system actor bypasses human RBAC)', async () => {
      await subject.autoFlag(ROOM.id, TARGET, VideoRoomReportReason.ABUSE);
      expect(permissions.assertPermission).not.toHaveBeenCalled();
      expect(permissions.assertOutranks).not.toHaveBeenCalled();
      expect(reportService.createSystemReport).toHaveBeenCalled();
    });

    it('is a no-op when the target is the room owner (auto actions must never punish the owner)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.OWNER);

      await subject.autoFlag(ROOM.id, OWNER.id, VideoRoomReportReason.ABUSE);

      expect(reportService.createSystemReport).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
      expect(metrics.incAutoAction).not.toHaveBeenCalled();
    });

    it('is a no-op when the target holds an elevated in-room role (ADMIN/MODERATOR)', async () => {
      permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);

      await subject.autoFlag(ROOM.id, TARGET, VideoRoomReportReason.ABUSE);

      expect(reportService.createSystemReport).not.toHaveBeenCalled();
      expect(moderationRepo.appendAction).not.toHaveBeenCalled();
    });

    it('runs under the per-room moderation lock', async () => {
      await subject.autoFlag(ROOM.id, TARGET, VideoRoomReportReason.SPAM);
      expect(locks.withLock).toHaveBeenCalledWith(
        expect.stringContaining(ROOM.id),
        expect.any(Function),
      );
    });
  });
});
