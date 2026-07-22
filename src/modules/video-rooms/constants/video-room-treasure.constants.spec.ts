import {
  TREASURE_CONTEXT_TYPE,
  TreasurePoolStrategy,
  TreasureUnlockStage,
  TreasureWinnerAlgorithm,
  treasureActivityKey,
  treasureEmitKey,
  treasureLevelKey,
  treasureLifecycleLockKey,
  treasureProgressKey,
  treasureStatsKey,
  treasureUnlockLockKey,
  VIDEO_ROOM_TREASURE_QUEUE_JOB,
  VIDEO_ROOM_TREASURE_SOCKET_EVENTS,
} from './video-room-treasure.constants';

describe('video-room treasure constants', () => {
  it('exposes the seven socket events the spec names', () => {
    expect(Object.values(VIDEO_ROOM_TREASURE_SOCKET_EVENTS)).toEqual([
      'treasureProgressUpdated',
      'treasureUnlocked',
      'treasureWinnerSelected',
      'treasureRewardDistributed',
      'treasureLevelChanged',
      'treasureAnimation',
      'treasureRecovered',
    ]);
  });

  // Redis Cluster routes by hash tag. Lock keys must land in one slot per room
  // so a Lua-based lock release is not a cross-slot operation.
  it('hash-tags per-room lock keys', () => {
    expect(treasureUnlockLockKey('r1')).toBe('video-room:treasure:unlock:{r1}');
    expect(treasureLifecycleLockKey('r1')).toBe('video-room:treasure:lifecycle:{r1}');
  });

  it('namespaces every data key under video-room:treasure', () => {
    expect(treasureProgressKey('r1')).toBe('video-room:treasure:progress:r1');
    expect(treasureLevelKey('r1')).toBe('video-room:treasure:level:r1');
    expect(treasureActivityKey('r1', 's1')).toBe('video-room:treasure:activity:r1:s1');
    expect(treasureEmitKey('r1')).toBe('video-room:treasure:emit:r1');
    expect(treasureStatsKey('r1', 's1')).toBe('video-room:treasure:stats:r1:s1');
  });

  it('names the context type once so no service spells VIDEO_ROOM inline', () => {
    expect(TREASURE_CONTEXT_TYPE).toBe('VIDEO_ROOM');
  });

  it('registers the queue job on a video-room-namespaced name', () => {
    expect(VIDEO_ROOM_TREASURE_QUEUE_JOB).toBe('video-room.treasure.unlock');
  });

  it('enumerates every pipeline stage for failure attribution', () => {
    expect(Object.values(TreasureUnlockStage)).toEqual([
      'VALIDATE',
      'POOL',
      'ELIGIBILITY',
      'WINNER_SELECTION',
      'DISTRIBUTION',
      'BROADCAST',
      'CHAIN',
      'RECOVERY',
    ]);
  });

  it('defaults to PERCENTAGE pool and RANDOM winners', () => {
    expect(TreasurePoolStrategy.PERCENTAGE).toBe('PERCENTAGE');
    expect(TreasureWinnerAlgorithm.RANDOM).toBe('RANDOM');
  });

  it('names all five winner algorithms the spec requires', () => {
    expect(Object.values(TreasureWinnerAlgorithm)).toEqual([
      'RANDOM',
      'WEIGHTED_RANDOM',
      'ACTIVITY_BASED',
      'CONTRIBUTION_BASED',
      'VIP_PRIORITY',
    ]);
  });
});
