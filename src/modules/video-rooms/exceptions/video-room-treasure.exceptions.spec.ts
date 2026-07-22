import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  DuplicateRewardException,
  RewardDistributionException,
  RewardPoolException,
  TreasureBoxException,
  TreasureProgressException,
  TreasureUnlockException,
  WinnerSelectionException,
} from './video-room-treasure.exceptions';

type Ctor = new (message: string, status?: HttpStatus) => BusinessException;

const CASES: [string, Ctor, string][] = [
  ['TreasureBoxException', TreasureBoxException, ERROR_CODES.VIDEO_ROOM_TREASURE_INVALID],
  [
    'TreasureProgressException',
    TreasureProgressException,
    ERROR_CODES.VIDEO_ROOM_TREASURE_PROGRESS_FAILED,
  ],
  [
    'TreasureUnlockException',
    TreasureUnlockException,
    ERROR_CODES.VIDEO_ROOM_TREASURE_UNLOCK_FAILED,
  ],
  ['RewardPoolException', RewardPoolException, ERROR_CODES.VIDEO_ROOM_TREASURE_POOL_INVALID],
  [
    'WinnerSelectionException',
    WinnerSelectionException,
    ERROR_CODES.VIDEO_ROOM_TREASURE_WINNER_SELECTION_FAILED,
  ],
  [
    'RewardDistributionException',
    RewardDistributionException,
    ERROR_CODES.VIDEO_ROOM_TREASURE_DISTRIBUTION_FAILED,
  ],
  [
    'DuplicateRewardException',
    DuplicateRewardException,
    ERROR_CODES.VIDEO_ROOM_TREASURE_DUPLICATE_REWARD,
  ],
];

describe('video-room treasure exceptions', () => {
  it.each(CASES)('%s binds its own error code', (_name, Ctor, code) => {
    expect(new Ctor('boom').errorCode).toBe(code);
  });

  it.each(CASES)('%s extends BusinessException so the filter handles it', (_n, Ctor) => {
    expect(new Ctor('boom')).toBeInstanceOf(BusinessException);
  });

  // 409, not 400: every one of these fires when the request was well-formed but
  // the treasure state disallows it. A 400 would tell the client to fix its
  // payload, which is the wrong instruction.
  it.each(CASES)('%s defaults to 409 CONFLICT', (_n, Ctor) => {
    expect(new Ctor('boom').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('accepts a status override for the cases that are not conflicts', () => {
    expect(new TreasureBoxException('x', HttpStatus.FORBIDDEN).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
    expect(new TreasureBoxException('x', HttpStatus.NOT_FOUND).getStatus()).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('surfaces the message in the response envelope', () => {
    const err = new TreasureUnlockException('Box b1 is OPENED, expected UNLOCKING.');
    expect(err.getResponse()).toEqual(
      expect.objectContaining({
        message: 'Box b1 is OPENED, expected UNLOCKING.',
        errorCode: ERROR_CODES.VIDEO_ROOM_TREASURE_UNLOCK_FAILED,
      }),
    );
  });
});
