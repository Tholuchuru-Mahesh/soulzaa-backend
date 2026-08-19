import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_MODERATION_SOCKET_EVENTS,
  type VideoRoomModerationSocketEvent,
} from '../constants/video-room-moderation.constants';
import { VIDEO_ROOM_MODERATION_EVENTS } from '../events/video-room-moderation.events';
import { VideoRoomModerationSocketListener } from './video-room-moderation-socket.listener';

import { SYSTEM_MODERATOR_ID } from '../constants/video-room-moderation.constants';

describe('VideoRoomModerationSocketListener', () => {
  let handlers: Record<string, (e: { payload: unknown }) => void>;
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };

  beforeEach(() => {
    handlers = {};
    const bus = {
      subscribe: (name: string, handler: (e: { payload: unknown }) => void) => {
        handlers[name] = handler;
        return () => undefined;
      },
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    new VideoRoomModerationSocketListener(bus as never, sockets as never).onModuleInit();
  });

  it('bridges UserWarnedEvent to the target user only (with anonymized moderator identity)', () => {
    const payload = {
      roomId: 'r1',
      moderatorId: 'm1',
      targetUserId: 'u1',
      reason: 'spam',
      metadata: null,
    };
    handlers[VIDEO_ROOM_MODERATION_EVENTS.WARNED]({ payload });

    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_WARNED,
      expect.objectContaining({
        ...payload,
        moderatorId: SYSTEM_MODERATOR_ID,
        systemMessage: expect.any(String),
      }),
    );
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('bridges UserKickedEvent to a room broadcast and target user (with anonymized moderator identity)', () => {
    const payload = { roomId: 'r1', moderatorId: 'm1', targetUserId: 'u1', reason: 'abuse' };
    handlers[VIDEO_ROOM_MODERATION_EVENTS.KICKED]({ payload });

    const expected = expect.objectContaining({
      ...payload,
      moderatorId: SYSTEM_MODERATOR_ID,
      systemMessage: expect.any(String),
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      VIDEO_ROOM_NAMESPACE,
      'r1',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED,
      expected,
    );
    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED,
      expected,
    );
  });

  it('bridges every remaining room-broadcast moderation event to its mapped client event with anonymized identity', () => {
    const cases: Array<[string, VideoRoomModerationSocketEvent, Record<string, unknown>, boolean]> = [
      [
        VIDEO_ROOM_MODERATION_EVENTS.BLACKLISTED,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_BLACKLISTED,
        { roomId: 'r1', moderatorId: 'm1', targetUserId: 'u1', reason: 'ban-worthy' },
        true,
      ],
      [
        VIDEO_ROOM_MODERATION_EVENTS.UNBLACKLISTED,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNBLACKLISTED,
        { roomId: 'r1', moderatorId: 'm1', targetUserId: 'u1' },
        false,
      ],
      [
        VIDEO_ROOM_MODERATION_EVENTS.MUTED,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_MUTED,
        {
          roomId: 'r1',
          moderatorId: 'm1',
          targetUserId: 'u1',
          type: 'TEMPORARY',
          reason: null,
          expiresAt: null,
          channels: ['MIC'],
        },
        false,
      ],
      [
        VIDEO_ROOM_MODERATION_EVENTS.UNMUTED,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNMUTED,
        {
          roomId: 'r1',
          moderatorId: 'm1',
          targetUserId: 'u1',
          channels: ['MIC'],
          reason: 'lifted',
        },
        false,
      ],
      [
        VIDEO_ROOM_MODERATION_EVENTS.FORCE_DISCONNECTED,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_FORCE_DISCONNECTED,
        { roomId: 'r1', moderatorId: 'm1', targetUserId: 'u1', reason: null },
        true,
      ],
    ];

    for (const [busEvent, clientEvent, payload, shouldEmitToUser] of cases) {
      sockets.emitToNamespaceRoom.mockClear();
      sockets.emitToUserEverywhere.mockClear();
      handlers[busEvent]({ payload });
      const expected = expect.objectContaining({
        ...payload,
        moderatorId: SYSTEM_MODERATOR_ID,
        systemMessage: expect.any(String),
      });
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        VIDEO_ROOM_NAMESPACE,
        'r1',
        clientEvent,
        expected,
      );
      if (shouldEmitToUser) {
        expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
          payload.targetUserId,
          clientEvent,
          expected,
        );
      } else {
        expect(sockets.emitToUserEverywhere).not.toHaveBeenCalled();
      }
    }
  });

  it('bridges UserReportedEvent to each recipient only (never broadcast to the room)', () => {
    const payload = {
      roomId: 'r1',
      reportId: 'rep1',
      reporterId: 'u2',
      targetUserId: 'u1',
      reason: 'HARASSMENT',
      recipientIds: ['mod1', 'mod2'],
    };
    handlers[VIDEO_ROOM_MODERATION_EVENTS.REPORTED]({ payload });

    expect(sockets.emitToUserEverywhere).toHaveBeenCalledTimes(2);
    expect(sockets.emitToUserEverywhere).toHaveBeenNthCalledWith(
      1,
      'mod1',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_REPORTED,
      payload,
    );
    expect(sockets.emitToUserEverywhere).toHaveBeenNthCalledWith(
      2,
      'mod2',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_REPORTED,
      payload,
    );
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('bridges ReportReviewedEvent to the target user only', () => {
    const payload = {
      roomId: 'r1',
      reportId: 'rep1',
      moderatorId: 'm1',
      targetUserId: 'u1',
      status: 'ACTIONED',
      resolutionAction: 'kick',
    };
    handlers[VIDEO_ROOM_MODERATION_EVENTS.REPORT_REVIEWED]({ payload });

    expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
      'u1',
      VIDEO_ROOM_MODERATION_SOCKET_EVENTS.REPORT_REVIEWED,
      payload,
    );
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
  });

  it('does not subscribe to ModerationActionCompletedEvent (no dedicated socket broadcast)', () => {
    expect(handlers[VIDEO_ROOM_MODERATION_EVENTS.ACTION_COMPLETED]).toBeUndefined();
  });

  it('subscribes to exactly the moderation events with a mapped socket event (no extra business logic)', () => {
    const expectedNames = Object.values(VIDEO_ROOM_MODERATION_EVENTS).filter(
      (name) => name !== VIDEO_ROOM_MODERATION_EVENTS.ACTION_COMPLETED,
    );
    expect(Object.keys(handlers).sort()).toEqual([...expectedNames].sort());
  });
});
