import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from 'src/common/exceptions';
import {
  AggregationException,
  LeaderboardException,
  RankingCacheException,
  RankingException,
  RankingPeriodException,
} from './video-room-ranking.exceptions';

describe('VR-13 exceptions', () => {
  it('binds each class to its own error code', () => {
    expect(new RankingException('x').errorCode).toBe(ERROR_CODES.VIDEO_ROOM_RANKING_INVALID);
    expect(new LeaderboardException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_LEADERBOARD_INVALID,
    );
    expect(new AggregationException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_AGGREGATION_FAILED,
    );
    expect(new RankingCacheException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_CACHE_FAILED,
    );
    expect(new RankingPeriodException('x').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_RANKING_PERIOD_INVALID,
    );
  });

  it('defaults state violations to 409 and a malformed period to 400', () => {
    expect(new RankingException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new LeaderboardException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new AggregationException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    expect(new RankingCacheException('x').getStatus()).toBe(HttpStatus.CONFLICT);
    // A period/dateKey that will not parse IS a malformed request.
    expect(new RankingPeriodException('x').getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('accepts an explicit status override', () => {
    expect(new RankingException('x', HttpStatus.NOT_FOUND).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});
