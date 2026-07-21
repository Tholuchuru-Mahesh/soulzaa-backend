import { VideoRoomInvitationStatus, VideoRoomSeatRequestStatus } from '@prisma/client';
import {
  SEAT_INVITATION_TRANSITIONS,
  SEAT_REQUEST_TRANSITIONS,
  canTransitionInvitation,
  canTransitionRequest,
  isTerminalInvitationStatus,
  isTerminalRequestStatus,
} from './video-room-seat-workflow';

const R = VideoRoomSeatRequestStatus;
const I = VideoRoomInvitationStatus;

describe('seat request transitions', () => {
  it.each([
    [R.PENDING, R.ACCEPTED],
    [R.PENDING, R.REJECTED],
    [R.PENDING, R.CANCELLED],
    [R.PENDING, R.EXPIRED],
    [R.ACCEPTED, R.PROMOTED],
    [R.ACCEPTED, R.FAILED],
    [R.FAILED, R.PENDING],
    [R.EXPIRED, R.PENDING],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(true);
  });

  it.each([
    [R.PROMOTED, R.PENDING],
    [R.PROMOTED, R.FAILED],
    [R.REJECTED, R.ACCEPTED],
    [R.CANCELLED, R.ACCEPTED],
    [R.PENDING, R.PROMOTED],
    [R.PENDING, R.PENDING],
    [R.ACCEPTED, R.REJECTED],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(false);
  });

  it('treats PROMOTED, REJECTED and CANCELLED as terminal', () => {
    expect(isTerminalRequestStatus(R.PROMOTED)).toBe(true);
    expect(isTerminalRequestStatus(R.REJECTED)).toBe(true);
    expect(isTerminalRequestStatus(R.CANCELLED)).toBe(true);
  });

  it('does not treat recoverable states as terminal', () => {
    expect(isTerminalRequestStatus(R.PENDING)).toBe(false);
    expect(isTerminalRequestStatus(R.FAILED)).toBe(false);
    expect(isTerminalRequestStatus(R.EXPIRED)).toBe(false);
  });

  it('declares an entry for every status so no state is unreachable by omission', () => {
    for (const status of Object.values(R)) {
      expect(SEAT_REQUEST_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never allows a self-transition', () => {
    for (const status of Object.values(R)) {
      expect(canTransitionRequest(status, status)).toBe(false);
    }
  });
});

describe('seat invitation transitions', () => {
  it.each([
    [I.PENDING, I.DELIVERED],
    [I.PENDING, I.ACCEPTED],
    [I.PENDING, I.REJECTED],
    [I.PENDING, I.CANCELLED],
    [I.PENDING, I.EXPIRED],
    [I.DELIVERED, I.ACCEPTED],
    [I.DELIVERED, I.REJECTED],
    [I.DELIVERED, I.CANCELLED],
    [I.DELIVERED, I.EXPIRED],
    [I.DELIVERED, I.FAILED],
    [I.FAILED, I.PENDING],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionInvitation(from, to)).toBe(true);
  });

  it.each([
    [I.ACCEPTED, I.PENDING],
    [I.REJECTED, I.ACCEPTED],
    [I.CANCELLED, I.DELIVERED],
    [I.DELIVERED, I.PENDING],
    [I.EXPIRED, I.ACCEPTED],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransitionInvitation(from, to)).toBe(false);
  });

  it('declares an entry for every status', () => {
    for (const status of Object.values(I)) {
      expect(SEAT_INVITATION_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('treats ACCEPTED, REJECTED and CANCELLED as terminal', () => {
    expect(isTerminalInvitationStatus(I.ACCEPTED)).toBe(true);
    expect(isTerminalInvitationStatus(I.REJECTED)).toBe(true);
    expect(isTerminalInvitationStatus(I.CANCELLED)).toBe(true);
  });
});
