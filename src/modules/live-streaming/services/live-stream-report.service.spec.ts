import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LiveStreamReportReason, LiveStreamReportStatus, PlatformRole } from '@prisma/client';
import type { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { LiveStreamReportService } from './live-stream-report.service';

const STREAM_ID = 'stream-1';
const REPORTER_ID = 'reporter-1';
const TARGET_ID = 'target-1';
const MODERATOR_ID = 'mod-1';
const REPORT_ID = 'report-1';
const MODERATOR_ROLES: PlatformRole[] = [PlatformRole.MODERATOR];

const PENDING_REPORT = {
  id: REPORT_ID,
  streamId: STREAM_ID,
  reporterId: REPORTER_ID,
  targetUserId: TARGET_ID,
  reason: LiveStreamReportReason.HARASSMENT,
  status: LiveStreamReportStatus.PENDING,
  createdAt: new Date('2026-08-14T00:00:00Z'),
};

describe('LiveStreamReportService', () => {
  let reportRepo: any;
  let liveStream: any;
  let scopeService: { assertModeratorInScope: jest.Mock; resolveModeratorsInScope: jest.Mock };
  let performanceStats: any;
  let auditLog: any;
  let service: LiveStreamReportService;

  beforeEach(() => {
    reportRepo = {
      findOpenReport: jest.fn().mockResolvedValue(null),
      createReport: jest.fn().mockResolvedValue({ ...PENDING_REPORT }),
      getReport: jest.fn().mockResolvedValue(PENDING_REPORT),
      reviewReport: jest.fn().mockResolvedValue(undefined),
      addNotes: jest.fn().mockResolvedValue(undefined),
      listReports: jest.fn().mockResolvedValue([[], 0]),
    };
    liveStream = {
      // No `hostId` here by default, so `stream?.hostId ?? null` is null
      // for every pre-existing test in this file and the scope check never
      // actually fires — this mock exists only to satisfy the now-required
      // constructor parameter. See the "owner scope enforcement" describe
      // below for the tests that exercise a stream carrying a hostId.
      getStream: jest.fn().mockResolvedValue({ id: STREAM_ID }),
      moderateUser: jest.fn().mockResolvedValue({}),
    };
    scopeService = {
      assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
      resolveModeratorsInScope: jest.fn().mockResolvedValue([]),
    };
    performanceStats = {
      recordAction: jest.fn().mockResolvedValue(undefined),
      recordReportResolution: jest.fn().mockResolvedValue(undefined),
    };
    auditLog = { logAction: jest.fn().mockResolvedValue(undefined) };
    service = new LiveStreamReportService(
      reportRepo,
      liveStream,
      scopeService as any,
      performanceStats,
      auditLog,
    );
  });

  describe('fileReport', () => {
    it('creates a report against another viewer', async () => {
      await service.fileReport({
        streamId: STREAM_ID,
        reporterId: REPORTER_ID,
        targetUserId: TARGET_ID,
        reason: LiveStreamReportReason.SPAM,
      });
      expect(reportRepo.createReport).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: STREAM_ID,
          reporterId: REPORTER_ID,
          targetUserId: TARGET_ID,
        }),
      );
    });

    it('rejects a self-report', async () => {
      await expect(
        service.fileReport({
          streamId: STREAM_ID,
          reporterId: REPORTER_ID,
          targetUserId: REPORTER_ID,
          reason: LiveStreamReportReason.SPAM,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reportRepo.createReport).not.toHaveBeenCalled();
    });

    it('rejects a duplicate open report against the same target', async () => {
      reportRepo.findOpenReport.mockResolvedValue({ id: 'existing' });
      await expect(
        service.fileReport({
          streamId: STREAM_ID,
          reporterId: REPORTER_ID,
          targetUserId: TARGET_ID,
          reason: LiveStreamReportReason.SPAM,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reviewReport', () => {
    // Audio's ModerationService.reviewReport gates on assertCanModerate and
    // video's on REVIEW_REPORTS; live-stream never got the equivalent, so a
    // caller who could reach the moderator-portal report queue without
    // moderator authority could drive a report decision here.
    describe('actor role authorization', () => {
      it.each([[PlatformRole.OFFICIAL], [PlatformRole.COUNTRY_MANAGER]])(
        'rejects an actor holding only %s',
        async (role) => {
          await expect(
            service.reviewReport({
              streamId: STREAM_ID,
              reportId: REPORT_ID,
              moderatorId: MODERATOR_ID,
              status: LiveStreamReportStatus.DISMISSED,
              actorRoles: [role],
            }),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(reportRepo.reviewReport).not.toHaveBeenCalled();
        },
      );

      it('rejects an actor with no roles at all with 403, not a TypeError', async () => {
        await expect(
          service.reviewReport({
            streamId: STREAM_ID,
            reportId: REPORT_ID,
            moderatorId: MODERATOR_ID,
            status: LiveStreamReportStatus.DISMISSED,
            actorRoles: undefined as unknown as PlatformRole[],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it.each([[PlatformRole.MODERATOR], [PlatformRole.ADMIN], [PlatformRole.SUPER_ADMIN]])(
        'allows an actor holding %s',
        async (role) => {
          await service.reviewReport({
            streamId: STREAM_ID,
            reportId: REPORT_ID,
            moderatorId: MODERATOR_ID,
            status: LiveStreamReportStatus.DISMISSED,
            actorRoles: [role],
          });
          expect(reportRepo.reviewReport).toHaveBeenCalledWith(
            REPORT_ID,
            MODERATOR_ID,
            LiveStreamReportStatus.DISMISSED,
            null,
          );
        },
      );
    });

    it('records the review without acting when no action is recommended', async () => {
      await service.reviewReport({
        streamId: STREAM_ID,
        reportId: REPORT_ID,
        moderatorId: MODERATOR_ID,
        actorRoles: MODERATOR_ROLES,
        status: LiveStreamReportStatus.DISMISSED,
      });
      expect(reportRepo.reviewReport).toHaveBeenCalledWith(
        REPORT_ID,
        MODERATOR_ID,
        LiveStreamReportStatus.DISMISSED,
        null,
      );
      expect(liveStream.moderateUser).not.toHaveBeenCalled();
      expect(performanceStats.recordReportResolution).toHaveBeenCalledWith(
        MODERATOR_ID,
        expect.any(Number),
      );
    });

    it('executes the recommended action immediately, tagged as a report-review decision', async () => {
      await service.reviewReport({
        streamId: STREAM_ID,
        reportId: REPORT_ID,
        moderatorId: MODERATOR_ID,
        actorRoles: MODERATOR_ROLES,
        status: LiveStreamReportStatus.ACTIONED,
        recommendedAction: 'MUTE',
        resolution: 'confirmed spam',
      });
      expect(liveStream.moderateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: STREAM_ID,
          moderatorId: MODERATOR_ID,
          targetUserId: TARGET_ID,
          action: 'MUTE',
          reason: `[Report #${REPORT_ID} review] confirmed spam`,
        }),
      );
    });

    describe('BAN recommendation goes through approval', () => {
      let approvalService: { propose: jest.Mock };
      let approvingService: LiveStreamReportService;

      beforeEach(() => {
        approvalService = { propose: jest.fn().mockResolvedValue({ id: 'approval-1' }) };
        liveStream.getStream.mockResolvedValue({ id: STREAM_ID, hostId: 'host-eu-west' });
        approvingService = new LiveStreamReportService(
          reportRepo,
          liveStream,
          scopeService as any,
          performanceStats,
          auditLog,
          undefined,
          approvalService as any,
        );
      });

      it('proposes the ban for approval instead of executing it', async () => {
        await approvingService.reviewReport({
          streamId: STREAM_ID,
          reportId: REPORT_ID,
          moderatorId: MODERATOR_ID,
          actorRoles: MODERATOR_ROLES,
          status: LiveStreamReportStatus.ACTIONED,
          recommendedAction: 'BAN',
          resolution: 'confirmed harassment',
        });

        expect(approvalService.propose).toHaveBeenCalledWith(
          expect.objectContaining({
            roomType: 'LIVE_STREAM',
            liveStreamId: STREAM_ID,
            reportId: REPORT_ID,
            proposedBy: MODERATOR_ID,
            targetUserId: TARGET_ID,
            ownerId: 'host-eu-west',
          }),
        );
        expect(liveStream.moderateUser).not.toHaveBeenCalled();
      });

      it('leaves the recommendation unactioned when no approval service is wired', async () => {
        await service.reviewReport({
          streamId: STREAM_ID,
          reportId: REPORT_ID,
          moderatorId: MODERATOR_ID,
          actorRoles: MODERATOR_ROLES,
          status: LiveStreamReportStatus.ACTIONED,
          recommendedAction: 'BAN',
        });
        expect(liveStream.moderateUser).not.toHaveBeenCalled();
      });
    });

    it('throws when the report does not exist', async () => {
      reportRepo.getReport.mockResolvedValue(null);
      await expect(
        service.reviewReport({
          streamId: STREAM_ID,
          reportId: 'missing',
          moderatorId: MODERATOR_ID,
          actorRoles: MODERATOR_ROLES,
          status: LiveStreamReportStatus.DISMISSED,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to review an already-decided report', async () => {
      reportRepo.getReport.mockResolvedValue({
        ...PENDING_REPORT,
        status: LiveStreamReportStatus.REVIEWED,
      });
      await expect(
        service.reviewReport({
          streamId: STREAM_ID,
          reportId: REPORT_ID,
          moderatorId: MODERATOR_ID,
          actorRoles: MODERATOR_ROLES,
          status: LiveStreamReportStatus.DISMISSED,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('addNotes', () => {
    it('attaches investigation notes to an existing report', async () => {
      await service.addNotes(STREAM_ID, REPORT_ID, MODERATOR_ID, 'checked chat logs, confirmed');
      expect(reportRepo.addNotes).toHaveBeenCalledWith(REPORT_ID, 'checked chat logs, confirmed');
    });

    it('throws when the report belongs to a different stream', async () => {
      reportRepo.getReport.mockResolvedValue({ ...PENDING_REPORT, streamId: 'other-stream' });
      await expect(
        service.addNotes(STREAM_ID, REPORT_ID, MODERATOR_ID, 'note'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ======================= owner scope enforcement =======================

  describe('owner scope enforcement', () => {
    let scopedScopeService: {
      assertModeratorInScope: jest.Mock;
      resolveModeratorsInScope: jest.Mock;
    };
    let scopedService: LiveStreamReportService;

    beforeEach(() => {
      // Reuses this file's shared fixtures, but with a stream that DOES carry
      // a `hostId` (the outer `liveStream` fixture deliberately has none,
      // so the outer `service`'s scope check never actually fires against a
      // real owner — see the comment above its construction) and a fresh
      // `scopeService` double so assertions here don't interfere with the
      // outer describe's tests.
      liveStream.getStream.mockResolvedValue({ id: STREAM_ID, hostId: 'host-eu-west' });
      scopedScopeService = {
        assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
        resolveModeratorsInScope: jest.fn().mockResolvedValue([]),
      };
      scopedService = new LiveStreamReportService(
        reportRepo,
        liveStream,
        scopedScopeService as unknown as WorkforceScopeService,
        performanceStats,
        auditLog,
      );
    });

    it('reviewReport checks the stream owner', async () => {
      reportRepo.getReport.mockResolvedValue({ ...PENDING_REPORT });
      await scopedService.reviewReport({
        streamId: STREAM_ID,
        reportId: REPORT_ID,
        moderatorId: MODERATOR_ID,
        actorRoles: MODERATOR_ROLES,
        status: LiveStreamReportStatus.REVIEWED,
      } as any);
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR_ID,
        'host-eu-west',
      );
    });

    it('reviewReport rejects a moderator outside scope', async () => {
      reportRepo.getReport.mockResolvedValue({ ...PENDING_REPORT });
      scopedScopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(
        scopedService.reviewReport({
          streamId: STREAM_ID,
          reportId: REPORT_ID,
          moderatorId: MODERATOR_ID,
          actorRoles: MODERATOR_ROLES,
          status: LiveStreamReportStatus.REVIEWED,
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reportRepo.reviewReport).not.toHaveBeenCalled();
    });

    it('addNotes checks the stream owner', async () => {
      reportRepo.getReport.mockResolvedValue({ id: REPORT_ID, streamId: STREAM_ID });
      await scopedService.addNotes(STREAM_ID, REPORT_ID, MODERATOR_ID, 'notes');
      expect(scopedScopeService.assertModeratorInScope).toHaveBeenCalledWith(
        MODERATOR_ID,
        'host-eu-west',
      );
    });

    it('addNotes rejects a moderator outside scope', async () => {
      reportRepo.getReport.mockResolvedValue({ id: REPORT_ID, streamId: STREAM_ID });
      scopedScopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(
        scopedService.addNotes(STREAM_ID, REPORT_ID, MODERATOR_ID, 'notes'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reportRepo.addNotes).not.toHaveBeenCalled();
    });
  });
});
