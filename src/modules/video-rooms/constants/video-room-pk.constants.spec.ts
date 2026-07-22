import { VideoRoomPkStatus } from '@prisma/client';
import {
  PK_TERMINAL_STATUSES,
  VIDEO_ROOM_PK_TRANSITIONS,
  isPkTerminal,
  pkLifecycleLockKey,
  pkScoreKey,
} from './video-room-pk.constants';

describe('video-room PK constants', () => {
  it('declares a transition set for every status', () => {
    for (const status of Object.values(VideoRoomPkStatus)) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the happy path CREATED → … → COMPLETED', () => {
    const path: VideoRoomPkStatus[] = [
      VideoRoomPkStatus.CREATED,
      VideoRoomPkStatus.INVITED,
      VideoRoomPkStatus.PENDING,
      VideoRoomPkStatus.ACCEPTED,
      VideoRoomPkStatus.COUNTDOWN,
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.COMPLETED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[path[i]].has(path[i + 1])).toBe(true);
    }
  });

  it('allows LIVE ⇄ PAUSED and LIVE ⇄ RECOVERING', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.LIVE.has(VideoRoomPkStatus.PAUSED)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.PAUSED.has(VideoRoomPkStatus.LIVE)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.LIVE.has(VideoRoomPkStatus.RECOVERING)).toBe(true);
    expect(VIDEO_ROOM_PK_TRANSITIONS.RECOVERING.has(VideoRoomPkStatus.LIVE)).toBe(true);
  });

  // The single most important invariant: a finished battle can never move.
  it('makes every terminal status a dead end', () => {
    for (const status of PK_TERMINAL_STATUSES) {
      expect(VIDEO_ROOM_PK_TRANSITIONS[status].size).toBe(0);
      expect(isPkTerminal(status)).toBe(true);
    }
  });

  it('forbids skipping the countdown', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.ACCEPTED.has(VideoRoomPkStatus.LIVE)).toBe(false);
  });

  it('forbids scoring states reached from nowhere', () => {
    expect(VIDEO_ROOM_PK_TRANSITIONS.CREATED.has(VideoRoomPkStatus.LIVE)).toBe(false);
    expect(VIDEO_ROOM_PK_TRANSITIONS.COMPLETED.has(VideoRoomPkStatus.LIVE)).toBe(false);
  });

  it('hash-tags per-room lock keys for Redis Cluster', () => {
    expect(pkLifecycleLockKey('room-1')).toBe('video-room:pk:lifecycle:{room-1}');
  });

  it('does not hash-tag plain data keys', () => {
    expect(pkScoreKey('battle-1')).toBe('video-room:pk:score:battle-1');
  });
});
