import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  BlacklistException,
  KickException,
  ModerationException,
  MuteException,
  OwnerProtectionException,
  ReportException,
  WarningException,
} from './video-room-moderation.exceptions';

type ParameterizedCtor = new (
  errorCode: string,
  message: string,
  status?: HttpStatus,
) => BusinessException;

const PARAMETERIZED_CASES: [string, ParameterizedCtor][] = [
  ['ModerationException', ModerationException],
  ['KickException', KickException],
  ['MuteException', MuteException],
  ['BlacklistException', BlacklistException],
  ['WarningException', WarningException],
  ['ReportException', ReportException],
];

describe('video-room moderation exceptions', () => {
  it('carries errorCode + status', () => {
    const e = new OwnerProtectionException();
    expect(e.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER);
    expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
    const m = new MuteException(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED, 'x', HttpStatus.CONFLICT);
    expect(m.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED);
  });

  it.each(PARAMETERIZED_CASES)('%s extends BusinessException', (_name, Ctor) => {
    expect(new Ctor(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF, 'boom')).toBeInstanceOf(
      BusinessException,
    );
  });

  it.each(PARAMETERIZED_CASES)('%s binds whichever error code it is given', (_name, Ctor) => {
    expect(new Ctor(ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND, 'boom').errorCode).toBe(
      ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND,
    );
  });

  // 409, not 400: each of these fires when the request was well-formed but the
  // moderation state disallows it (already muted, no pending report, ...).
  it.each(PARAMETERIZED_CASES)('%s defaults to 409 CONFLICT', (_name, Ctor) => {
    expect(new Ctor(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED, 'boom').getStatus()).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it.each(PARAMETERIZED_CASES)('%s allows an explicit status override', (_name, Ctor) => {
    expect(
      new Ctor(
        ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
        'boom',
        HttpStatus.FORBIDDEN,
      ).getStatus(),
    ).toBe(HttpStatus.FORBIDDEN);
  });

  describe('OwnerProtectionException', () => {
    it('defaults to the reused VIDEO_ROOM_CANNOT_MODERATE_OWNER code, message, and 403', () => {
      const e = new OwnerProtectionException();
      expect(e.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER);
      expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect((e.getResponse() as { message: string }).message).toBe(
        'The room owner cannot be moderated.',
      );
    });

    it('allows overriding the message and status while keeping the code fixed', () => {
      const e = new OwnerProtectionException('custom message', HttpStatus.CONFLICT);
      expect(e.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER);
      expect(e.getStatus()).toBe(HttpStatus.CONFLICT);
      expect((e.getResponse() as { message: string }).message).toBe('custom message');
    });
  });

  it('registers the new Phase 16 moderation error codes', () => {
    expect(ERROR_CODES.VIDEO_ROOM_ALREADY_BLOCKED).toBe('VIDEO_ROOM_ALREADY_BLOCKED');
    expect(ERROR_CODES.VIDEO_ROOM_BLOCK_NOT_FOUND).toBe('VIDEO_ROOM_BLOCK_NOT_FOUND');
    expect(ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED).toBe('VIDEO_ROOM_ALREADY_MUTED');
    expect(ERROR_CODES.VIDEO_ROOM_MUTE_NOT_FOUND).toBe('VIDEO_ROOM_MUTE_NOT_FOUND');
    expect(ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF).toBe('VIDEO_ROOM_CANNOT_MODERATE_SELF');
    expect(ERROR_CODES.VIDEO_ROOM_DUPLICATE_REPORT).toBe('VIDEO_ROOM_DUPLICATE_REPORT');
    expect(ERROR_CODES.VIDEO_ROOM_REPORT_NOT_FOUND).toBe('VIDEO_ROOM_REPORT_NOT_FOUND');
    expect(ERROR_CODES.VIDEO_ROOM_REPORT_NOT_PENDING).toBe('VIDEO_ROOM_REPORT_NOT_PENDING');
  });
});
