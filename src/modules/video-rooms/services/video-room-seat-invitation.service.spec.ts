import { HttpStatus } from '@nestjs/common';
import { VideoRoomInvitationStatus, VideoRoomInvitationType } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomSeatInvitationService } from './video-room-seat-invitation.service';

const actor = (id: string) => ({ id, roles: [] as never[] });

describe('VideoRoomSeatInvitationService', () => {
  let deps: any;
  let svc: VideoRoomSeatInvitationService;

  beforeEach(() => {
    deps = {
      seatSvc: {
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }),
        seatUser: jest.fn().mockResolvedValue({ roomId: 'r1', version: 4, seats: [] }),
        findOpenSeat: jest.fn().mockResolvedValue(3),
      },
      seats: {
        listPendingInvitations: jest.fn().mockResolvedValue([]),
        createInvitation: jest.fn().mockResolvedValue({
          id: 'i1',
          inviterId: 'owner',
          inviteeUserId: 'u2',
          type: 'SEAT',
          seatIndex: 3,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 120_000),
        }),
        findInvitationById: jest.fn(),
        // I6 — the CAS path treats a falsy return as "lost the race", so the
        // default double as a real repository would: succeed and echo the row.
        setInvitationStatus: jest
          .fn()
          .mockImplementation((id: string, status: VideoRoomInvitationStatus) =>
            Promise.resolve({ id, status }),
          ),
        findOccupiedSeat: jest.fn().mockResolvedValue(null),
        findSeat: jest
          .fn()
          .mockResolvedValue({ seatIndex: 3, isLocked: false, seatStatus: 'EMPTY' }),
        findActiveRoomInvitation: jest.fn().mockResolvedValue(null),
      },
      permissions: { assertPermission: jest.fn() },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
      moderation: { isActivelyBlocked: jest.fn().mockResolvedValue(false) },
      rooms: {
        getMember: jest.fn().mockResolvedValue({ isActive: true }),
        // VR-17 — default to the column's own DB default so every pre-existing
        // test (which knows nothing about allowInvite) keeps passing.
        getSettings: jest.fn().mockResolvedValue({ allowInvite: true }),
        // Mirrors `getSettings` by default (delegates to it) so every test that
        // overrides `getSettings` to steer `allowInvite` keeps working now that
        // the service reads `requireSettings` instead; tests targeting the
        // missing-row path override this mock directly.
        requireSettings: jest.fn(),
      },
    };
    deps.rooms.requireSettings.mockImplementation(async () => {
      const row = await deps.rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    svc = new VideoRoomSeatInvitationService(
      deps.seatSvc,
      deps.seats,
      deps.permissions,
      deps.events,
      deps.bus,
      deps.moderation,
      deps.rooms,
    );
  });

  const pub = () => deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);
  const publishedPayload = (name: string) =>
    deps.bus.publish.mock.calls.find((c: any[]) => c[0].constructor.name === name)?.[0].payload;

  describe('invite', () => {
    it('requires INVITE_USERS, creates the invitation, publishes', async () => {
      await svc.invite(actor('owner'), 'r1', 'u2', 3);
      expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'INVITE_USERS',
      );
      expect(deps.seats.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'r1',
          inviterId: 'owner',
          inviteeUserId: 'u2',
          seatIndex: 3,
        }),
        'owner',
      );
      expect(pub()).toContain('SeatInvitationSentEvent');
    });

    it('rejects a duplicate pending invitation for the same seat', async () => {
      deps.seats.listPendingInvitations.mockResolvedValue([{ seatIndex: 3 }]);
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.DUPLICATE_SEAT_INVITATION,
      });
    });
  });

  describe('invite validations (VR-8)', () => {
    it('refuses a target who is not an active member', async () => {
      deps.rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('refuses a target already holding a seat', async () => {
      deps.seats.findOccupiedSeat.mockResolvedValue({ seatIndex: 1 });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.ALREADY_ON_SEAT,
      });
    });

    it('refuses a target blocked from the room', async () => {
      deps.moderation.isActivelyBlocked.mockResolvedValue(true);
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
      });
    });

    it('refuses an invitation onto a locked seat', async () => {
      deps.seats.findSeat.mockResolvedValue({ seatIndex: 3, isLocked: true, seatStatus: 'EMPTY' });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_LOCKED,
      });
    });

    it('refuses an invitation onto a reserved seat', async () => {
      deps.seats.findSeat.mockResolvedValue({
        seatIndex: 3,
        isLocked: false,
        seatStatus: 'RESERVED',
      });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_RESERVED,
      });
    });

    it('refuses an invitation onto an occupied seat', async () => {
      deps.seats.findSeat.mockResolvedValue({
        seatIndex: 3,
        isLocked: false,
        seatStatus: 'OCCUPIED',
      });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_TAKEN,
      });
    });

    it('refuses an invitation onto a seat that does not exist', async () => {
      deps.seats.findSeat.mockResolvedValue(null);
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_NOT_FOUND,
      });
    });

    it('sends the invitation when every check passes', async () => {
      const view = await svc.invite(actor('owner'), 'r1', 'u2', 3);
      expect(view.id).toBe('i1');
      expect(deps.seats.createInvitation).toHaveBeenCalled();
    });

    it('skips the seat-specific checks when no seatIndex is given', async () => {
      await svc.invite(actor('owner'), 'r1', 'u2');
      expect(deps.seats.findSeat).not.toHaveBeenCalled();
      expect(deps.seats.createInvitation).toHaveBeenCalled();
    });
  });

  describe('invite policy gate (VR-17 allowInvite)', () => {
    it('refuses a seat invite when allowInvite is disabled', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: false });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(deps.seats.createInvitation).not.toHaveBeenCalled();
    });

    it('allows a seat invite when allowInvite is enabled', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: true });
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).resolves.toBeDefined();
    });

    it('checks INVITE_USERS permission before the allowInvite policy gate', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: false });
      deps.permissions.assertPermission.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
          'no permission',
          HttpStatus.FORBIDDEN,
        ),
      );
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(deps.rooms.requireSettings).not.toHaveBeenCalled();
    });

    // Guard hardening: a missing settings row must NOT read as "allowed".
    it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
      deps.rooms.requireSettings.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
      await expect(svc.invite(actor('owner'), 'r1', 'u2', 3)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
      });
    });
  });

  describe('inviteToRoom (VR-15)', () => {
    beforeEach(() => {
      // The invitee is a NON-member for a room invitation — unlike seat invites.
      deps.rooms.getMember.mockResolvedValue({ isActive: false });
      deps.seats.createInvitation.mockResolvedValue({
        id: 'i1',
        inviterId: 'owner',
        inviteeUserId: 'u2',
        type: 'ROOM',
        seatIndex: null,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 120_000),
      });
    });

    it('creates a ROOM invitation with seatIndex null and publishes a ROOM-typed event', async () => {
      const view = await svc.inviteToRoom(actor('owner'), 'r1', 'u2');
      expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'INVITE_USERS',
      );
      expect(deps.seats.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'r1',
          inviterId: 'owner',
          inviteeUserId: 'u2',
          type: VideoRoomInvitationType.ROOM,
          seatIndex: null,
        }),
        'owner',
      );
      expect(pub()).toContain('SeatInvitationSentEvent');
      expect(publishedPayload('SeatInvitationSentEvent')).toMatchObject({ type: 'ROOM' });
      expect(view.id).toBe('i1');
    });

    it('rejects when the invitee is already an active member', async () => {
      deps.rooms.getMember.mockResolvedValue({ isActive: true });
      await expect(svc.inviteToRoom(actor('owner'), 'r1', 'u2')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
      expect(deps.seats.createInvitation).not.toHaveBeenCalled();
    });

    it('rejects a duplicate outstanding room invitation for the same invitee', async () => {
      deps.seats.findActiveRoomInvitation.mockResolvedValue({ id: 'existing' });
      await expect(svc.inviteToRoom(actor('owner'), 'r1', 'u2')).rejects.toMatchObject({
        errorCode: ERROR_CODES.DUPLICATE_SEAT_INVITATION,
      });
      expect(deps.seats.createInvitation).not.toHaveBeenCalled();
    });
  });

  describe('inviteToRoom policy gate (VR-17 allowInvite)', () => {
    beforeEach(() => {
      deps.rooms.getMember.mockResolvedValue({ isActive: false });
      deps.seats.createInvitation.mockResolvedValue({
        id: 'i1',
        inviterId: 'owner',
        inviteeUserId: 'u2',
        type: 'ROOM',
        seatIndex: null,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 120_000),
      });
    });

    it('refuses a room invite when allowInvite is disabled', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: false });
      await expect(svc.inviteToRoom(actor('owner'), 'r1', 'u2')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(deps.seats.createInvitation).not.toHaveBeenCalled();
    });

    it('allows a room invite when allowInvite is enabled', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: true });
      await expect(svc.inviteToRoom(actor('owner'), 'r1', 'u2')).resolves.toBeDefined();
    });

    it('checks INVITE_USERS permission before the allowInvite policy gate', async () => {
      deps.rooms.getSettings.mockResolvedValue({ allowInvite: false });
      deps.permissions.assertPermission.mockRejectedValue(
        new BusinessException(
          ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
          'no permission',
          HttpStatus.FORBIDDEN,
        ),
      );
      await expect(svc.inviteToRoom(actor('owner'), 'r1', 'u2')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(deps.rooms.requireSettings).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('seats the invitee and marks ACCEPTED', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        seatIndex: 3,
        status: VideoRoomInvitationStatus.PENDING,
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.accept(actor('u2'), 'r1', 'i1');
      expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r1', 'u2', 'u2', 3, undefined);
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.ACCEPTED,
        'u2',
        expect.objectContaining({ bumpAttempt: true, lastError: null }),
      );
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        status: 'ACCEPTED',
      });
      // VR-6 parity — accepting an invitation promotes the invitee to speaker:
      // the same ViewerPromotedEvent the host force-seat path emits must fire.
      expect(pub()).toContain('ViewerPromotedEvent');
      expect(publishedPayload('ViewerPromotedEvent')).toMatchObject({
        roomId: 'r1',
        userId: 'u2',
        seatIndex: 3,
        actorId: 'u2',
      });
    });

    it('rejects a non-invitee (FORBIDDEN)', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        seatIndex: 3,
        status: VideoRoomInvitationStatus.PENDING,
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.accept(actor('intruder'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('rejects an expired invitation (SEAT_INVITATION_EXPIRED)', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        seatIndex: 3,
        status: VideoRoomInvitationStatus.PENDING,
        attemptCount: 0,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_INVITATION_EXPIRED,
      });
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.EXPIRED,
        'u2',
      );
    });
  });

  describe('accept failure path (VR-8)', () => {
    beforeEach(() => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        seatIndex: 3,
        status: 'DELIVERED',
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
    });

    it('marks the invitation FAILED and rethrows when seating throws a business error', async () => {
      deps.seatSvc.seatUser.mockRejectedValue(
        new BusinessException(ERROR_CODES.SEAT_TAKEN, 'seat taken', HttpStatus.CONFLICT),
      );
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).rejects.toThrow('seat taken');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        'FAILED',
        'u2',
        expect.objectContaining({ bumpAttempt: true, lastError: 'seat taken' }),
      );
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        status: 'FAILED',
      });
      // A failed seating is NOT a promotion — no viewer_promoted signal.
      expect(pub()).not.toContain('ViewerPromotedEvent');
    });

    it('accepts from DELIVERED just as it does from PENDING', async () => {
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).resolves.toBeDefined();
    });

    // Fix 4: a transient infra error (lock-acquisition failure, Redis/Postgres
    // blip) must not burn the invitation's 3-attempt budget — only a genuine
    // BusinessException counts as a failed attempt.
    it('rethrows a non-business error WITHOUT marking FAILED, bumping the attempt count, or publishing a resolution', async () => {
      const infraError = new Error('ECONNREFUSED');
      deps.seatSvc.seatUser.mockRejectedValue(infraError);
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).rejects.toBe(infraError);
      expect(deps.seats.setInvitationStatus).not.toHaveBeenCalledWith(
        'i1',
        'FAILED',
        expect.anything(),
        expect.anything(),
      );
      expect(pub()).not.toContain('SeatInvitationResolvedEvent');
      // ...and therefore no promotion signal either.
      expect(pub()).not.toContain('ViewerPromotedEvent');
    });
  });

  describe('reject', () => {
    it('rejects an invitation and publishes REJECTED', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.reject(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.REJECTED,
        'u2',
      );
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        status: 'REJECTED',
      });
    });

    it('works from DELIVERED just as it does from PENDING', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: VideoRoomInvitationStatus.DELIVERED,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.reject(actor('u2'), 'r1', 'i1')).resolves.toBeUndefined();
    });
  });

  describe('seat path rejects ROOM invitations (VR-15 cross-path guard)', () => {
    const roomInv = {
      id: 'i1',
      roomId: 'r1',
      inviteeUserId: 'u2',
      type: VideoRoomInvitationType.ROOM,
      seatIndex: null,
      status: VideoRoomInvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('accept() refuses a ROOM invitation (must use the room-invite endpoints)', async () => {
      deps.seats.findInvitationById.mockResolvedValue({ ...roomInv });
      await expect(svc.accept(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
      expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
    });

    it('reject() refuses a ROOM invitation', async () => {
      deps.seats.findInvitationById.mockResolvedValue({ ...roomInv });
      await expect(svc.reject(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
      expect(deps.seats.setInvitationStatus).not.toHaveBeenCalled();
    });
  });

  describe('acceptRoomInvite (VR-15)', () => {
    it('marks the room invitation ACCEPTED and publishes ACCEPTED (no seating)', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.ROOM,
        seatIndex: null,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.acceptRoomInvite(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.ACCEPTED,
        'u2',
        expect.objectContaining({ bumpAttempt: true, lastError: null }),
      );
      expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        inviteeUserId: 'u2',
        status: 'ACCEPTED',
      });
    });

    it('rejects a non-invitee', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.ROOM,
        seatIndex: null,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.acceptRoomInvite(actor('intruder'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('rejects a non-ROOM (SEAT) invitation', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.SEAT,
        seatIndex: 3,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.acceptRoomInvite(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
    });
  });

  describe('rejectRoomInvite (VR-15)', () => {
    it('marks the room invitation REJECTED', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.ROOM,
        seatIndex: null,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.rejectRoomInvite(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.REJECTED,
        'u2',
      );
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        status: 'REJECTED',
      });
    });

    it('rejects a non-invitee', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.ROOM,
        seatIndex: null,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.rejectRoomInvite(actor('intruder'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('rejects a non-ROOM (SEAT) invitation', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        type: VideoRoomInvitationType.SEAT,
        seatIndex: 3,
        status: VideoRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.rejectRoomInvite(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_STATE,
      });
    });
  });

  describe('cancel', () => {
    it('works from DELIVERED just as it does from PENDING', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: VideoRoomInvitationStatus.DELIVERED,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.cancel(actor('owner'), 'r1', 'i1')).resolves.toBeUndefined();
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        VideoRoomInvitationStatus.CANCELLED,
        'owner',
      );
      expect(pub()).toContain('SeatInvitationResolvedEvent');
      expect(publishedPayload('SeatInvitationResolvedEvent')).toMatchObject({
        invitationId: 'i1',
        status: 'CANCELLED',
      });
    });
  });

  describe('acknowledge', () => {
    beforeEach(() => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      });
      deps.seats.setInvitationStatus.mockResolvedValue({
        id: 'i1',
        inviterId: 'owner',
        inviteeUserId: 'u2',
        type: 'SEAT',
        seatIndex: 3,
        status: 'DELIVERED',
        expiresAt: new Date(),
      });
    });

    it('marks the invitation DELIVERED and stamps the time', async () => {
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        'DELIVERED',
        'u2',
        expect.objectContaining({ deliveredAt: expect.any(Date) }),
      );
    });

    it('publishes a delivered event', async () => {
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.seat_invitation_delivered' }),
      );
    });

    it('lets only the invitee acknowledge', async () => {
      await expect(svc.acknowledge(actor('someone-else'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('is idempotent — re-acking an already DELIVERED invitation is a no-op', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: 'DELIVERED',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await svc.acknowledge(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).not.toHaveBeenCalled();
      expect(deps.bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('refuses to retry an invitation that is not FAILED', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: 'PENDING',
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.retry(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
      });
    });

    it('refuses once the attempt budget is exhausted', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: 'FAILED',
        attemptCount: 3,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.retry(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_RETRY_EXHAUSTED,
      });
    });

    it('refuses a non-invitee', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        status: 'FAILED',
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.retry(actor('intruder'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('flips a FAILED invitation back to PENDING and re-attempts seating', async () => {
      deps.seats.findInvitationById
        .mockResolvedValueOnce({
          id: 'i1',
          roomId: 'r1',
          inviteeUserId: 'u2',
          seatIndex: 3,
          status: 'FAILED',
          attemptCount: 1,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .mockResolvedValueOnce({
          id: 'i1',
          roomId: 'r1',
          inviteeUserId: 'u2',
          seatIndex: 3,
          status: 'PENDING',
          attemptCount: 1,
          expiresAt: new Date(Date.now() + 60_000),
        });
      const view = await svc.retry(actor('u2'), 'r1', 'i1');
      expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
        'i1',
        'PENDING',
        'u2',
        expect.objectContaining({ lastError: null }),
      );
      expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r1', 'u2', 'u2', 3, undefined);
      expect(view).toBeDefined();
    });

    // I6 — two concurrent retries of the same FAILED invitation (a
    // double-click/duplicate-submit — retry is invitee-only, so this is one
    // actor racing themselves): both read FAILED, but only one CAS from
    // FAILED → PENDING can succeed. The loser must be stopped here, before
    // ever reaching `accept()`/`seatUser`.
    it('raises CONFLICT when another actor already moved the invitation off FAILED, and never calls seatUser', async () => {
      deps.seats.findInvitationById.mockResolvedValue({
        id: 'i1',
        roomId: 'r1',
        inviteeUserId: 'u2',
        seatIndex: 3,
        status: 'FAILED',
        attemptCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      deps.seats.setInvitationStatus.mockResolvedValueOnce(null);
      await expect(svc.retry(actor('u2'), 'r1', 'i1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.SEAT_INVITATION_INVALID_TRANSITION,
        status: HttpStatus.CONFLICT,
      });
      expect(deps.seatSvc.seatUser).not.toHaveBeenCalled();
    });
  });

  describe('listInvitations', () => {
    it('requires INVITE_USERS and maps the room-wide pending/delivered rows', async () => {
      deps.seats.listPendingInvitations.mockResolvedValue([
        {
          id: 'i1',
          inviterId: 'owner',
          inviteeUserId: 'u2',
          type: 'SEAT',
          seatIndex: 3,
          status: 'PENDING',
          expiresAt: new Date(),
        },
      ]);
      const rows = await svc.listInvitations(actor('owner'), 'r1');
      expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'INVITE_USERS',
      );
      expect(deps.seats.listPendingInvitations).toHaveBeenCalledWith('r1');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('i1');
    });
  });
});
