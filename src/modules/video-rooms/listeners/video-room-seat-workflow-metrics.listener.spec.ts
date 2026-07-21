import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VideoRoomSeatWorkflowMetricsListener } from './video-room-seat-workflow-metrics.listener';

describe('VideoRoomSeatWorkflowMetricsListener', () => {
  let deps: any;
  let handlers: Record<string, (e: any) => void>;
  const fire = (type: string, payload: any) => handlers[type]({ payload });

  beforeEach(() => {
    handlers = {};
    deps = {
      bus: {
        subscribe: jest.fn((t: string, fn: (e: any) => void) => {
          handlers[t] = fn;
        }),
      },
      metrics: {
        observeSeatQueueDepth: jest.fn(),
        incSeatRequestResolution: jest.fn(),
        observeSeatApprovalLatency: jest.fn(),
        incSeatInvitationOutcome: jest.fn(),
        incSeatPromotion: jest.fn(),
      },
    };
    new VideoRoomSeatWorkflowMetricsListener(deps.bus, deps.metrics).onModuleInit();
  });

  it('counts a request resolution by status', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'REJECTED' });
    expect(deps.metrics.incSeatRequestResolution).toHaveBeenCalledWith('REJECTED');
  });

  it('counts a PROMOTED resolution as a promotion success', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
    expect(deps.metrics.incSeatPromotion).toHaveBeenCalledWith('success');
  });

  it('counts a FAILED resolution as a promotion failure', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'FAILED' });
    expect(deps.metrics.incSeatPromotion).toHaveBeenCalledWith('failure');
  });

  it('observes approval latency when the event carries the request creation time', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, {
      roomId: 'r1',
      status: 'PROMOTED',
      requestedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    expect(deps.metrics.observeSeatApprovalLatency).toHaveBeenCalledWith(expect.any(Number));
    const seconds = deps.metrics.observeSeatApprovalLatency.mock.calls[0][0];
    expect(seconds).toBeGreaterThanOrEqual(4);
    expect(seconds).toBeLessThan(10);
  });

  it('does not observe latency when the event omits the creation time', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, { roomId: 'r1', status: 'PROMOTED' });
    expect(deps.metrics.observeSeatApprovalLatency).not.toHaveBeenCalled();
  });

  it('counts an invitation as SENT when it is created', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, { roomId: 'r1', invitationId: 'i1' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('SENT');
  });

  it('counts an invitation delivery ack', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED, { roomId: 'r1', invitationId: 'i1' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('DELIVERED');
  });

  it('counts an invitation resolution by status', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED, { roomId: 'r1', status: 'ACCEPTED' });
    expect(deps.metrics.incSeatInvitationOutcome).toHaveBeenCalledWith('ACCEPTED');
  });

  it('counts a request expiry', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, { roomId: 'r1', requestId: 'q1', userId: 'u1' });
    expect(deps.metrics.incSeatRequestResolution).toHaveBeenCalledWith('EXPIRED');
  });

  it('tracks queue depth from queue updates', () => {
    fire(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, { roomId: 'r1', size: 7, top: [] });
    expect(deps.metrics.observeSeatQueueDepth).toHaveBeenCalledWith(7);
  });
});
