import { ForbiddenException, HttpStatus } from '@nestjs/common';
import {
  PlatformRole,
  VideoRoomModerationActionType,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { SYSTEM_MODERATOR_ID } from '../constants/video-room-moderation.constants';
import type { ListModerationDto } from '../dto/moderation.dto';
import { VIDEO_ROOM_MODERATION_EVENTS } from '../events/video-room-moderation.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomReportService } from './video-room-report.service';

const ROOM = { id: 'room-1', ownerId: 'owner-1' };
const REPORTER: RoomActor = { id: 'reporter-1', roles: [] as PlatformRole[] };
const MODERATOR: RoomActor = { id: 'mod-1', roles: [] as PlatformRole[] };
const TARGET = 'user-2';

function query(overrides: Partial<ListModerationDto> = {}): ListModerationDto {
  return { page: 1, limit: 20, skip: 0, ...overrides } as ListModerationDto;
}

describe('VideoRoomReportService', () => {
  let reportRepo: any;
  let rooms: any;
  let roles: any;
  let permissions: any;
  let moderationRepo: any;
  let metrics: any;
  let queue: any;
  let bus: any;
  let moderation: any;
  let approvalService: any;
  let scopeService: { assertModeratorInScope: jest.Mock };
  let subject: VideoRoomReportService;

  beforeEach(() => {
    reportRepo = {
      create: jest.fn().mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({
          id: 'report-1',
          status: VideoRoomReportStatus.PENDING,
          ...input,
        }),
      ),
      getById: jest.fn().mockResolvedValue(null),
      findOpen: jest.fn().mockResolvedValue(null),
      review: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([[], 0]),
      updateNotes: jest.fn().mockResolvedValue(undefined),
      assign: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      // DEFAULT enabled — pre-existing tests must keep exercising the real
      // (allowed) path rather than passing because reporting was silently
      // disabled underneath them.
      getSettings: jest.fn().mockResolvedValue({ allowReporting: true }),
      // Mirrors `getSettings` by default (delegates to it) so every test that
      // overrides `getSettings` keeps working now that `report()` reads
      // `requireSettings` instead; tests targeting the missing-row path
      // override this mock directly.
      requireSettings: jest.fn(),
    };
    rooms.requireSettings.mockImplementation(async () => {
      const row = await rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    roles = {
      listActiveByRoom: jest.fn().mockResolvedValue([{ userId: 'admin-1' }, { userId: 'mod-2' }]),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
    };
    moderationRepo = {
      appendAction: jest.fn().mockResolvedValue(undefined),
    };
    metrics = { incReport: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    moderation = {
      warn: jest.fn().mockResolvedValue(undefined),
      mute: jest.fn().mockResolvedValue(undefined),
      kick: jest.fn().mockResolvedValue(undefined),
      blacklist: jest.fn().mockResolvedValue(undefined),
    };
    approvalService = {
      propose: jest.fn().mockResolvedValue({ id: 'approval-1' }),
    };
    // `ROOM` (below) carries no `region`, so `room?.region` is falsy for
    // every pre-existing test in this file and the scope check never
    // actually fires — this mock exists only to satisfy the now-required
    // constructor parameter.
    scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };

    subject = new VideoRoomReportService(
      reportRepo,
      rooms,
      roles,
      permissions,
      moderationRepo,
      metrics,
      queue,
      bus,
      moderation,
      scopeService as unknown as WorkforceScopeService,
      undefined,
      undefined,
      approvalService,
    );
  });

  // ======================= report =======================

  describe('report', () => {
    it('rejects reporting yourself', async () => {
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: REPORTER.id,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(rooms.findById).not.toHaveBeenCalled();
      expect(reportRepo.findOpen).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
      expect(reportRepo.findOpen).not.toHaveBeenCalled();
    });

    it('rejects a duplicate open report against the same target', async () => {
      reportRepo.findOpen.mockResolvedValue({ id: 'existing-report' });
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.ABUSE,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_DUPLICATE_REPORT,
        status: HttpStatus.CONFLICT,
      });
      expect(reportRepo.create).not.toHaveBeenCalled();
    });

    it('creates a PENDING report, publishes UserReportedEvent to elevated+owner minus reporter, enqueues notify, and records metrics', async () => {
      const result = await subject.report(REPORTER, ROOM.id, {
        targetUserId: TARGET,
        reason: VideoRoomReportReason.HARASSMENT,
        description: 'rude',
      });

      expect(reportRepo.create).toHaveBeenCalledWith({
        roomId: ROOM.id,
        reporterId: REPORTER.id,
        targetUserId: TARGET,
        messageId: undefined,
        reason: VideoRoomReportReason.HARASSMENT,
        description: 'rude',
      });
      expect(result.status).toBe(VideoRoomReportStatus.PENDING);

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.REPORTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            reportId: 'report-1',
            reporterId: REPORTER.id,
            targetUserId: TARGET,
            reason: VideoRoomReportReason.HARASSMENT,
            recipientIds: expect.arrayContaining(['admin-1', 'mod-2', ROOM.ownerId]),
          }),
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({
          type: expect.any(String),
          roomId: ROOM.id,
          reportId: 'report-1',
        }),
      );
      expect(metrics.incReport).toHaveBeenCalledWith(VideoRoomReportReason.HARASSMENT);
    });

    it('excludes the reporter from recipients even when they hold an elevated role', async () => {
      roles.listActiveByRoom.mockResolvedValue([{ userId: REPORTER.id }, { userId: 'admin-1' }]);
      await subject.report(REPORTER, ROOM.id, {
        targetUserId: TARGET,
        reason: VideoRoomReportReason.SPAM,
      });
      const published = bus.publish.mock.calls[0][0];
      expect(published.payload.recipientIds).not.toContain(REPORTER.id);
      expect(published.payload.recipientIds).toContain('admin-1');
    });

    it('carries an optional messageId through to the created report', async () => {
      await subject.report(REPORTER, ROOM.id, {
        targetUserId: TARGET,
        reason: VideoRoomReportReason.MESSAGE,
        messageId: 'msg-1',
      });
      expect(reportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1' }),
      );
      expect(reportRepo.findOpen).toHaveBeenCalledWith(ROOM.id, REPORTER.id, TARGET, 'msg-1');
    });

    it('rejects a reporter who is not an active member of the room', async () => {
      rooms.getMember.mockResolvedValue(null);
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        status: HttpStatus.FORBIDDEN,
      });
      expect(rooms.getMember).toHaveBeenCalledWith(ROOM.id, REPORTER.id);
      expect(reportRepo.findOpen).not.toHaveBeenCalled();
      expect(reportRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a reporter whose membership row is inactive (left the room)', async () => {
      rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        status: HttpStatus.FORBIDDEN,
      });
      expect(reportRepo.create).not.toHaveBeenCalled();
    });

    it('allows an active viewer (audience member) to report', async () => {
      rooms.getMember.mockResolvedValue({ isActive: true, role: 'VIEWER' });
      const result = await subject.report(REPORTER, ROOM.id, {
        targetUserId: TARGET,
        reason: VideoRoomReportReason.SPAM,
      });
      expect(result.status).toBe(VideoRoomReportStatus.PENDING);
      expect(reportRepo.create).toHaveBeenCalled();
    });

    // ---- allowReporting policy gate (Task 9) ----

    it('refuses a report when allowReporting is disabled, and never persists it', async () => {
      rooms.getSettings.mockResolvedValue({ allowReporting: false });
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
      });
      expect(reportRepo.create).not.toHaveBeenCalled();
    });

    it('allows a report when allowReporting is enabled', async () => {
      rooms.getSettings.mockResolvedValue({ allowReporting: true });
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).resolves.toBeDefined();
    });

    // Guard hardening: a missing settings row must NOT read as "allowed".
    it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
      rooms.requireSettings.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING });
    });

    it('checks active membership before the allowReporting policy gate', async () => {
      rooms.getMember.mockResolvedValue(null);
      await expect(
        subject.report(REPORTER, ROOM.id, {
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER });
      expect(rooms.requireSettings).not.toHaveBeenCalled();
    });
  });

  // ======================= reviewReport =======================

  describe('reviewReport', () => {
    const PENDING_REPORT = {
      id: 'report-1',
      roomId: ROOM.id,
      targetUserId: TARGET,
      status: VideoRoomReportStatus.PENDING,
    };

    it('requires MANAGE_PARTICIPANTS', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.DISMISSED,
        }),
      ).rejects.toThrow('forbidden');
      expect(reportRepo.getById).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.DISMISSED,
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND });
    });

    it('404s on a missing report', async () => {
      reportRepo.getById.mockResolvedValue(null);
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'missing', {
          status: VideoRoomReportStatus.DISMISSED,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('404s on a report belonging to a different room', async () => {
      reportRepo.getById.mockResolvedValue({ ...PENDING_REPORT, roomId: 'other-room' });
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.DISMISSED,
        }),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND });
    });

    it('rejects reviewing a non-PENDING report', async () => {
      reportRepo.getById.mockResolvedValue({
        ...PENDING_REPORT,
        status: VideoRoomReportStatus.DISMISSED,
      });
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
        }),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_REPORT_NOT_PENDING,
        status: HttpStatus.CONFLICT,
      });
      expect(reportRepo.review).not.toHaveBeenCalled();
    });

    it('reviews, audits and publishes ReportReviewedEvent on success', async () => {
      reportRepo.getById.mockResolvedValue(PENDING_REPORT);
      await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
        status: VideoRoomReportStatus.ACTIONED,
        resolutionAction: 'kicked',
      });

      expect(reportRepo.review).toHaveBeenCalledWith(
        'report-1',
        MODERATOR.id,
        VideoRoomReportStatus.ACTIONED,
        'kicked',
      );
      expect(moderationRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          moderatorId: MODERATOR.id,
          targetUserId: TARGET,
          action: VideoRoomModerationActionType.REPORT_REVIEWED,
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.REPORT_REVIEWED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            reportId: 'report-1',
            moderatorId: MODERATOR.id,
            targetUserId: TARGET,
            status: VideoRoomReportStatus.ACTIONED,
            resolutionAction: 'kicked',
          }),
        }),
      );
    });

    // Deliberately unguarded (Task 9): a moderator must still be able to
    // triage reports that were filed before reporting was switched off.
    // Guarding this would strand an existing moderation queue behind a
    // toggle that no longer lets anyone clear it.
    it('still reviews a pending report when allowReporting is disabled', async () => {
      rooms.getSettings.mockResolvedValue({ allowReporting: false });
      reportRepo.getById.mockResolvedValue(PENDING_REPORT);
      await expect(
        subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          resolutionAction: 'kicked',
        }),
      ).resolves.toBeUndefined();
      expect(reportRepo.review).toHaveBeenCalled();
    });

    describe('recommendedAction execution', () => {
      beforeEach(() => {
        reportRepo.getById.mockResolvedValue(PENDING_REPORT);
      });

      it('executes a WARNING recommendation via VideoRoomModerationService.warn', async () => {
        await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          recommendedAction: 'WARNING',
        });
        expect(moderation.warn).toHaveBeenCalledWith(
          MODERATOR,
          ROOM.id,
          TARGET,
          expect.stringContaining('[Report #report-1 review]'),
          undefined,
          undefined,
        );
      });

      it('executes a MUTE recommendation as a PERMANENT mute', async () => {
        await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          recommendedAction: 'MUTE',
        });
        expect(moderation.mute).toHaveBeenCalledWith(
          MODERATOR,
          ROOM.id,
          expect.objectContaining({ userId: TARGET, type: 'PERMANENT' }),
          undefined,
        );
      });

      it('executes a KICK recommendation', async () => {
        await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          recommendedAction: 'KICK',
        });
        expect(moderation.kick).toHaveBeenCalledWith(
          MODERATOR,
          ROOM.id,
          TARGET,
          expect.stringContaining('[Report #report-1 review]'),
          undefined,
        );
      });

      it('proposes a BAN recommendation for approval instead of executing it', async () => {
        await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          recommendedAction: 'BAN',
        });
        expect(approvalService.propose).toHaveBeenCalledWith(
          expect.objectContaining({
            roomType: 'VIDEO_ROOM',
            roomId: ROOM.id,
            reportId: 'report-1',
            proposedBy: MODERATOR.id,
            targetUserId: TARGET,
            reason: expect.stringContaining('[Report #report-1 review]'),
          }),
        );
        expect(moderation.blacklist).not.toHaveBeenCalled();
      });

      it('leaves a BAN recommendation unactioned when no approval service is wired', async () => {
        const noApprovalSubject = new VideoRoomReportService(
          reportRepo,
          rooms,
          roles,
          permissions,
          moderationRepo,
          metrics,
          queue,
          bus,
          moderation,
          scopeService as unknown as WorkforceScopeService,
        );
        await noApprovalSubject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.ACTIONED,
          recommendedAction: 'BAN',
        });
        expect(moderation.blacklist).not.toHaveBeenCalled();
        expect(approvalService.propose).not.toHaveBeenCalled();
      });

      it('executes nothing when no recommendedAction is given', async () => {
        await subject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.DISMISSED,
        });
        expect(moderation.warn).not.toHaveBeenCalled();
        expect(moderation.mute).not.toHaveBeenCalled();
        expect(moderation.kick).not.toHaveBeenCalled();
        expect(moderation.blacklist).not.toHaveBeenCalled();
      });
    });
  });

  // ======================= listReports =======================

  describe('listReports', () => {
    it('requires MANAGE_PARTICIPANTS', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(subject.listReports(MODERATOR, ROOM.id, query())).rejects.toThrow('forbidden');
      expect(reportRepo.list).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(subject.listReports(MODERATOR, ROOM.id, query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('returns the canonical paginated shape, filtered by targetUserId when given', async () => {
      reportRepo.list.mockResolvedValue([[{ id: 'r1' }], 1]);
      const result = await subject.listReports(
        MODERATOR,
        ROOM.id,
        query({ page: 2, limit: 10, skip: 10, targetUserId: TARGET }),
      );
      expect(reportRepo.list).toHaveBeenCalledWith(ROOM.id, {
        skip: 10,
        take: 10,
        targetUserId: TARGET,
      });
      expect(result).toEqual({
        items: [{ id: 'r1' }],
        total: 1,
        page: 2,
        limit: 10,
        totalPages: 1,
      });
    });

    // Deliberately unguarded (Task 9): this is a read. Hiding the existing
    // moderation queue just because new reports are disabled would be a
    // moderation regression, not a safety improvement.
    it('still lists reports when allowReporting is disabled', async () => {
      rooms.getSettings.mockResolvedValue({ allowReporting: false });
      reportRepo.list.mockResolvedValue([[{ id: 'r1' }], 1]);
      await expect(subject.listReports(MODERATOR, ROOM.id, query())).resolves.toEqual(
        expect.objectContaining({ items: [{ id: 'r1' }], total: 1 }),
      );
    });
  });

  // ======================= createSystemReport =======================

  describe('createSystemReport', () => {
    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(
        subject.createSystemReport(ROOM.id, TARGET, VideoRoomReportReason.SPAM),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND });
    });

    it('writes reporterId=SYSTEM_MODERATOR_ID, publishes, enqueues, and records metrics', async () => {
      const result = await subject.createSystemReport(ROOM.id, TARGET, VideoRoomReportReason.SPAM, {
        detector: 'spam',
        count: 5,
      });

      expect(reportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM.id,
          reporterId: SYSTEM_MODERATOR_ID,
          targetUserId: TARGET,
          reason: VideoRoomReportReason.SPAM,
        }),
      );
      expect(result.reporterId).toBe(SYSTEM_MODERATOR_ID);

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VIDEO_ROOM_MODERATION_EVENTS.REPORTED,
          payload: expect.objectContaining({
            roomId: ROOM.id,
            reporterId: SYSTEM_MODERATOR_ID,
            targetUserId: TARGET,
            reason: VideoRoomReportReason.SPAM,
          }),
        }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({ type: expect.any(String), roomId: ROOM.id }),
      );
      expect(metrics.incReport).toHaveBeenCalledWith(VideoRoomReportReason.SPAM);
    });

    // Deliberately unguarded (Task 9) — and the important exclusion of the
    // three: this is the path the automated moderation engine uses to file
    // reports on itself. If a room owner's user-facing "Allow Reporting"
    // switch could gate this too, flipping it off would silence the
    // auto-moderation engine in their own room — a room owner (or anyone
    // who can toggle a settings flag) using their own settings control to
    // blind safety detection is exactly the abuse vector this must never
    // allow. `createSystemReport` has no user-facing caller/actor at all;
    // only the auto-moderation engine invokes it directly.
    it('still files a system report when allowReporting is disabled', async () => {
      rooms.getSettings.mockResolvedValue({ allowReporting: false });
      const result = await subject.createSystemReport(ROOM.id, TARGET, VideoRoomReportReason.SPAM);
      expect(result.reporterId).toBe(SYSTEM_MODERATOR_ID);
      expect(reportRepo.create).toHaveBeenCalled();
    });
  });

  // ======================= region scope enforcement =======================

  describe('region scope enforcement', () => {
    let scopedScopeService: { assertModeratorInScope: jest.Mock };
    let scopedSubject: VideoRoomReportService;

    beforeEach(() => {
      // Reuses this file's shared fixtures, but with a room that DOES carry a
      // `region` (the outer `ROOM` fixture deliberately has none, so the
      // outer `subject`'s scope check never fires — see the comment above
      // its construction) and a fresh `scopeService` double so assertions
      // here don't interfere with the outer describe's tests.
      rooms.findById.mockResolvedValue({ ...ROOM, region: 'region-eu-west' });
      scopedScopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
      scopedSubject = new VideoRoomReportService(
        reportRepo,
        rooms,
        roles,
        permissions,
        moderationRepo,
        metrics,
        queue,
        bus,
        moderation,
        scopedScopeService as unknown as WorkforceScopeService,
        undefined,
        undefined,
        approvalService,
      );
    });

    it('reviewReport checks the room region', async () => {
      reportRepo.getById.mockResolvedValue({
        id: 'report-1',
        roomId: ROOM.id,
        status: VideoRoomReportStatus.PENDING,
        targetUserId: TARGET,
        createdAt: new Date(),
      });
      await scopedSubject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
        status: VideoRoomReportStatus.REVIEWED,
      } as any);
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR.id,
        'region-eu-west',
      );
    });

    it('reviewReport rejects a moderator outside scope', async () => {
      reportRepo.getById.mockResolvedValue({
        id: 'report-1',
        roomId: ROOM.id,
        status: VideoRoomReportStatus.PENDING,
        targetUserId: TARGET,
        createdAt: new Date(),
      });
      scopedScopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(
        scopedSubject.reviewReport(MODERATOR, ROOM.id, 'report-1', {
          status: VideoRoomReportStatus.REVIEWED,
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reportRepo.review).not.toHaveBeenCalled();
    });

    it('addReportNotes checks the room region', async () => {
      reportRepo.getById.mockResolvedValue({ id: 'report-1', roomId: ROOM.id });
      await scopedSubject.addReportNotes(MODERATOR, ROOM.id, 'report-1', 'notes');
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR.id,
        'region-eu-west',
      );
      expect(reportRepo.updateNotes).toHaveBeenCalledWith('report-1', MODERATOR.id, 'notes');
    });

    // The scope check authorizes the roomId in the URL. Without binding the
    // reportId to that same room, a moderator scoped to this room could pass
    // an out-of-scope room's reportId alongside it and mutate it unchecked.
    it('addReportNotes 404s when the report belongs to a different room', async () => {
      reportRepo.getById.mockResolvedValue({ id: 'report-1', roomId: 'other-room' });
      await expect(
        scopedSubject.addReportNotes(MODERATOR, ROOM.id, 'report-1', 'notes'),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
      expect(reportRepo.updateNotes).not.toHaveBeenCalled();
    });

    it('addReportNotes 404s when the report does not exist', async () => {
      reportRepo.getById.mockResolvedValue(null);
      await expect(
        scopedSubject.addReportNotes(MODERATOR, ROOM.id, 'missing', 'notes'),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
      expect(reportRepo.updateNotes).not.toHaveBeenCalled();
    });

    it('dismissReport checks the room region', async () => {
      reportRepo.getById.mockResolvedValue({
        id: 'report-1',
        roomId: ROOM.id,
        createdAt: new Date(),
      });
      await scopedSubject.dismissReport(MODERATOR, ROOM.id, 'report-1', 'reason');
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR.id,
        'region-eu-west',
      );
    });

    it('assignReport checks the room region', async () => {
      reportRepo.getById.mockResolvedValue({
        id: 'report-1',
        roomId: ROOM.id,
        status: VideoRoomReportStatus.PENDING,
      });
      await scopedSubject.assignReport(MODERATOR, ROOM.id, 'report-1', 'assignee-1');
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR.id,
        'region-eu-west',
      );
    });
  });
});
