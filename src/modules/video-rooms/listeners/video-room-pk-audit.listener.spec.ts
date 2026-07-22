import { VideoRoomLogAction } from '@prisma/client';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VideoRoomPkAuditListener } from './video-room-pk-audit.listener';

const BASE = { roomId: 'r1', battleId: 'b1' };

describe('VideoRoomPkAuditListener', () => {
  let bus: { subscribe: jest.Mock; handlers: Map<string, (e: unknown) => Promise<void>> };
  let rooms: { appendLog: jest.Mock };
  let listener: VideoRoomPkAuditListener;

  const fire = (name: string, payload: object, occurredAt = '2026-07-22T00:00:00.000Z') =>
    bus.handlers.get(name)!({ name, payload, occurredAt });

  beforeEach(() => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    bus = {
      handlers,
      subscribe: jest.fn((n: string, f: (e: unknown) => Promise<void>) => handlers.set(n, f)),
    };
    rooms = { appendLog: jest.fn().mockResolvedValue(undefined) };
    listener = new VideoRoomPkAuditListener(bus as never, rooms as never);
    listener.onModuleInit();
  });

  it('audits exactly the 9 PK_* actions', () => {
    expect(bus.subscribe).toHaveBeenCalledTimes(9);
  });

  // CREATED/SCORE_UPDATED/WINNER_DECLARED are deliberately unaudited — see the
  // listener's class doc.
  it('does not audit CREATED, SCORE_UPDATED or WINNER_DECLARED', () => {
    expect(bus.handlers.has(VIDEO_ROOM_PK_EVENTS.CREATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED)).toBe(false);
    expect(bus.handlers.has(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED)).toBe(false);
  });

  it.each([
    [VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, VideoRoomLogAction.PK_INVITED],
    [VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, VideoRoomLogAction.PK_INVITATION_ACCEPTED],
    [VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, VideoRoomLogAction.PK_INVITATION_REJECTED],
    [VIDEO_ROOM_PK_EVENTS.STARTED, VideoRoomLogAction.PK_STARTED],
    [VIDEO_ROOM_PK_EVENTS.PAUSED, VideoRoomLogAction.PK_PAUSED],
    [VIDEO_ROOM_PK_EVENTS.RESUMED, VideoRoomLogAction.PK_RESUMED],
    [VIDEO_ROOM_PK_EVENTS.ENDED, VideoRoomLogAction.PK_ENDED],
    [VIDEO_ROOM_PK_EVENTS.RECOVERED, VideoRoomLogAction.PK_RECOVERED],
    [VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, VideoRoomLogAction.PK_REWARD_DISTRIBUTED],
  ])('writes one log row for %s carrying the battle id', async (busEvent, action) => {
    await fire(busEvent, { ...BASE });
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'r1',
        action,
        metadata: expect.objectContaining({ battleId: 'b1' }),
      }),
    );
  });

  it('carries requestId through to the log row when the event has one', async () => {
    await fire(VIDEO_ROOM_PK_EVENTS.STARTED, { ...BASE, requestId: 'req-abc' });
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ requestId: 'req-abc' }),
      }),
    );
  });

  it('records a null request id when the event carries none', async () => {
    await fire(VIDEO_ROOM_PK_EVENTS.PAUSED, { ...BASE });
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ requestId: null }),
      }),
    );
  });

  it('resolves the actor from whichever field names them', async () => {
    await fire(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, {
      ...BASE,
      invitationId: 'i1',
      inviteeUserId: 'u1',
    });
    expect(rooms.appendLog).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'u1' }));
  });

  it('records a system-driven event with a null actor', async () => {
    await fire(VIDEO_ROOM_PK_EVENTS.RECOVERED, {
      ...BASE,
      reason: 'HOST_RETURNED',
      previousStatus: 'RECOVERING',
      newStatus: 'LIVE',
    });
    expect(rooms.appendLog).toHaveBeenCalledWith(expect.objectContaining({ actorId: null }));
  });

  it('stamps the event timestamp onto the log metadata', async () => {
    await fire(VIDEO_ROOM_PK_EVENTS.STARTED, { ...BASE }, '2026-07-22T03:00:00.000Z');
    expect(rooms.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ timestamp: '2026-07-22T03:00:00.000Z' }),
      }),
    );
  });

  // Audit is observational. Throwing here would poison the bus for every
  // other subscriber, including the socket bridge telling players an outcome.
  it('swallows repository failures', async () => {
    rooms.appendLog.mockRejectedValue(new Error('db down'));
    await expect(fire(VIDEO_ROOM_PK_EVENTS.ENDED, { ...BASE })).resolves.toBeUndefined();
  });
});
