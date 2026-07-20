import { VideoRoomSeatRequestStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import {
  VideoRoomSeatRequestService,
  compareRequestPriority,
} from './video-room-seat-request.service';

const actor = (id: string) => ({ id, roles: [] as never[] });

describe('VideoRoomSeatRequestService', () => {
  let deps: any;
  let svc: VideoRoomSeatRequestService;

  beforeEach(() => {
    deps = {
      seatSvc: {
        requireLiveRoom: jest.fn().mockResolvedValue({ id: 'r', ownerId: 'owner' }),
        seatUser: jest.fn().mockResolvedValue({ roomId: 'r', version: 3, seats: [] }),
        getStage: jest.fn(),
      },
      seats: {
        findPendingRequest: jest.fn().mockResolvedValue(null),
        createRequest: jest.fn().mockResolvedValue({
          id: 'q1',
          seatIndex: 2,
          status: 'PENDING',
          createdAt: new Date(),
          userId: 'u',
        }),
        listPendingRequests: jest.fn().mockResolvedValue([]),
        setRequestStatus: jest.fn(),
        findRequestById: jest.fn(),
      },
      rooms: { getMember: jest.fn().mockResolvedValue({ isActive: true }) },
      permissions: { assertPermission: jest.fn(), authorityRank: jest.fn().mockResolvedValue(0) },
      events: { appendEvent: jest.fn() },
      bus: { publish: jest.fn() },
    };
    svc = new VideoRoomSeatRequestService(
      deps.seatSvc,
      deps.seats,
      deps.rooms,
      deps.permissions,
      deps.events,
      deps.bus,
    );
  });

  const pub = () => deps.bus.publish.mock.calls.map((c: any[]) => c[0].constructor.name);

  it('request creates a PENDING request with expiry and publishes', async () => {
    await svc.request(actor('u'), 'r', 2);
    expect(deps.seats.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r',
        userId: 'u',
        seatIndex: 2,
        expiresAt: expect.any(Date),
      }),
      'u',
    );
    expect(pub()).toContain('SeatRequestedEvent');
  });

  it('request rejects a duplicate pending request (DUPLICATE_SEAT_REQUEST)', async () => {
    deps.seats.findPendingRequest.mockResolvedValue({ id: 'existing' });
    await expect(svc.request(actor('u'), 'r', 2)).rejects.toMatchObject({
      errorCode: ERROR_CODES.DUPLICATE_SEAT_REQUEST,
    });
  });

  it('approve requires MANAGE_SEATS, seats the requester, marks ACCEPTED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r',
      userId: 'requester',
      seatIndex: 2,
      status: VideoRoomSeatRequestStatus.PENDING,
      expiresAt: null,
    });
    await svc.approve(actor('owner'), 'r', 'q1');
    expect(deps.permissions.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'MANAGE_SEATS',
    );
    expect(deps.seatSvc.seatUser).toHaveBeenCalledWith('r', 'requester', 'owner', 2, undefined);
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      VideoRoomSeatRequestStatus.ACCEPTED,
      'owner',
      'owner',
    );
    expect(pub()).toContain('SeatRequestResolvedEvent');
  });

  it('reject marks the request REJECTED', async () => {
    deps.seats.findRequestById.mockResolvedValue({
      id: 'q1',
      roomId: 'r',
      userId: 'requester',
      seatIndex: 2,
      status: VideoRoomSeatRequestStatus.PENDING,
      expiresAt: null,
    });
    await svc.reject(actor('owner'), 'r', 'q1');
    expect(deps.seats.setRequestStatus).toHaveBeenCalledWith(
      'q1',
      VideoRoomSeatRequestStatus.REJECTED,
      'owner',
      'owner',
    );
  });

  it('listRequests returns views ordered by the priority comparator (FIFO default)', async () => {
    const older = {
      id: 'a',
      userId: 'a',
      seatIndex: 1,
      status: 'PENDING',
      createdAt: new Date(1000),
    };
    const newer = {
      id: 'b',
      userId: 'b',
      seatIndex: 2,
      status: 'PENDING',
      createdAt: new Date(2000),
    };
    deps.seats.listPendingRequests.mockResolvedValue([newer, older]);
    const list = await svc.listRequests(actor('owner'), 'r');
    expect(list.map((r) => r.id)).toEqual(['a', 'b']); // older first (FIFO)
  });
});

describe('compareRequestPriority (FIFO default)', () => {
  it('orders earlier createdAt first', () => {
    const a = { createdAt: new Date(1000) } as any;
    const b = { createdAt: new Date(2000) } as any;
    expect(compareRequestPriority(a, b, { rank: new Map(), vip: new Map() })).toBeLessThan(0);
  });
});
