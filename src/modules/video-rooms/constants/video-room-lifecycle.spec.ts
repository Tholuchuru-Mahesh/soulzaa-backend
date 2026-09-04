import { VideoRoomStatus, VideoRoomStreamingStatus, VideoRoomVisibility } from '@prisma/client';
import {
  VideoRoomAccessPolicy,
  VideoRoomLifecycleState,
  deriveAccessPolicy,
  isValidStatusTransition,
  projectLifecycleState,
} from './video-room-lifecycle';

/** Minimal row factory for the projection helpers. */
function row(
  overrides: Partial<{
    status: VideoRoomStatus;
    giftLockEnabled: boolean;
    streamingStatus: VideoRoomStreamingStatus;
    deletedAt: Date | null;
    visibility: VideoRoomVisibility;
    metadata: unknown;
  }> = {},
) {
  return {
    status: VideoRoomStatus.OFFLINE,
    giftLockEnabled: false,
    streamingStatus: VideoRoomStreamingStatus.IDLE,
    deletedAt: null,
    visibility: VideoRoomVisibility.PUBLIC,
    metadata: null,
    ...overrides,
  };
}

describe('projectLifecycleState', () => {
  it('projects a soft-deleted room as DELETED regardless of status', () => {
    expect(
      projectLifecycleState(row({ status: VideoRoomStatus.LIVE, deletedAt: new Date() })),
    ).toBe(VideoRoomLifecycleState.DELETED);
  });

  it('projects an ended+archived room as ARCHIVED', () => {
    expect(
      projectLifecycleState(
        row({ status: VideoRoomStatus.ENDED, metadata: { archivedAt: '2026-07-20T00:00:00Z' } }),
      ),
    ).toBe(VideoRoomLifecycleState.ARCHIVED);
  });

  it('projects an ended room as ENDED', () => {
    expect(projectLifecycleState(row({ status: VideoRoomStatus.ENDED }))).toBe(
      VideoRoomLifecycleState.ENDED,
    );
  });

  it('projects a live+paused room as PAUSED', () => {
    expect(
      projectLifecycleState(
        row({ status: VideoRoomStatus.LIVE, streamingStatus: VideoRoomStreamingStatus.PAUSED }),
      ),
    ).toBe(VideoRoomLifecycleState.PAUSED);
  });

  it('projects a live+gift-locked room as LOCKED', () => {
    expect(
      projectLifecycleState(row({ status: VideoRoomStatus.LIVE, giftLockEnabled: true })),
    ).toBe(VideoRoomLifecycleState.LOCKED);
  });

  it('projects a live room as ACTIVE', () => {
    expect(projectLifecycleState(row({ status: VideoRoomStatus.LIVE }))).toBe(
      VideoRoomLifecycleState.ACTIVE,
    );
  });

  it('projects an offline room as CREATED', () => {
    expect(projectLifecycleState(row({ status: VideoRoomStatus.OFFLINE }))).toBe(
      VideoRoomLifecycleState.CREATED,
    );
  });
});

describe('isValidStatusTransition', () => {
  it('allows OFFLINE -> LIVE (activate)', () => {
    expect(isValidStatusTransition(VideoRoomStatus.OFFLINE, VideoRoomStatus.LIVE)).toBe(true);
  });

  it('allows OFFLINE -> ENDED (close before live)', () => {
    expect(isValidStatusTransition(VideoRoomStatus.OFFLINE, VideoRoomStatus.ENDED)).toBe(true);
  });

  it('allows LIVE -> ENDED (close)', () => {
    expect(isValidStatusTransition(VideoRoomStatus.LIVE, VideoRoomStatus.ENDED)).toBe(true);
  });

  it('allows ENDED -> OFFLINE (reopen)', () => {
    expect(isValidStatusTransition(VideoRoomStatus.ENDED, VideoRoomStatus.OFFLINE)).toBe(true);
  });

  it('rejects LIVE -> OFFLINE', () => {
    expect(isValidStatusTransition(VideoRoomStatus.LIVE, VideoRoomStatus.OFFLINE)).toBe(false);
  });

  it('rejects ENDED -> LIVE (must reopen first)', () => {
    expect(isValidStatusTransition(VideoRoomStatus.ENDED, VideoRoomStatus.LIVE)).toBe(false);
  });

  it('rejects a no-op transition to the same status', () => {
    expect(isValidStatusTransition(VideoRoomStatus.LIVE, VideoRoomStatus.LIVE)).toBe(false);
  });
});

describe('deriveAccessPolicy', () => {
  it('reads an explicit access policy from metadata', () => {
    expect(
      deriveAccessPolicy(row({ metadata: { accessPolicy: VideoRoomAccessPolicy.VIP_ONLY } })),
    ).toBe(VideoRoomAccessPolicy.VIP_ONLY);
  });

  it('derives PUBLIC/PRIVATE from visibility alone, ignoring gift-lock', () => {
    expect(deriveAccessPolicy(row({ giftLockEnabled: true }))).toBe(VideoRoomAccessPolicy.PUBLIC);
    expect(
      deriveAccessPolicy(row({ giftLockEnabled: true, visibility: VideoRoomVisibility.PRIVATE })),
    ).toBe(VideoRoomAccessPolicy.PRIVATE);
  });

  it('derives PRIVATE from a private room', () => {
    expect(deriveAccessPolicy(row({ visibility: VideoRoomVisibility.PRIVATE }))).toBe(
      VideoRoomAccessPolicy.PRIVATE,
    );
  });

  it('derives PUBLIC from a public room', () => {
    expect(deriveAccessPolicy(row({ visibility: VideoRoomVisibility.PUBLIC }))).toBe(
      VideoRoomAccessPolicy.PUBLIC,
    );
  });

  it('ignores an invalid metadata access policy and falls back', () => {
    expect(deriveAccessPolicy(row({ metadata: { accessPolicy: 'NONSENSE' } }))).toBe(
      VideoRoomAccessPolicy.PUBLIC,
    );
  });
});
