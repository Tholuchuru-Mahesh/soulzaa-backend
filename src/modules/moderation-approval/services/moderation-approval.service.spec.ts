import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ModerationApprovalService } from './moderation-approval.service';

const APPROVAL_ID = 'approval-1';
const MODERATOR_ID = 'mod-1';
const OFFICIAL_ID = 'official-1';
const TARGET_ID = 'target-1';
const REPORT_ID = 'report-1';

const PENDING_ROW = {
  id: APPROVAL_ID,
  roomType: 'AUDIO_ROOM',
  roomId: 'room-1',
  liveStreamId: null,
  reportId: REPORT_ID,
  proposedBy: MODERATOR_ID,
  targetUserId: TARGET_ID,
  action: 'BAN',
  reason: 'harassment',
  status: 'PENDING',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
};

describe('ModerationApprovalService', () => {
  let prisma: any;
  let scopeService: any;
  let notifications: any;
  let bus: any;
  let service: ModerationApprovalService;

  beforeEach(() => {
    prisma = {
      moderationActionApproval: {
        create: jest.fn().mockResolvedValue({ ...PENDING_ROW }),
        findUnique: jest.fn().mockResolvedValue({ ...PENDING_ROW }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ ...PENDING_ROW, ...data })),
      },
      // PENDING_ROW is an AUDIO_ROOM with a non-null roomId, so decide()'s
      // resolveOwnerId() hits this by default for every decide test that
      // doesn't override roomType/roomId. Individual tests replace this
      // stub when they need a specific owner or a vanished-room case.
      audioRoom: { findUnique: jest.fn().mockResolvedValue({ ownerId: null }) },
    };
    scopeService = {
      resolveEscalationRecipients: jest.fn().mockResolvedValue([OFFICIAL_ID]),
      assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new ModerationApprovalService(prisma, scopeService, notifications, bus);
  });

  describe('propose', () => {
    it('creates a PENDING row', async () => {
      await service.propose({
        roomType: 'AUDIO_ROOM',
        roomId: 'room-1',
        reportId: REPORT_ID,
        proposedBy: MODERATOR_ID,
        targetUserId: TARGET_ID,
        reason: 'harassment',
        ownerId: 'owner-1',
      });
      expect(prisma.moderationActionApproval.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            roomType: 'AUDIO_ROOM',
            roomId: 'room-1',
            reportId: REPORT_ID,
            proposedBy: MODERATOR_ID,
            targetUserId: TARGET_ID,
            status: 'PENDING',
          }),
        }),
      );
    });

    it("routes to the Official(s) covering the owner's territory via HIGH-severity escalation recipients", async () => {
      await service.propose({
        roomType: 'AUDIO_ROOM',
        roomId: 'room-1',
        reportId: REPORT_ID,
        proposedBy: MODERATOR_ID,
        targetUserId: TARGET_ID,
        ownerId: 'owner-1',
      });
      expect(scopeService.resolveEscalationRecipients).toHaveBeenCalledWith('HIGH', 'owner-1');
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OFFICIAL_ID,
          type: 'MODERATION_CASE_ESCALATED',
          actorId: MODERATOR_ID,
        }),
      );
    });

    it('does not attempt notification dispatch when notifications is not wired', async () => {
      // scopeService is now a required constructor dependency (no longer @Optional());
      // this test still exercises propose()'s `if (this.notifications)` guard on its own.
      const bareService = new ModerationApprovalService(prisma, scopeService);
      await bareService.propose({
        roomType: 'AUDIO_ROOM',
        roomId: 'room-1',
        reportId: REPORT_ID,
        proposedBy: MODERATOR_ID,
        targetUserId: TARGET_ID,
      });
      expect(scopeService.resolveEscalationRecipients).not.toHaveBeenCalled();
    });
  });

  describe('decide', () => {
    it('throws NotFoundException for an unknown approval', async () => {
      prisma.moderationActionApproval.findUnique.mockResolvedValue(null);
      await expect(service.decide('missing', OFFICIAL_ID, 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to re-decide an already-decided approval', async () => {
      prisma.moderationActionApproval.findUnique.mockResolvedValue({
        ...PENDING_ROW,
        status: 'APPROVED',
      });
      await expect(service.decide(APPROVAL_ID, OFFICIAL_ID, 'APPROVED')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('on APPROVED, flips status and publishes ModerationActionApprovedEvent', async () => {
      await service.decide(APPROVAL_ID, OFFICIAL_ID, 'APPROVED', 'looks right');

      expect(prisma.moderationActionApproval.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: APPROVAL_ID },
          data: expect.objectContaining({
            status: 'APPROVED',
            decidedBy: OFFICIAL_ID,
            decisionNote: 'looks right',
          }),
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'moderation.action_approval.approved',
          payload: expect.objectContaining({
            approvalId: APPROVAL_ID,
            roomType: 'AUDIO_ROOM',
            targetUserId: TARGET_ID,
            decidedBy: OFFICIAL_ID,
          }),
        }),
      );
    });

    it('on REJECTED, publishes ModerationActionRejectedEvent instead', async () => {
      await service.decide(APPROVAL_ID, OFFICIAL_ID, 'REJECTED');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'moderation.action_approval.rejected' }),
      );
    });

    it('notifies the proposing moderator of the decision', async () => {
      await service.decide(APPROVAL_ID, OFFICIAL_ID, 'REJECTED', 'insufficient evidence');
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MODERATOR_ID,
          actorId: OFFICIAL_ID,
          data: expect.objectContaining({ decision: 'REJECTED', note: 'insufficient evidence' }),
        }),
      );
    });

    it('resolves the owner from the audio room and checks the decider is in scope', async () => {
      prisma.audioRoom = { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-eu-west' }) };
      await service.decide('approval-1', 'official-1', 'APPROVED');
      expect(prisma.audioRoom.findUnique).toHaveBeenCalledWith({ where: { id: 'room-1' }, select: { ownerId: true } });
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('official-1', 'owner-eu-west');
    });

    it('resolves the owner from the live stream when roomType is LIVE_STREAM', async () => {
      prisma.moderationActionApproval.findUnique.mockResolvedValue({
        ...PENDING_ROW,
        roomType: 'LIVE_STREAM',
        roomId: null,
        liveStreamId: 'stream-1',
      });
      prisma.liveStream = { findUnique: jest.fn().mockResolvedValue({ hostId: 'owner-eu-west' }) };
      await service.decide('approval-1', 'official-1', 'APPROVED');
      expect(prisma.liveStream.findUnique).toHaveBeenCalledWith({ where: { id: 'stream-1' }, select: { hostId: true } });
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('official-1', 'owner-eu-west');
    });

    it("rejects an Official deciding outside the owner's assigned scope", async () => {
      prisma.audioRoom = { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-eu-west' }) };
      scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(service.decide('approval-1', 'official-1', 'APPROVED')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.moderationActionApproval.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the room referenced by a non-null roomId no longer exists', async () => {
      // PENDING_ROW.roomId stays 'room-1' (proving the resource existed at propose() time),
      // but the lookup now resolves null — a vanished row, not a legitimately-unscoped one.
      // This must NOT silently fall through to assertModeratorInScope(deciderId, null) (permit).
      prisma.audioRoom = { findUnique: jest.fn().mockResolvedValue(null) };
      await expect(service.decide('approval-1', 'official-1', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scopeService.assertModeratorInScope).not.toHaveBeenCalled();
      expect(prisma.moderationActionApproval.update).not.toHaveBeenCalled();
    });
  });

  describe('listPending', () => {
    it('filters to PENDING status, optionally scoped by roomType', async () => {
      await service.listPending('VIDEO_ROOM' as any);
      expect(prisma.moderationActionApproval.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING', roomType: 'VIDEO_ROOM' } }),
      );
    });
  });
});
