import {
  VIDEO_ROOM_MODERATION_EVENTS,
  UserKickedEvent,
  UserBlacklistedEvent,
  UserUnblacklistedEvent,
  UserMutedEvent,
  UserUnmutedEvent,
  UserWarnedEvent,
  UserForceDisconnectedEvent,
  UserReportedEvent,
  ReportReviewedEvent,
  RoomModerationUpdatedEvent,
  ModerationActionCompletedEvent,
} from './video-room-moderation.events';

describe('VR-16 moderation domain events', () => {
  it('declares 11 distinct, video_room-namespaced event names', () => {
    const names = Object.values(VIDEO_ROOM_MODERATION_EVENTS);
    expect(names).toHaveLength(11);
    expect(names.every((n) => n.startsWith('video_room.'))).toBe(true);
    expect(new Set(names).size).toBe(11);
  });

  it('UserKickedEvent binds name + payload', () => {
    const e = new UserKickedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      reason: null,
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.KICKED);
    expect(e.name).toBe('video_room.user_kicked');
    expect(e.payload.roomId).toBe('room-1');
    expect(e.payload.moderatorId).toBe('mod-1');
    expect(e.payload.targetUserId).toBe('user-1');
    expect(e.payload.reason).toBeNull();
  });

  it('UserBlacklistedEvent binds name + payload', () => {
    const e = new UserBlacklistedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      reason: 'spam',
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.BLACKLISTED);
    expect(e.payload.reason).toBe('spam');
  });

  it('UserUnblacklistedEvent binds name + payload', () => {
    const e = new UserUnblacklistedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.UNBLACKLISTED);
    expect(e.payload.targetUserId).toBe('user-1');
  });

  it('UserMutedEvent binds name + payload including channels', () => {
    const e = new UserMutedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      type: 'TEMPORARY' as never,
      reason: 'flood',
      expiresAt: '2026-07-24T00:00:00.000Z',
      channels: ['chat', 'mic'],
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.MUTED);
    expect(e.payload.channels).toEqual(['chat', 'mic']);
    expect(e.payload.expiresAt).toBe('2026-07-24T00:00:00.000Z');
  });

  it('UserUnmutedEvent binds name + payload', () => {
    const e = new UserUnmutedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      channels: ['chat'],
      reason: 'expired',
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.UNMUTED);
    expect(e.payload.reason).toBe('expired');
  });

  it('UserWarnedEvent binds name + payload', () => {
    const e = new UserWarnedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      reason: 'be nice',
      metadata: { messageId: 'm-1' },
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.WARNED);
    expect(e.payload.metadata).toEqual({ messageId: 'm-1' });
  });

  it('UserForceDisconnectedEvent binds name + payload', () => {
    const e = new UserForceDisconnectedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      reason: null,
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.FORCE_DISCONNECTED);
    expect(e.payload.reason).toBeNull();
  });

  it('UserReportedEvent binds name + payload (reportId/reporterId/recipientIds)', () => {
    const e = new UserReportedEvent({
      roomId: 'room-1',
      reportId: 'report-1',
      reporterId: 'reporter-1',
      targetUserId: 'user-1',
      reason: 'SPAM' as never,
      recipientIds: ['owner-1', 'mod-2'],
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.REPORTED);
    expect(e.payload.reportId).toBe('report-1');
    expect(e.payload.reporterId).toBe('reporter-1');
    expect(e.payload.recipientIds).toEqual(['owner-1', 'mod-2']);
  });

  it('ReportReviewedEvent binds name + payload', () => {
    const e = new ReportReviewedEvent({
      roomId: 'room-1',
      reportId: 'report-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      status: 'REVIEWED' as never,
      resolutionAction: 'warned',
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.REPORT_REVIEWED);
    expect(e.payload.resolutionAction).toBe('warned');
  });

  it('RoomModerationUpdatedEvent binds name + payload', () => {
    const e = new RoomModerationUpdatedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      channels: ['chat', 'mic'],
      muted: true,
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.ROOM_MODERATION_UPDATED);
    expect(e.payload.muted).toBe(true);
  });

  it('ModerationActionCompletedEvent binds name + payload for the generic audit fan-out', () => {
    const e = new ModerationActionCompletedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      action: 'KICK' as never,
      reason: 'rule violation',
      metadata: { requestId: 'req-1' },
    });
    expect(e.name).toBe(VIDEO_ROOM_MODERATION_EVENTS.ACTION_COMPLETED);
    expect(e.payload.action).toBe('KICK');
    expect(e.payload.metadata).toEqual({ requestId: 'req-1' });
  });

  it('every event carries an eventId + occurredAt from DomainEvent', () => {
    const e = new UserWarnedEvent({
      roomId: 'room-1',
      moderatorId: 'mod-1',
      targetUserId: 'user-1',
      reason: 'be nice',
      metadata: null,
    });
    expect(e.eventId).toEqual(expect.any(String));
    expect(e.occurredAt).toEqual(expect.any(String));
  });
});
