import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';

/**
 * VR-12 PK exceptions. Each binds one error code so a client can branch on the
 * specific failure instead of parsing a message.
 *
 * All default to 409 CONFLICT: every one of these fires when the request was
 * well-formed but the battle state disallows it. 400 would instruct the client
 * to fix its payload, which is the wrong instruction.
 */

export class PKBattleException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_INVALID, message, status);
  }
}

export class PKInvitationException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_INVITATION_FAILED, message, status);
  }
}

export class PKScoreException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_SCORE_FAILED, message, status);
  }
}

export class PKRewardException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_REWARD_FAILED, message, status);
  }
}

export class PKWinnerException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_WINNER_FAILED, message, status);
  }
}

export class DuplicatePKException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_ALREADY_ACTIVE, message, status);
  }
}

export class PKCountdownException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_COUNTDOWN_FAILED, message, status);
  }
}

export class BattleRecoveryException extends BusinessException {
  constructor(message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(ERROR_CODES.VIDEO_ROOM_PK_RECOVERY_FAILED, message, status);
  }
}
