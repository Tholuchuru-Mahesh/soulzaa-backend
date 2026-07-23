import { HttpStatus } from '@nestjs/common';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
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
  let queue: any;
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
    queue = { list: jest.fn(), position: jest.fn(), size: jest.fn() };
    ctrl = new VideoRoomSeatsController(seats, reservations, requests, invitations, queue);
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

describe('VideoRoomSeatsController — VR-8 routes', () => {
  let deps: any;
  let ctrl: VideoRoomSeatsController;

  beforeEach(() => {
    deps = {
      seats: {},
      reservations: {},
      requests: {
        listRequests: jest.fn().mockResolvedValue([]),
        updateRequest: jest.fn().mockResolvedValue({ id: 'q1' }),
        retry: jest.fn().mockResolvedValue({ version: 3 }),
      },
      invitations: {
        listInvitations: jest.fn().mockResolvedValue([]),
        cancel: jest.fn(),
        acknowledge: jest.fn().mockResolvedValue({ id: 'i1' }),
        retry: jest.fn().mockResolvedValue({ version: 4 }),
        inviteToRoom: jest.fn().mockResolvedValue({ id: 'ri1' }),
        acceptRoomInvite: jest.fn().mockResolvedValue(undefined),
        rejectRoomInvite: jest.fn().mockResolvedValue(undefined),
      },
      queue: {
        list: jest.fn().mockResolvedValue([{ userId: 'u2', position: 1, vipLevel: 0, score: 1 }]),
        position: jest.fn().mockResolvedValue(4),
        size: jest.fn().mockResolvedValue(9),
        assertQueueAccess: jest.fn().mockResolvedValue(undefined),
      },
    };
    ctrl = new VideoRoomSeatsController(
      deps.seats,
      deps.reservations,
      deps.requests,
      deps.invitations,
      deps.queue,
    );
  });

  it('lists pending seat requests', async () => {
    await ctrl.listRequests(user, ROOM);
    expect(deps.requests.listRequests).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
    );
  });

  it('lists outstanding invitations', async () => {
    await ctrl.listInvitations(user, ROOM);
    expect(deps.invitations.listInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
    );
  });

  it('cancels an invitation', async () => {
    await ctrl.cancelInvite(user, ROOM, { invitationId: 'i1' } as never, IP);
    expect(deps.invitations.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'i1',
      IP,
    );
  });

  it('updates a pending request', async () => {
    await ctrl.updateRequest(user, ROOM, { seatIndex: 5 } as never, IP);
    expect(deps.requests.updateRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      5,
      IP,
    );
  });

  it('retries a failed request', async () => {
    await ctrl.retryRequest(user, ROOM, 'q1', IP);
    expect(deps.requests.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'q1',
      IP,
    );
  });

  it('acknowledges an invitation', async () => {
    await ctrl.ackInvite(user, ROOM, 'i1', IP);
    expect(deps.invitations.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'i1',
      IP,
    );
  });

  it('retries a failed invitation', async () => {
    await ctrl.retryInvite(user, ROOM, 'i1', IP);
    expect(deps.invitations.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'i1',
      IP,
    );
  });

  // ---- VR-15 room invitations ----

  it('invites a non-member into the room', async () => {
    await ctrl.inviteToRoom(user, ROOM, { inviteeUserId: 'g' } as never, IP);
    expect(deps.invitations.inviteToRoom).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'g',
      IP,
    );
  });

  it('accepts a room invitation', async () => {
    await ctrl.acceptRoomInvite(user, ROOM, { invitationId: 'ri1' } as never, IP);
    expect(deps.invitations.acceptRoomInvite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'ri1',
      IP,
    );
  });

  it('rejects a room invitation', async () => {
    await ctrl.rejectRoomInvite(user, ROOM, { invitationId: 'ri1' } as never, IP);
    expect(deps.invitations.rejectRoomInvite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u' }),
      ROOM,
      'ri1',
      IP,
    );
  });

  it('returns the queue with the caller’s own position', async () => {
    const res = await ctrl.getQueue(user, ROOM);
    expect(res).toEqual({
      size: 9,
      entries: [{ userId: 'u2', position: 1, vipLevel: 0 }],
      myPosition: 4,
    });
  });

  it('reports a null position for a caller who is not queued', async () => {
    deps.queue.position.mockResolvedValue(null);
    const res = await ctrl.getQueue(user, ROOM);
    expect(res.myPosition).toBeNull();
  });

  // Fix 2: unlike every other VR-8 route, `getQueue` had no check that the room
  // is live or that the caller is a member — the JWT guard was the only gate,
  // letting any authenticated non-guest enumerate an arbitrary room's queue.
  it('asserts room-live + active-member access before composing the response', async () => {
    await ctrl.getQueue(user, ROOM);
    expect(deps.queue.assertQueueAccess).toHaveBeenCalledWith(ROOM, 'u');
  });

  it('propagates an authorization failure without listing the queue', async () => {
    deps.queue.assertQueueAccess.mockRejectedValue(
      new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'You must join the room first.',
        HttpStatus.FORBIDDEN,
      ),
    );
    await expect(ctrl.getQueue(user, ROOM)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
    });
    expect(deps.queue.list).not.toHaveBeenCalled();
  });
});
