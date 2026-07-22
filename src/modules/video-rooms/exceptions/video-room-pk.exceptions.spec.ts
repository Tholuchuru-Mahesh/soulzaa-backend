import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  BattleRecoveryException,
  DuplicatePKException,
  PKBattleException,
  PKCountdownException,
  PKInvitationException,
  PKRewardException,
  PKScoreException,
  PKWinnerException,
} from './video-room-pk.exceptions';

type Ctor = new (message: string, status?: HttpStatus) => BusinessException;

const CASES: [string, Ctor, string][] = [
  ['PKBattleException', PKBattleException, ERROR_CODES.VIDEO_ROOM_PK_INVALID],
  ['PKInvitationException', PKInvitationException, ERROR_CODES.VIDEO_ROOM_PK_INVITATION_FAILED],
  ['PKScoreException', PKScoreException, ERROR_CODES.VIDEO_ROOM_PK_SCORE_FAILED],
  ['PKRewardException', PKRewardException, ERROR_CODES.VIDEO_ROOM_PK_REWARD_FAILED],
  ['PKWinnerException', PKWinnerException, ERROR_CODES.VIDEO_ROOM_PK_WINNER_FAILED],
  ['DuplicatePKException', DuplicatePKException, ERROR_CODES.VIDEO_ROOM_PK_ALREADY_ACTIVE],
  ['PKCountdownException', PKCountdownException, ERROR_CODES.VIDEO_ROOM_PK_COUNTDOWN_FAILED],
  ['BattleRecoveryException', BattleRecoveryException, ERROR_CODES.VIDEO_ROOM_PK_RECOVERY_FAILED],
];

describe('video-room PK exceptions', () => {
  it.each(CASES)('%s binds its own error code', (_n, Ctor, code) => {
    expect(new Ctor('boom').errorCode).toBe(code);
  });

  it.each(CASES)('%s extends BusinessException so the filter handles it', (_n, Ctor) => {
    expect(new Ctor('boom')).toBeInstanceOf(BusinessException);
  });

  // 409, not 400: each fires when the request was well-formed but the PK state
  // disallows it. A 400 would tell the client to fix its payload — wrong advice.
  it.each(CASES)('%s defaults to 409 CONFLICT', (_n, Ctor) => {
    expect(new Ctor('boom').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('allows an explicit status override', () => {
    expect(new PKBattleException('nope', HttpStatus.FORBIDDEN).getStatus()).toBe(403);
  });
});
