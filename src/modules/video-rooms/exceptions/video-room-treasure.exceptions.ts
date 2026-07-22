import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-11 domain exceptions.
 *
 * Each is a thin `BusinessException` subclass binding its own error code, so
 * callers get a named type to catch while the global ERROR_CODES registry stays
 * the single source of truth for clients.
 *
 * They default to 409 CONFLICT rather than 400: every one of these fires when
 * the request was well-formed but the treasure state disallows it — wrong
 * session state, box already opened, reward already paid. A 400 would tell the
 * client to fix its payload, which is the wrong instruction. Callers pass an
 * explicit status for the cases that genuinely are not conflicts (403 for a
 * disabled room, 404 for a missing ladder, 424 for an unconfigured one).
 */

/** Lifecycle / state-machine violations: wrong session state, no ladder, disabled. */
export class TreasureBoxException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_INVALID, message, status);
  }
}

/** A contribution could not be applied to the ladder. */
export class TreasureProgressException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_PROGRESS_FAILED, message, status);
  }
}

/** The unlock pipeline refused or failed: box not claimed, session not unlockable. */
export class TreasureUnlockException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_UNLOCK_FAILED, message, status);
  }
}

/** The pool could not be computed: unknown strategy, bps out of range, no fixed amount. */
export class RewardPoolException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_POOL_INVALID, message, status);
  }
}

/** Winner selection could not run: unknown algorithm. */
export class WinnerSelectionException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED, message, status);
  }
}

/** A reward could not be credited. Retried by BullMQ before it reaches a client. */
export class RewardDistributionException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED, message, status);
  }
}

/** A reward was already paid for this box and user — the replay guard fired. */
export class DuplicateRewardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_TREASURE_DUPLICATE_REWARD, message, status);
  }
}
