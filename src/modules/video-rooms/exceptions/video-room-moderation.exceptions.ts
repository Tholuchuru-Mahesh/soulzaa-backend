import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES, type ErrorCode } from 'src/common/exceptions';

/**
 * Phase 16 video room moderation exceptions.
 *
 * Unlike the VR-11/12/13 exception files, several moderation operations have
 * more than one failure code (mute has "already muted" vs "not found"; report
 * has three). Rather than mint one class per code, each class below is a thin
 * `BusinessException` wrapper scoped to one moderation *action* and takes the
 * specific code as an argument, so callers still get a named type to catch
 * while the global ERROR_CODES registry stays the single source of truth for
 * clients.
 *
 * `OwnerProtectionException` is the exception: it binds a single, reused code
 * (`VIDEO_ROOM_CANNOT_MODERATE_OWNER`, already thrown raw by VR-7's role
 * service) because "you can't moderate the owner" never varies by action.
 *
 * All default to 409 CONFLICT — these fire when the request was well-formed
 * but the moderation state disallows it (already muted, no pending report,
 * duplicate report). Callers pass an explicit status for the true exceptions
 * (403 self-moderation, 404 not-found lookups).
 */

/** General moderation prereq failures not covered by a more specific class below (e.g. self-moderation). */
export class ModerationException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/** Kick / force-disconnect could not be applied. */
export class KickException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/** Mute / unmute state transition refused: already muted, or no active mute to lift. */
export class MuteException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/** Block-list (blacklist) state transition refused: already blocked, or no block to lift. */
export class BlacklistException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/** A warning could not be issued or recorded. */
export class WarningException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/** Report lifecycle violation: duplicate report, missing report, or acting on a non-pending one. */
export class ReportException extends BusinessException {
  constructor(errorCode: ErrorCode, message: string, status: HttpStatus = HttpStatus.CONFLICT) {
    super(errorCode, message, status);
  }
}

/**
 * The room owner can never be moderated by another member — ownership must be
 * transferred first. Binds the reused VR-7 code so both role edits and
 * moderation actions surface the same machine-readable error to clients.
 */
export class OwnerProtectionException extends BusinessException {
  constructor(
    message = 'The room owner cannot be moderated.',
    status: HttpStatus = HttpStatus.FORBIDDEN,
  ) {
    super(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER, message, status);
  }
}
