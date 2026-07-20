import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { MediaStreamState } from '../enums';

/**
 * The single source of truth for legal media-stream transitions (VR-5). Mirrors
 * the seat/lifecycle transition tables. Every mutation that changes a
 * participant's streamState routes through assertStreamTransition first.
 */
export const STREAM_TRANSITIONS: Record<MediaStreamState, readonly MediaStreamState[]> = {
  [MediaStreamState.CREATED]: [MediaStreamState.CONNECTING, MediaStreamState.ENDED],
  [MediaStreamState.CONNECTING]: [
    MediaStreamState.LIVE,
    MediaStreamState.FAILED,
    MediaStreamState.ENDED,
  ],
  [MediaStreamState.LIVE]: [
    MediaStreamState.PAUSED,
    MediaStreamState.STOPPED,
    MediaStreamState.FAILED,
    MediaStreamState.RECOVERING,
  ],
  [MediaStreamState.PAUSED]: [
    MediaStreamState.LIVE,
    MediaStreamState.STOPPED,
    MediaStreamState.ENDED,
  ],
  [MediaStreamState.STOPPED]: [
    MediaStreamState.CREATED,
    MediaStreamState.CONNECTING,
    MediaStreamState.ENDED,
  ],
  [MediaStreamState.FAILED]: [MediaStreamState.RECOVERING, MediaStreamState.ENDED],
  [MediaStreamState.RECOVERING]: [
    MediaStreamState.LIVE,
    MediaStreamState.FAILED,
    MediaStreamState.ENDED,
  ],
  [MediaStreamState.ENDED]: [],
};

/** True when `from → to` is a legal stream transition (self-edge always allowed — idempotent). */
export function canStreamTransition(from: MediaStreamState, to: MediaStreamState): boolean {
  if (from === to) return true;
  return STREAM_TRANSITIONS[from].includes(to);
}

/** Assert a legal stream transition; else 409. */
export function assertStreamTransition(from: MediaStreamState, to: MediaStreamState): void {
  if (!canStreamTransition(from, to)) {
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE,
      `Illegal stream transition ${from} → ${to}.`,
      HttpStatus.CONFLICT,
    );
  }
}
