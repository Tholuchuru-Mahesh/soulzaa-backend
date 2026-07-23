import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-13 domain exceptions — thin `BusinessException` subclasses binding one
 * error code each, so callers get a named type to catch while the global
 * ERROR_CODES registry stays the single source of truth for clients. The VR-11
 * and VR-12 exception files are the pattern.
 *
 * Four default to 409 CONFLICT: they fire when the request was well-formed but
 * the engine's state disallowed it. RankingPeriodException is the exception —
 * an unparseable period or dateKey genuinely is a malformed request, and a 409
 * would tell the client to retry something that can never succeed.
 */

/** A ranking read or write was refused: unknown dimension, malformed scope. */
export class RankingException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_INVALID, message, status);
  }
}

/** A leaderboard could not be assembled: bad projection, missing snapshot. */
export class LeaderboardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_LEADERBOARD_INVALID, message, status);
  }
}

/** A recompute could not run or complete. Retried by BullMQ before any client sees it. */
export class AggregationException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_AGGREGATION_FAILED, message, status);
  }
}

/** The leaderboard cache could not be read or written in a path that required it. */
export class RankingCacheException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_CACHE_FAILED, message, status);
  }
}

/** The requested period or dateKey is not valid — a 400, not a conflict. */
export class RankingPeriodException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super(ERROR_CODES.VIDEO_ROOM_RANKING_PERIOD_INVALID, message, status);
  }
}
