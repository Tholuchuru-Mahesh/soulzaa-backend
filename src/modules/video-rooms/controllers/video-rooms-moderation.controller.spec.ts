import * as fs from 'fs';
import * as path from 'path';
import { PlatformRole, VideoRoomReportReason, VideoRoomReportStatus } from '@prisma/client';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { VideoRoomsModerationController } from './video-rooms-moderation.controller';

const user = { id: 'u1', roles: [PlatformRole.USER], sid: 's1' } as unknown as AuthenticatedUser;
const expectedActor = { id: 'u1', roles: [PlatformRole.USER] };
const ROOM = 'r1';
const META: RequestMetadata = {
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  timestamp: '2026-07-23T00:00:00.000Z',
};

describe('VideoRoomsModerationController', () => {
  let moderation: any;
  let reports: any;
  let query: any;
  let platformBans: any;
  let broadBans: any;
  let subject: VideoRoomsModerationController;

  beforeEach(() => {
    moderation = {
      kickMany: jest.fn().mockResolvedValue({ kicked: [], skipped: [] }),
      blacklist: jest.fn().mockResolvedValue(undefined),
      unblacklist: jest.fn().mockResolvedValue(undefined),
      mute: jest.fn().mockResolvedValue(undefined),
      unmute: jest.fn().mockResolvedValue(undefined),
      muteAll: jest.fn().mockResolvedValue(undefined),
      unmuteAll: jest.fn().mockResolvedValue(undefined),
      warn: jest.fn().mockResolvedValue(undefined),
      forceDisconnect: jest.fn().mockResolvedValue(undefined),
      assertCanModerate: jest.fn().mockResolvedValue(undefined),
    };
    reports = {
      report: jest.fn().mockResolvedValue({ id: 'report-1' }),
      reviewReport: jest.fn().mockResolvedValue(undefined),
      listReports: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    };
    query = {
      history: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      mutedUsers: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      blacklistedUsers: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      warnings: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    };
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    broadBans = { banBroad: jest.fn().mockResolvedValue({ id: 'bb-1' }) };
    subject = new VideoRoomsModerationController(
      moderation,
      reports,
      query,
      platformBans as never,
      broadBans as never,
    );
  });

  describe('delegation — the controller decides nothing itself', () => {
    it('delegates kick (single+multi via userIds[]) with the actor and forwarded request metadata', async () => {
      const dto = { userIds: ['t1', 't2'], reason: 'spamming' } as never;
      await subject.kick(user, ROOM, dto, META);
      expect(moderation.kickMany).toHaveBeenCalledWith(
        expectedActor,
        ROOM,
        ['t1', 't2'],
        'spamming',
        META,
      );
    });

    it('delegates blacklist with forwarded request metadata', async () => {
      const dto = { userId: 't1', reason: 'abuse' } as never;
      await subject.blacklist(user, ROOM, dto, META);
      expect(moderation.blacklist).toHaveBeenCalledWith(
        expectedActor,
        ROOM,
        't1',
        'abuse',
        undefined,
        undefined,
        META,
      );
    });

    it('delegates unblacklist with forwarded request metadata', async () => {
      await subject.unblacklist(user, ROOM, 't1', META);
      expect(moderation.unblacklist).toHaveBeenCalledWith(expectedActor, ROOM, 't1', META);
    });

    it('delegates mute with the full dto and forwarded request metadata', async () => {
      const dto = { userId: 't1', type: 'PERMANENT', channels: ['chat'] } as never;
      await subject.mute(user, ROOM, dto, META);
      expect(moderation.mute).toHaveBeenCalledWith(expectedActor, ROOM, dto, META);
    });

    it('delegates unmute with forwarded request metadata', async () => {
      const dto = { userId: 't1', channels: ['mic'] } as never;
      await subject.unmute(user, ROOM, dto, META);
      expect(moderation.unmute).toHaveBeenCalledWith(expectedActor, ROOM, 't1', ['mic'], META);
    });

    it('delegates mute-all with forwarded request metadata', async () => {
      const dto = { channels: ['chat', 'mic'] } as never;
      await subject.muteAll(user, ROOM, dto, META);
      expect(moderation.muteAll).toHaveBeenCalledWith(expectedActor, ROOM, ['chat', 'mic'], META);
    });

    it('delegates unmute-all with forwarded request metadata', async () => {
      const dto = { channels: ['chat', 'mic'] } as never;
      await subject.unmuteAll(user, ROOM, dto, META);
      expect(moderation.unmuteAll).toHaveBeenCalledWith(expectedActor, ROOM, ['chat', 'mic'], META);
    });

    it('delegates warn with reason + DTO metadata + forwarded request metadata', async () => {
      const dto = { userId: 't1', reason: 'be nice', metadata: { messageId: 'm1' } } as never;
      await subject.warn(user, ROOM, dto, META);
      expect(moderation.warn).toHaveBeenCalledWith(
        expectedActor,
        ROOM,
        't1',
        'be nice',
        { messageId: 'm1' },
        'PRIVATE',
        META,
      );
    });

    it('delegates warn with an explicit ROOM scope', async () => {
      const dto = {
        userId: 't1',
        reason: 'be nice',
        metadata: { messageId: 'm1' },
        scope: 'ROOM',
      } as never;
      await subject.warn(user, ROOM, dto, META);
      expect(moderation.warn).toHaveBeenCalledWith(
        expectedActor,
        ROOM,
        't1',
        'be nice',
        { messageId: 'm1' },
        'ROOM',
        META,
      );
    });

    it('delegates force-disconnect with forwarded request metadata', async () => {
      const dto = { userId: 't1', reason: 'afk' } as never;
      await subject.forceDisconnect(user, ROOM, dto, META);
      expect(moderation.forceDisconnect).toHaveBeenCalledWith(
        expectedActor,
        ROOM,
        't1',
        'afk',
        META,
      );
    });

    it('delegates report', async () => {
      const dto = {
        targetUserId: 't1',
        reason: VideoRoomReportReason.HARASSMENT,
        description: 'rude',
      } as never;
      await subject.report(user, ROOM, dto);
      expect(reports.report).toHaveBeenCalledWith(expectedActor, ROOM, dto);
    });

    it('delegates reviewReport with forwarded request metadata', async () => {
      const dto = { status: VideoRoomReportStatus.ACTIONED, resolutionAction: 'muted' } as never;
      await subject.reviewReport(user, ROOM, 'report-1', dto, META);
      expect(reports.reviewReport).toHaveBeenCalledWith(expectedActor, ROOM, 'report-1', dto, META);
    });

    it('delegates history to the query service', async () => {
      const q = { page: 1, limit: 20, skip: 0 } as never;
      await subject.history(user, ROOM, q);
      expect(query.history).toHaveBeenCalledWith(expectedActor, ROOM, q);
    });

    it('delegates the reports list to the report service', async () => {
      const q = { page: 1, limit: 20, skip: 0 } as never;
      await subject.listReports(user, ROOM, q);
      expect(reports.listReports).toHaveBeenCalledWith(expectedActor, ROOM, q);
    });

    it('delegates muted-users to the query service', async () => {
      const q = { page: 1, limit: 20, skip: 0 } as never;
      await subject.mutedUsers(user, ROOM, q);
      expect(query.mutedUsers).toHaveBeenCalledWith(expectedActor, ROOM, q);
    });

    it('delegates blacklisted-users to the query service', async () => {
      const q = { page: 1, limit: 20, skip: 0 } as never;
      await subject.blacklistedUsers(user, ROOM, q);
      expect(query.blacklistedUsers).toHaveBeenCalledWith(expectedActor, ROOM, q);
    });

    it('delegates warnings to the query service', async () => {
      const q = { page: 1, limit: 20, skip: 0 } as never;
      await subject.warnings(user, ROOM, q);
      expect(query.warnings).toHaveBeenCalledWith(expectedActor, ROOM, q);
    });
  });

  describe('/report allows a non-elevated actor', () => {
    it('accepts a plain USER-role actor (no elevated permission) — authorization is left to the service', async () => {
      const nonElevatedUser = {
        id: 'viewer-1',
        roles: [PlatformRole.USER],
        sid: 's2',
      } as unknown as AuthenticatedUser;
      const dto = {
        targetUserId: 't1',
        reason: VideoRoomReportReason.SPAM,
      } as never;

      await expect(subject.report(nonElevatedUser, ROOM, dto)).resolves.toEqual({ id: 'report-1' });
      expect(reports.report).toHaveBeenCalledWith(
        { id: 'viewer-1', roles: [PlatformRole.USER] },
        ROOM,
        dto,
      );
    });
  });

  describe('banGlobally — platform-wide 24h ban', () => {
    it('requires moderation authorization on THIS room before issuing the ban', async () => {
      const dto = { reason: 'harassment' } as never;
      await subject.banGlobally(user, ROOM, 't1', dto);

      expect(moderation.assertCanModerate).toHaveBeenCalledWith(expectedActor, ROOM);
      expect(platformBans.banUser).toHaveBeenCalledWith({
        moderatorId: 'u1',
        targetUserId: 't1',
        reason: 'harassment',
        roomType: 'VIDEO_ROOM',
        originRoomId: ROOM,
      });
    });

    it('a non-moderator is rejected before the ban is ever issued', async () => {
      moderation.assertCanModerate.mockRejectedValueOnce(new Error('forbidden'));
      const dto = { reason: 'harassment' } as never;

      await expect(subject.banGlobally(user, ROOM, 't1', dto)).rejects.toThrow('forbidden');
      expect(platformBans.banUser).not.toHaveBeenCalled();
    });
  });

  describe('broadBan', () => {
    it('delegates to BroadBanService.banBroad with the room id, moderator id, and DTO fields', async () => {
      const dto = {
        reason: 'abuse',
        description: 'repeated abuse',
        proofUrl: 'https://x/proof.png',
      } as never;
      const result = await subject.broadBan(user, ROOM, dto);

      expect(moderation.assertCanModerate).toHaveBeenCalledWith(expectedActor, ROOM);
      expect(broadBans.banBroad).toHaveBeenCalledWith({
        moderatorId: 'u1',
        roomId: ROOM,
        roomType: 'VIDEO_ROOM',
        reason: 'abuse',
        description: 'repeated abuse',
        proofUrl: 'https://x/proof.png',
      });
      expect(result).toEqual({ id: 'bb-1' });
    });

    it('a non-moderator is rejected before the broad ban is ever issued', async () => {
      moderation.assertCanModerate.mockRejectedValueOnce(new Error('forbidden'));
      const dto = { reason: 'abuse' } as never;

      await expect(subject.broadBan(user, ROOM, dto)).rejects.toThrow('forbidden');
      expect(broadBans.banBroad).not.toHaveBeenCalled();
    });
  });

  describe('no route stubs a 501', () => {
    it('the controller source contains no NOT_IMPLEMENTED / 501 stub response', () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'video-rooms-moderation.controller.ts'),
        'utf8',
      );
      expect(source).not.toMatch(/status:\s*501/);
      expect(source).not.toMatch(/NOT_IMPLEMENTED|NotImplementedException/);
    });
  });
});
