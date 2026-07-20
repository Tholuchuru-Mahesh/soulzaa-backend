import { VideoRoomMediaRecoveryService } from './video-room-media-recovery.service';
import { MediaProviderKind } from '../enums';

function build() {
  const stageWith = (streamState: string) => ({
    roomId: 'r',
    version: 1,
    updatedAt: '',
    mediaRoomId: 'z',
    provider: MediaProviderKind.ZEGO,
    participants: [
      {
        userId: 'u1',
        seatIndex: 0,
        streamId: 'live',
        streamState,
        subscriptions: [],
        role: 'PUBLISHER',
        connection: 'RECONNECTING',
        camera: { on: true, facing: 'FRONT' },
        mic: { on: true, selfMuted: false, adminMuted: false },
      },
    ],
  });
  const media = {
    mutateStage: jest.fn().mockImplementation((_r, fn) => fn(stageWith('RECOVERING'))),
    leaveMedia: jest.fn(),
  };
  const mediaState = {
    commit: jest
      .fn()
      .mockImplementation((_r, base, patch) => ({ ...base, ...patch, version: base.version + 1 })),
    getSnapshot: jest.fn(),
  };
  const mediaSessions = {
    find: jest.fn().mockResolvedValue({ role: 'PUBLISHER', status: 'ACTIVE' }),
    start: jest.fn(),
  };
  const rooms = {
    findById: jest.fn().mockResolvedValue({
      id: 'r',
      ownerId: 'o',
      status: 'LIVE',
      zegoRoomId: 'z',
      deletedAt: null,
    }),
  };
  const tokens = { issueForRoom: jest.fn().mockReturnValue({ token: 't' }) };
  const events = {
    findLatestSnapshot: jest.fn().mockResolvedValue(null),
    saveSnapshot: jest.fn(),
    appendEvent: jest.fn(),
  };
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const bus = { publish: jest.fn() };
  const cfg = {
    get: () => ({ stateTtlSeconds: 300, mediaRecoveryTokenTtlSeconds: 60, defaultBeautyLevel: 0 }),
  };
  const svc = new VideoRoomMediaRecoveryService(
    media as never,
    mediaState as never,
    mediaSessions as never,
    rooms as never,
    tokens as never,
    events as never,
    cache as never,
    bus as never,
    cfg as never,
  );
  return { svc, media, mediaState, mediaSessions, cache, bus, events, stageWith };
}

describe('VideoRoomMediaRecoveryService', () => {
  it('recover reactivates the session, flips RECOVERING→LIVE, reissues token, clears the token key', async () => {
    const { svc, media, mediaSessions, cache, bus } = build();
    const res = await svc.recover({ id: 'u1', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalled();
    expect(media.mutateStage).toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith('video-room:{r}:media:recovery:u1');
    expect(res.mediaSession).toBeDefined();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('recover fails without a durable session', async () => {
    const { svc, mediaSessions } = build();
    mediaSessions.find.mockResolvedValue(null);
    await expect(svc.recover({ id: 'u1', roles: [] } as never, 'r', {} as never)).rejects.toThrow();
  });

  it('expireRecovery ends media + publishes MediaFailed', async () => {
    const { svc, media, bus } = build();
    await svc.expireRecovery('r', 'u1');
    expect(media.leaveMedia).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r');
    expect(bus.publish).toHaveBeenCalled();
  });

  it('markRecovering flips a LIVE participant to RECOVERING, arms the recovery token, publishes StreamStateChanged', async () => {
    const { svc, media, mediaState, cache, bus, stageWith } = build();
    media.mutateStage.mockImplementationOnce((_r: string, fn: (base: unknown) => unknown) =>
      fn(stageWith('LIVE')),
    );
    await svc.markRecovering('r', 'u1');
    expect(mediaState.commit).toHaveBeenCalled();
    const [, , patch] = mediaState.commit.mock.calls[0];
    expect(patch.participants[0]).toMatchObject({
      streamState: 'RECOVERING',
      connection: 'RECONNECTING',
    });
    expect(cache.set).toHaveBeenCalledWith(
      'video-room:{r}:media:recovery:u1',
      expect.any(Object),
      60,
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ roomId: 'r', userId: 'u1', streamState: 'RECOVERING' }),
      }),
    );
  });

  it('markRecovering skips the FSM transition when the participant is not LIVE (idempotent mutateStage)', async () => {
    // default build() stage has streamState 'RECOVERING', so the participant is not LIVE:
    // the mutateStage callback takes its early-return branch and never calls mediaState.commit.
    // (The token-arm + publish after mutateStage are unconditional in the existing implementation
    // and are intentionally left as-is here — only the FSM transition itself is idempotent.)
    const { svc, mediaState } = build();
    await svc.markRecovering('r', 'u1');
    expect(mediaState.commit).not.toHaveBeenCalled();
  });

  it('reportStreamFailure marks FAILED, arms the recovery token, publishes MediaFailed with the given reason', async () => {
    const { svc, mediaState, cache, bus } = build();
    await svc.reportStreamFailure('r', 'u1', 'ice_disconnected');
    expect(mediaState.commit).toHaveBeenCalled();
    const [, , patch] = mediaState.commit.mock.calls[0];
    expect(patch.participants[0]).toMatchObject({
      streamState: 'FAILED',
      connection: 'RECONNECTING',
    });
    expect(cache.set).toHaveBeenCalledWith(
      'video-room:{r}:media:recovery:u1',
      expect.any(Object),
      60,
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          roomId: 'r',
          userId: 'u1',
          reason: 'ice_disconnected',
        }),
      }),
    );
  });

  it('recover cold-restores an absent participant from the latest durable snapshot, resolved before mutateStage', async () => {
    const { svc, media, events } = build();
    const priorParticipant = {
      userId: 'u1',
      seatIndex: 3,
      streamId: 'old-stream',
      streamState: 'LIVE',
      subscriptions: [],
      role: 'PUBLISHER',
      connection: 'DISCONNECTED',
      camera: { on: true, facing: 'FRONT' },
      mic: { on: true, selfMuted: false, adminMuted: false },
    };
    events.findLatestSnapshot.mockResolvedValueOnce({
      state: { participants: [priorParticipant] },
    });
    // Base stage is missing 'u1' entirely — forces the absent-participant branch in recover().
    media.mutateStage.mockImplementationOnce((_r: string, fn: (base: unknown) => unknown) =>
      fn({
        roomId: 'r',
        version: 1,
        updatedAt: '',
        mediaRoomId: 'z',
        provider: MediaProviderKind.ZEGO,
        participants: [],
      }),
    );

    const res = await svc.recover({ id: 'u1', roles: [] } as never, 'r', {} as never);

    expect(events.findLatestSnapshot).toHaveBeenCalledWith('r');
    // The DB read must resolve before the lock-guarded mutateStage call, not inside it.
    const snapshotOrder = events.findLatestSnapshot.mock.invocationCallOrder[0];
    const mutateOrder = media.mutateStage.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(mutateOrder);

    const restored = res.stage.participants.find((p: { userId: string }) => p.userId === 'u1');
    expect(restored).toMatchObject({ streamState: 'LIVE', connection: 'CONNECTED' });
  });
});
