import {
  mutesMirrorKey,
  blocksMirrorKey,
  moderationLockKey,
  MODERATION_MONITOR_LOCK_KEY,
  spamCounterKey,
  floodCounterKey,
  dupKey,
  joinLeaveKey,
  reportCounterKey,
  cooldownKey,
  SYSTEM_MODERATOR_ID,
  VIDEO_ROOM_MODERATION_SOCKET_EVENTS,
  VIDEO_ROOM_MODERATION_QUEUES,
  VIDEO_ROOM_MODERATION_DESCRIPTION_MAX,
  VIDEO_ROOM_MODERATION_WARNING_METADATA_MAX,
} from './video-room-moderation.constants';
import { VIDEO_ROOM_QUEUES } from './video-room.constants';

describe('video-room-moderation.constants', () => {
  it('hash-tags room-scoped keys for cluster safety', () => {
    expect(mutesMirrorKey('r1')).toBe('video-room:{r1}:mutes');
    expect(blocksMirrorKey('r1')).toBe('video-room:{r1}:blocks');
    expect(moderationLockKey('r1')).toBe('video-room:moderation:{r1}');
    expect(spamCounterKey('r1', 'u1')).toBe('video-room:mod:spam:{r1}:u1');
  });

  it('builds the remaining per-user windowed-counter keys', () => {
    expect(floodCounterKey('r1', 'u1')).toBe('video-room:mod:flood:{r1}:u1');
    expect(dupKey('r1', 'u1')).toBe('video-room:mod:dup:{r1}:u1');
    expect(joinLeaveKey('r1', 'u1')).toBe('video-room:mod:joinleave:{r1}:u1');
    expect(reportCounterKey('r1', 'u1')).toBe('video-room:mod:reports:{r1}:u1');
    expect(cooldownKey('r1', 'u1')).toBe('video-room:mod:cooldown:{r1}:u1');
  });

  it('exposes a fleet-wide monitor lock distinct from the per-room lock', () => {
    expect(MODERATION_MONITOR_LOCK_KEY).toBe('video-room:moderation:monitor');
    expect(MODERATION_MONITOR_LOCK_KEY).not.toBe(moderationLockKey('monitor'));
  });

  it('exposes stable socket event names and a nil system id', () => {
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED).toBe('userKicked');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_BLACKLISTED).toBe('userBlacklisted');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNBLACKLISTED).toBe('userUnblacklisted');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_MUTED).toBe('userMuted');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNMUTED).toBe('userUnmuted');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_WARNED).toBe('userWarned');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_FORCE_DISCONNECTED).toBe(
      'userForceDisconnected',
    );
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_REPORTED).toBe('userReported');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.REPORT_REVIEWED).toBe('reportReviewed');
    expect(VIDEO_ROOM_MODERATION_SOCKET_EVENTS.ROOM_MODERATION_UPDATED).toBe(
      'roomModerationUpdated',
    );
    expect(SYSTEM_MODERATOR_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('declares the 3 moderation queue names', () => {
    expect(VIDEO_ROOM_MODERATION_QUEUES).toEqual({
      PROCESSING: 'video-rooms-moderation',
      REPORT: 'video-rooms-report',
      CLEANUP: 'video-rooms-moderation-cleanup',
    });
  });

  it('merges the moderation queue names into the shared VIDEO_ROOM_QUEUES map', () => {
    expect(VIDEO_ROOM_QUEUES.MAIN).toBe('video-rooms');
    expect(VIDEO_ROOM_QUEUES.CLEANUP).toBe('video-rooms-cleanup');
    expect(VIDEO_ROOM_QUEUES.MODERATION_PROCESSING).toBe(VIDEO_ROOM_MODERATION_QUEUES.PROCESSING);
    expect(VIDEO_ROOM_QUEUES.MODERATION_REPORT).toBe(VIDEO_ROOM_MODERATION_QUEUES.REPORT);
    expect(VIDEO_ROOM_QUEUES.MODERATION_CLEANUP).toBe(VIDEO_ROOM_MODERATION_QUEUES.CLEANUP);
  });

  it('declares fixed text/metadata bounds', () => {
    expect(VIDEO_ROOM_MODERATION_DESCRIPTION_MAX).toBeGreaterThan(0);
    expect(VIDEO_ROOM_MODERATION_WARNING_METADATA_MAX).toBeGreaterThan(0);
  });
});
