import { ForbiddenException } from '@nestjs/common';
import { LiveStreamStatus } from '@prisma/client';
import {
  LIVE_STREAM_NAMESPACE,
  LIVE_STREAM_SOCKET_EVENTS,
  SYSTEM_MODERATOR_ID,
} from '../constants/live-stream-moderation.constants';
import { LiveStreamService, type LiveStreamModerationInput } from './live-stream.service';

const STREAM_ID = 'stream-1';
const HOST_ID = 'host-1';
const MODERATOR_ID = 'mod-1';
const VIEWER_ID = 'viewer-1';

const ACTIVE_STREAM = {
  id: STREAM_ID,
  hostId: HOST_ID,
  status: LiveStreamStatus.ACTIVE,
};

describe('LiveStreamService — non-host viewer moderation enforcement', () => {
  let prisma: any;
  let investigationRecording: any;
  let performanceStats: any;
  let presence: any;
  let moderationRepo: any;
  let sockets: any;
  let auditLog: any;
  let scopeService: any;
  let notifications: any;
  let reportRepo: any;
  let subject: LiveStreamService;

  beforeEach(() => {
    prisma = {
      liveStream: {
        findUnique: jest.fn().mockResolvedValue(ACTIVE_STREAM),
        update: jest
          .fn()
          .mockResolvedValue({ ...ACTIVE_STREAM, status: LiveStreamStatus.SUSPENDED }),
      },
      live_stream_moderation_actions: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
      },
    };
    investigationRecording = {
      beginRecording: jest.fn().mockResolvedValue({ id: 'rec-1', evidenceId: 'ev-1' }),
      completeRecording: jest.fn().mockResolvedValue(undefined),
      findActiveRecording: jest.fn().mockResolvedValue(null),
      beginOrReuseRecording: jest.fn().mockResolvedValue({ id: 'rec-1', evidenceId: 'ev-1' }),
    };
    performanceStats = { recordAction: jest.fn().mockResolvedValue(undefined) };
    presence = {
      joinLiveStream: jest.fn().mockResolvedValue(undefined),
      leaveLiveStream: jest.fn().mockResolvedValue(undefined),
      liveStreamViewerCount: jest.fn().mockResolvedValue(0),
      liveStreamViewers: jest.fn().mockResolvedValue([]),
    };
    moderationRepo = {
      findActiveMute: jest.fn().mockResolvedValue(null),
      createMute: jest.fn().mockResolvedValue({ id: 'mute-1' }),
      addMuteMirror: jest.fn().mockResolvedValue(undefined),
      isActivelyMuted: jest.fn().mockResolvedValue(false),
      findActiveBan: jest.fn().mockResolvedValue(null),
      createBan: jest.fn().mockResolvedValue({ id: 'ban-1' }),
      addBanMirror: jest.fn().mockResolvedValue(undefined),
      isActivelyBanned: jest.fn().mockResolvedValue(false),
    };
    sockets = {
      disconnectUserInNamespace: jest.fn(),
      emitToNamespaceRoom: jest.fn(),
      emitToUserInNamespace: jest.fn(),
    };
    auditLog = { logAction: jest.fn().mockResolvedValue(undefined) };
    scopeService = {
      assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
      resolveEscalationRecipients: jest.fn().mockResolvedValue([]),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    reportRepo = { listPendingReports: jest.fn().mockResolvedValue([]) };
    const platformAudit = { record: jest.fn().mockResolvedValue(undefined) };
    const platformBans = { assertNotGloballyBanned: jest.fn().mockResolvedValue(undefined) };

    subject = new LiveStreamService(
      prisma,
      investigationRecording,
      performanceStats,
      presence,
      moderationRepo,
      sockets,
      scopeService,
      auditLog,
      notifications,
      reportRepo,
      platformAudit as never,
      platformBans as never,
    );
  });

  const baseInput = (
    overrides: Partial<LiveStreamModerationInput> = {},
  ): LiveStreamModerationInput => ({
    streamId: STREAM_ID,
    moderatorId: MODERATOR_ID,
    targetUserId: VIEWER_ID,
    action: 'MUTE',
    ...overrides,
  });

  describe('MUTE on a non-host viewer', () => {
    it("moderateUser checks the stream host's scope before acting", async () => {
      await subject.moderateUser(baseInput({ action: 'MUTE' }));
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR_ID,
        ACTIVE_STREAM.hostId,
      );
    });

    it("moderateUser rejects a moderator outside the stream host's scope", async () => {
      scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(subject.moderateUser(baseInput({ action: 'MUTE' }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('persists a mute row + Redis mirror and rejects that viewer chat-send afterwards', async () => {
      await subject.moderateUser(baseInput({ action: 'MUTE', reason: 'spam' }));

      expect(moderationRepo.createMute).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: STREAM_ID,
          userId: VIEWER_ID,
          moderatorId: MODERATOR_ID,
        }),
      );
      expect(moderationRepo.addMuteMirror).toHaveBeenCalledWith(STREAM_ID, VIEWER_ID, null);
      expect(sockets.disconnectUserInNamespace).not.toHaveBeenCalled();

      moderationRepo.isActivelyMuted.mockResolvedValue(true);
      await expect(subject.assertCanSendChat(STREAM_ID, VIEWER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is idempotent — does not create a second mute row while one is active', async () => {
      moderationRepo.findActiveMute.mockResolvedValue({ id: 'existing-mute' });
      await subject.moderateUser(baseInput({ action: 'MUTE' }));
      expect(moderationRepo.createMute).not.toHaveBeenCalled();
    });

    it('reuses a recording already opened at join time instead of starting a new one', async () => {
      investigationRecording.findActiveRecording.mockResolvedValue({
        id: 'rec-open-at-join',
        evidenceId: 'EVD-JOIN0001',
      });

      await subject.moderateUser(baseInput({ action: 'MUTE', reason: 'spam' }));

      expect(investigationRecording.beginRecording).not.toHaveBeenCalled();
      expect(investigationRecording.completeRecording).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId: 'rec-open-at-join', violationReason: 'spam' }),
      );
    });

    it('links the evidenceId and captures request metadata on the audit log row', async () => {
      await subject.moderateUser(baseInput({ action: 'MUTE', reason: 'spam' }), {
        ip: '1.2.3.4',
        userAgent: 'Mozilla/5.0 Chrome/1.0',
      } as any);

      expect(auditLog.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          evidenceId: 'ev-1',
          violationReason: 'spam',
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0 Chrome/1.0',
          targetUserId: VIEWER_ID,
          liveStreamId: STREAM_ID,
        }),
      );
    });
  });

  describe('KICK on a non-host viewer', () => {
    it('force-disconnects the viewer on the /live namespace but does not suspend the stream', async () => {
      await subject.moderateUser(baseInput({ action: 'KICK' }));

      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        VIEWER_ID,
      );
      expect(prisma.liveStream.update).not.toHaveBeenCalled();
    });
  });

  describe('BAN on a non-host viewer', () => {
    it('persists a ban row + Redis mirror, disconnects them, and blocks rejoin', async () => {
      await subject.moderateUser(baseInput({ action: 'BAN', reason: 'harassment' }));

      expect(moderationRepo.createBan).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: STREAM_ID,
          userId: VIEWER_ID,
          moderatorId: MODERATOR_ID,
        }),
      );
      expect(moderationRepo.addBanMirror).toHaveBeenCalledWith(STREAM_ID, VIEWER_ID, null);
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        VIEWER_ID,
      );

      moderationRepo.isActivelyBanned.mockResolvedValue(true);
      const bannedUser = { id: VIEWER_ID, roles: [] } as any;
      await expect(subject.joinStream(STREAM_ID, bannedUser)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('supports a temporary ban via durationMinutes', async () => {
      await subject.moderateUser(baseInput({ action: 'BAN', durationMinutes: 60 }));
      const [[createArg]] = moderationRepo.createBan.mock.calls;
      expect(createArg.expiresAt).toBeInstanceOf(Date);
      expect(moderationRepo.addBanMirror).toHaveBeenCalledWith(
        STREAM_ID,
        VIEWER_ID,
        expect.any(Number),
      );
    });
  });

  describe('host targeting (unchanged behavior, now also disconnected)', () => {
    it('still suspends the stream on a HOST ban/kick, in addition to the socket disconnect', async () => {
      await subject.moderateUser(baseInput({ targetUserId: HOST_ID, action: 'BAN' }));
      expect(prisma.liveStream.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: STREAM_ID } }),
      );
      expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        HOST_ID,
      );
    });
  });

  describe('joinStream ban gate', () => {
    it('allows a non-banned viewer to join', async () => {
      const user = { id: 'fresh-viewer', roles: [] } as any;
      const result = await subject.joinStream(STREAM_ID, user);
      expect(result.joined).toBe(true);
      expect(moderationRepo.isActivelyBanned).toHaveBeenCalledWith(STREAM_ID, 'fresh-viewer');
    });

    it('never gates a MODERATOR/ADMIN even if a stale ban row exists', async () => {
      moderationRepo.isActivelyBanned.mockResolvedValue(true);
      const modUser = { id: 'mod-2', roles: ['MODERATOR'] } as any;
      await expect(subject.joinStream(STREAM_ID, modUser)).resolves.toMatchObject({ joined: true });
    });
  });

  describe('joinStream — pending-report-triggered investigation recording', () => {
    it('opens/reuses a recording per pending report when a MODERATOR joins', async () => {
      reportRepo.listPendingReports.mockResolvedValue([
        { id: 'report-1', targetUserId: 'target-a' },
        { id: 'report-2', targetUserId: 'target-b' },
      ]);
      const modUser = { id: MODERATOR_ID, roles: ['MODERATOR'] } as any;

      await subject.joinStream(STREAM_ID, modUser);
      // The hook fires off a fire-and-forget `.then()` chain; flush microtasks.
      await new Promise((r) => setImmediate(r));

      expect(reportRepo.listPendingReports).toHaveBeenCalledWith(STREAM_ID);
      expect(investigationRecording.beginOrReuseRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: MODERATOR_ID,
          targetUserId: 'target-a',
          liveStreamId: STREAM_ID,
        }),
      );
      expect(investigationRecording.beginOrReuseRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: MODERATOR_ID,
          targetUserId: 'target-b',
          liveStreamId: STREAM_ID,
        }),
      );
    });

    it('opens nothing for a non-moderator join', async () => {
      reportRepo.listPendingReports.mockResolvedValue([
        { id: 'report-1', targetUserId: 'target-a' },
      ]);
      const viewer = { id: VIEWER_ID, roles: [] } as any;

      await subject.joinStream(STREAM_ID, viewer);
      await new Promise((r) => setImmediate(r));

      expect(reportRepo.listPendingReports).not.toHaveBeenCalled();
      expect(investigationRecording.beginOrReuseRecording).not.toHaveBeenCalled();
    });

    it('opens nothing when the stream has no pending reports', async () => {
      reportRepo.listPendingReports.mockResolvedValue([]);
      const modUser = { id: MODERATOR_ID, roles: ['MODERATOR'] } as any;

      await subject.joinStream(STREAM_ID, modUser);
      await new Promise((r) => setImmediate(r));

      expect(investigationRecording.beginOrReuseRecording).not.toHaveBeenCalled();
    });
  });

  describe('anonymous moderation — system message broadcasts', () => {
    it('broadcasts a system message on MUTE, never the real moderator id', async () => {
      await subject.moderateUser(baseInput({ action: 'MUTE' }));

      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        STREAM_ID,
        expect.any(String),
        expect.objectContaining({
          targetUserId: VIEWER_ID,
          moderatorId: '00000000-0000-0000-0000-000000000000',
          systemMessage: expect.any(String),
        }),
      );
      const [, , , payload] = sockets.emitToNamespaceRoom.mock.calls[0];
      expect(payload.moderatorId).not.toBe(MODERATOR_ID);
    });

    it('broadcasts a system message on WARN (room scope), KICK and BAN too', async () => {
      await subject.moderateUser(baseInput({ action: 'WARN', scope: 'ROOM' }));
      await subject.moderateUser(baseInput({ action: 'KICK' }));
      await subject.moderateUser(baseInput({ action: 'BAN' }));
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledTimes(3);
    });
  });

  describe('moderateUser — WARN scope', () => {
    it('scope=PRIVATE (default) does not broadcast to the room', async () => {
      await subject.moderateUser({
        streamId: STREAM_ID,
        moderatorId: MODERATOR_ID,
        targetUserId: VIEWER_ID,
        action: 'WARN',
        reason: 'be nice',
      });
      expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalledWith(
        expect.anything(),
        STREAM_ID,
        LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
        expect.anything(),
      );
    });

    it('scope=PRIVATE (default) sends a targeted, anonymized socket event to just the target user', async () => {
      await subject.moderateUser({
        streamId: STREAM_ID,
        moderatorId: MODERATOR_ID,
        targetUserId: VIEWER_ID,
        action: 'WARN',
        reason: 'be nice',
      });

      expect(sockets.emitToUserInNamespace).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        VIEWER_ID,
        LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
        expect.objectContaining({
          streamId: STREAM_ID,
          moderatorId: SYSTEM_MODERATOR_ID,
          systemMessage: 'be nice',
        }),
      );
    });

    it('scope=ROOM broadcasts a system message with the moderator identity anonymized', async () => {
      await subject.moderateUser({
        streamId: STREAM_ID,
        moderatorId: MODERATOR_ID,
        targetUserId: VIEWER_ID,
        action: 'WARN',
        reason: 'be nice',
        scope: 'ROOM',
      });
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        LIVE_STREAM_NAMESPACE,
        STREAM_ID,
        LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
        expect.objectContaining({
          streamId: STREAM_ID,
          moderatorId: SYSTEM_MODERATOR_ID,
          systemMessage: 'be nice',
        }),
      );
    });
  });

  describe('escalateViolation — severity-routed notifications', () => {
    it('resolves recipients from the stream host and notifies each one', async () => {
      scopeService.resolveEscalationRecipients.mockResolvedValue(['admin-1']);

      await subject.escalateViolation(STREAM_ID, MODERATOR_ID, VIEWER_ID, 'reason', 'EMERGENCY');

      expect(scopeService.resolveEscalationRecipients).toHaveBeenCalledWith(
        'EMERGENCY',
        ACTIVE_STREAM.hostId,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          type: 'MODERATION_CASE_ESCALATED',
          actorId: MODERATOR_ID,
          entityType: 'live_stream',
          entityId: STREAM_ID,
        }),
      );
    });

    it('notifies every resolved recipient', async () => {
      scopeService.resolveEscalationRecipients.mockResolvedValue(['official-1', 'official-2']);
      await subject.escalateViolation(STREAM_ID, MODERATOR_ID, VIEWER_ID, 'reason', 'HIGH');
      expect(notifications.create).toHaveBeenCalledTimes(2);
    });

    it('skips notification dispatch entirely when notifications is not wired', async () => {
      const bareSubject = new LiveStreamService(
        prisma,
        investigationRecording,
        performanceStats,
        presence,
        moderationRepo,
        sockets,
        scopeService,
      );
      await expect(
        bareSubject.escalateViolation(STREAM_ID, MODERATOR_ID, VIEWER_ID, 'reason', 'CRITICAL'),
      ).resolves.toBeDefined();
    });
  });

  describe('joinStream & leaveStream presence and incognito', () => {
    it('joinStream checks global ban for non-moderators', async () => {
      const bans = {
        assertNotGloballyBanned: jest.fn().mockRejectedValue(new ForbiddenException('Banned')),
      };
      const localSubject = new LiveStreamService(
        prisma,
        investigationRecording,
        performanceStats,
        presence,
        moderationRepo,
        sockets,
        scopeService,
        auditLog,
        notifications,
        reportRepo,
        undefined,
        bans as never,
      );

      await expect(
        localSubject.joinStream(STREAM_ID, { id: 'user-1', roles: ['USER'] } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('joinStream routes moderator anonymously and audits the action', async () => {
      const audit = { record: jest.fn().mockResolvedValue(undefined) };
      const localSubject = new LiveStreamService(
        prisma,
        investigationRecording,
        performanceStats,
        presence,
        moderationRepo,
        sockets,
        scopeService,
        auditLog,
        notifications,
        reportRepo,
        audit as never,
      );

      const res = await localSubject.joinStream(STREAM_ID, {
        id: 'mod-1',
        roles: ['MODERATOR'],
      } as never);
      expect(res.isAnonymousModerator).toBe(true);
      expect(presence.joinLiveStream).toHaveBeenCalledWith(STREAM_ID, 'mod-1', true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: 'mod-1',
          action: 'INCOGNITO_JOIN',
          roomType: 'LIVE_STREAM',
        }),
      );
    });

    it('leaveStream removes moderator anonymously and audits the action', async () => {
      const audit = { record: jest.fn().mockResolvedValue(undefined) };
      const localSubject = new LiveStreamService(
        prisma,
        investigationRecording,
        performanceStats,
        presence,
        moderationRepo,
        sockets,
        scopeService,
        auditLog,
        notifications,
        reportRepo,
        audit as never,
      );

      await localSubject.leaveStream(STREAM_ID, { id: 'mod-1', roles: ['MODERATOR'] } as never);
      expect(presence.leaveLiveStream).toHaveBeenCalledWith(STREAM_ID, 'mod-1', true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: 'mod-1',
          action: 'INCOGNITO_LEAVE',
          roomType: 'LIVE_STREAM',
        }),
      );
    });
  });
});
