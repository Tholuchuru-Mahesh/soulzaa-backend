import { VideoRoomInvitationStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomSeatInvitationService } from './video-room-seat-invitation.service';

const actor = (id: string) => ({ id, roles: [] as never[] });

describe('VideoRoomSeatInvitationService', () => {
  let deps: any;
  let svc: VideoRoomSeatInvitationService;

  beforeEach(() => {
    deps = {
      seatSvc: {
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r', ownerId: 'owner' }),
        seatUser: jest.fn().mockResolvedValue({ roomId: 'r', version: 4, seats: [] }),
        findOpenSeat: jest.fn().mockResolvedValue(3),
      },
      seats: {
        listPendingInvitations: jest.fn().mockResolvedValue([]),
        createInvitation: jest.fn().mockResolvedValue({
          id: 'iv1',
          inviterId: 'owner',
          inviteeUserId: 'guest',
          type: 'SEAT',
          seatIndex: 2,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 60000),
        }),
        findInvitationById: jest.fn(),
        setInvitationStatus: jest.fn(),
      },
      permissions: { assertPermission: jest.fn() },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
    };
    svc = new VideoRoomSeatInvitationService(
      deps.seatSvc,
      deps.seats,
      deps.permissions,
      deps.events,
      deps.bus,
    );
  });

  const pub = () => deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);

  it('invite requires INVITE_USERS, creates the invitation, publishes', async () => {
    await svc.invite(actor('owner'), 'r', 'guest', 2);
    expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'INVITE_USERS',
    );
    expect(deps.seats.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r',
        inviterId: 'owner',
        inviteeUserId: 'guest',
        seatIndex: 2,
      }),
      'owner',
    );
    expect(pub()).toContain('SeatInvitationSentEvent');
  });

  it('invite rejects a duplicate pending invitation for the same seat', async () => {
    deps.seats.listPendingInvitations.mockResolvedValue([{ seatIndex: 2 }]);
    await expect(svc.invite(actor('owner'), 'r', 'guest', 2)).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_SEAT_INVITATION,
    });
  });

  it('accept (by the invitee) seats them and marks ACCEPTED', async () => {
    deps.seats.findInvitationById.mockResolvedValue({
      id: 'iv1',
      roomId: 'r',
      inviteeUserId: 'guest',
      seatIndex: 2,
      status: VideoRoomInvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60000),
    });
    await svc.accept(actor('guest'), 'r', 'iv1');
    expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r', 'guest', 'guest', 2, undefined);
    expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
      'iv1',
      VideoRoomInvitationStatus.ACCEPTED,
      'guest',
    );
    expect(pub()).toContain('SeatInvitationResolvedEvent');
  });

  it('accept rejects a non-invitee (FORBIDDEN)', async () => {
    deps.seats.findInvitationById.mockResolvedValue({
      id: 'iv1',
      roomId: 'r',
      inviteeUserId: 'guest',
      seatIndex: 2,
      status: VideoRoomInvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 60000),
    });
    await expect(svc.accept(actor('intruder'), 'r', 'iv1')).rejects.toMatchObject({ status: 403 });
  });

  it('accept rejects an expired invitation (SEAT_INVITATION_EXPIRED)', async () => {
    deps.seats.findInvitationById.mockResolvedValue({
      id: 'iv1',
      roomId: 'r',
      inviteeUserId: 'guest',
      seatIndex: 2,
      status: VideoRoomInvitationStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(svc.accept(actor('guest'), 'r', 'iv1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.SEAT_INVITATION_EXPIRED,
    });
    expect(deps.seats.setInvitationStatus).toHaveBeenCalledWith(
      'iv1',
      VideoRoomInvitationStatus.EXPIRED,
      'guest',
    );
  });
});
