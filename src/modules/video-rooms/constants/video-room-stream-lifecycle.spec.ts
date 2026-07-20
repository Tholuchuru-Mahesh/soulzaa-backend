import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { MediaStreamState } from '../enums';
import {
  canStreamTransition,
  assertStreamTransition,
  STREAM_TRANSITIONS,
} from './video-room-stream-lifecycle';

describe('stream lifecycle', () => {
  it('allows legal edges', () => {
    expect(canStreamTransition(MediaStreamState.CREATED, MediaStreamState.CONNECTING)).toBe(true);
    expect(canStreamTransition(MediaStreamState.CONNECTING, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.LIVE, MediaStreamState.RECOVERING)).toBe(true);
    expect(canStreamTransition(MediaStreamState.RECOVERING, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.PAUSED, MediaStreamState.LIVE)).toBe(true);
    expect(canStreamTransition(MediaStreamState.STOPPED, MediaStreamState.CREATED)).toBe(true);
  });
  it('allows STOPPED → CONNECTING (republish-after-stop)', () => {
    expect(canStreamTransition(MediaStreamState.STOPPED, MediaStreamState.CONNECTING)).toBe(true);
    expect(() =>
      assertStreamTransition(MediaStreamState.STOPPED, MediaStreamState.CONNECTING),
    ).not.toThrow();
  });
  it('rejects illegal edges', () => {
    expect(canStreamTransition(MediaStreamState.CREATED, MediaStreamState.LIVE)).toBe(false);
    expect(canStreamTransition(MediaStreamState.ENDED, MediaStreamState.LIVE)).toBe(false);
    expect(canStreamTransition(MediaStreamState.STOPPED, MediaStreamState.PAUSED)).toBe(false);
  });
  it('treats a self-transition as legal (idempotent)', () => {
    expect(canStreamTransition(MediaStreamState.LIVE, MediaStreamState.LIVE)).toBe(true);
    expect(() =>
      assertStreamTransition(MediaStreamState.ENDED, MediaStreamState.ENDED),
    ).not.toThrow();
  });
  it('assertStreamTransition throws a CONFLICT BusinessException with the stream code on an illegal edge', () => {
    expect(() => assertStreamTransition(MediaStreamState.ENDED, MediaStreamState.LIVE)).toThrow(
      BusinessException,
    );
    let caught: BusinessException | undefined;
    try {
      assertStreamTransition(MediaStreamState.ENDED, MediaStreamState.LIVE);
    } catch (e) {
      caught = e as BusinessException;
    }
    expect(caught?.errorCode).toBe(ERROR_CODES.VIDEO_ROOM_STREAM_INVALID_STATE);
    expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
  });
  it('every state is a key in the transition table', () => {
    for (const s of Object.values(MediaStreamState)) expect(STREAM_TRANSITIONS[s]).toBeDefined();
  });
});
