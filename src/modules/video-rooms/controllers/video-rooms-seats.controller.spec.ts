import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomSeatsController } from './video-rooms-seats.controller';

const user = { id: 'u', roles: [] } as unknown as AuthenticatedUser;
const IP = '1.2.3.4';
const ROOM = '11111111-1111-4111-8111-111111111111';

describe('VideoRoomSeatsController', () => {
  let seats: any;
  let reservations: any;
  let requests: any;
  let invitations: any;
  let ctrl: VideoRoomSeatsController;

  beforeEach(() => {
    seats = {
      getStage: jest.fn(),
      lockSeats: jest.fn(),
      unlockSeats: jest.fn(),
      switchSeat: jest.fn(),
      transferSeat: jest.fn(),
    };
    reservations = { reserve: jest.fn(), cancelReservation: jest.fn() };
    requests = {
      request: jest.fn(),
      cancelRequest: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
    };
    invitations = { invite: jest.fn(), accept: jest.fn(), reject: jest.fn() };
    ctrl = new VideoRoomSeatsController(seats, reservations, requests, invitations);
  });

  it('getStage delegates with the actor + room id', () => {
    void ctrl.getStage(user, ROOM);
    expect(seats.getStage).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM);
  });

  it('reserve threads all fields + ip', () => {
    void ctrl.reserve(user, ROOM, { seatIndex: 2, forUserId: 'g', ttlSeconds: 90 } as never, IP);
    expect(reservations.reserve).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 2, 'g', 90, IP);
  });

  it('requestSeat + approve/reject delegate', () => {
    void ctrl.requestSeat(user, ROOM, { seatIndex: 3 } as never, IP);
    expect(requests.request).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 3, IP);
    void ctrl.approveRequest(user, ROOM, 'req1', IP);
    expect(requests.approve).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 'req1', IP);
    void ctrl.rejectRequest(user, ROOM, 'req1', IP);
    expect(requests.reject).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 'req1', IP);
  });

  it('invite / accept / reject delegate to the invitation service', () => {
    void ctrl.invite(user, ROOM, { inviteeUserId: 'g', seatIndex: 2 } as never, IP);
    expect(invitations.invite).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 'g', 2, IP);
    void ctrl.acceptInvite(user, ROOM, { invitationId: 'iv1' } as never, IP);
    expect(invitations.accept).toHaveBeenCalledWith({ id: 'u', roles: [] }, ROOM, 'iv1', IP);
  });

  it('lock / unlock / switch / transfer delegate', () => {
    void ctrl.lock(user, ROOM, { seatIndexes: [1, 2], reason: 'maintenance' } as never, IP);
    expect(seats.lockSeats).toHaveBeenCalledWith(
      { id: 'u', roles: [] },
      ROOM,
      [1, 2],
      'maintenance',
      IP,
    );
    void ctrl.transfer(user, ROOM, { userId: 'g', toSeatIndex: 4, force: true } as never, IP);
    expect(seats.transferSeat).toHaveBeenCalledWith(
      { id: 'u', roles: [] },
      ROOM,
      'g',
      4,
      undefined,
      true,
      IP,
    );
  });
});
