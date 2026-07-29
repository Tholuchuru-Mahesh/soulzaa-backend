import { HttpStatus } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { VideoRoomPublishRole } from '@prisma/client';
import { VideoRoomMediaService } from './video-room-media.service';
import { ConnectionType, MediaProviderKind } from '../enums';

const room = { id: 'r', ownerId: 'owner', status: 'LIVE', zegoRoomId: 'zego-1', deletedAt: null };

function build(over: Partial<Record<string, unknown>> = {}) {
  const locks = { withLock: jest.fn((_k: string, fn: () => Promise<unknown>) => fn()) };
  const mediaState = {
    getSnapshot: jest.fn().mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'zego-1',
      provider: MediaProviderKind.ZEGO,
      participants: [],
    }),
    rebuild: jest.fn(),
    commit: jest
      .fn()
      .mockImplementation((_r, base, patch) => ({ ...base, ...patch, version: base.version + 1 })),
    clear: jest.fn(),
  };
  const mediaSessions = {
    start: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue(null),
    setRole: jest.fn().mockResolvedValue(undefined),
    setSelfMedia: jest.fn().mockResolvedValue(undefined),
    recordQuality: jest.fn().mockResolvedValue({ qualitySampleCount: 6 }),
  };
  const rooms = {
    findById: jest.fn().mockResolvedValue(room),
    setZegoRoomId: jest.fn().mockResolvedValue({ ...room }),
    setStreamingStatus: jest.fn().mockResolvedValue({ ...room }),
    // VR-17: default to the ENABLED policy so every pre-existing test keeps
    // exercising the real (non-gated) path rather than passing for the wrong reason.
    getSettings: jest.fn().mockResolvedValue({ allowBeauty: true, allowCameraSwitch: true }),
    requireSettings: jest.fn(),
  };
  // Task 3: requireSettings delegates to getSettings, preserving per-test overrides.
  // Production calls requireSettings; per-test getSettings overrides still work via delegation.
  rooms.requireSettings.mockImplementation(async (roomId) => {
    const row = await rooms.getSettings(roomId);
    if (!row) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return row;
  });
  const permissions = {
    resolveEffectiveRole: jest.fn().mockResolvedValue('VIEWER'),
    assertPermission: jest.fn().mockResolvedValue(undefined),
    assertOutranks: jest.fn().mockResolvedValue(undefined),
  };
  const seatState = {
    getSnapshot: jest.fn().mockResolvedValue({ seats: [{ seatIndex: 2, occupantUserId: 'u1' }] }),
    rebuild: jest.fn(),
  };
  const tokens = {
    isConfigured: jest.fn().mockReturnValue(true),
    mintMediaRoomId: jest.fn().mockReturnValue('minted'),
    issueForRoom: jest.fn().mockReturnValue({
      token: 't',
      appId: 1,
      mediaRoomId: 'zego-1',
      userId: 'u1',
      role: ConnectionType.PUBLISHER,
      expiresInSeconds: 3600,
      provider: MediaProviderKind.ZEGO,
    }),
    refresh: jest.fn().mockReturnValue({
      token: 'refreshed',
      appId: 1,
      mediaRoomId: 'zego-1',
      userId: 'u1',
      role: ConnectionType.SUBSCRIBER,
      expiresInSeconds: 3600,
      provider: MediaProviderKind.ZEGO,
    }),
  };
  const events = { appendEvent: jest.fn().mockResolvedValue(undefined) };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const cfg = {
    get: () => ({
      stateTtlSeconds: 300,
      maxSubscriptionsPerUser: 20,
      defaultBeautyLevel: 0,
      mediaHeartbeatTtlSeconds: 30,
      qualitySampleEvery: 6,
      maxBitrateKbps: 2500,
    }),
  };
  const overrides = over as Record<string, unknown>;
  const svc = new VideoRoomMediaService(
    (overrides.locks ?? locks) as never,
    (overrides.mediaState ?? mediaState) as never,
    (overrides.mediaSessions ?? mediaSessions) as never,
    (overrides.rooms ?? rooms) as never,
    (overrides.permissions ?? permissions) as never,
    (overrides.seatState ?? seatState) as never,
    (overrides.tokens ?? tokens) as never,
    (overrides.events ?? events) as never,
    (overrides.bus ?? bus) as never,
    (overrides.cfg ?? cfg) as never,
  );
  return {
    svc,
    locks,
    mediaState,
    mediaSessions,
    rooms,
    permissions,
    seatState,
    tokens,
    events,
    bus,
  };
}

describe('VideoRoomMediaService — session', () => {
  it('joinMedia as a seat occupant derives PUBLISHER + issues a publish token', async () => {
    const { svc, mediaSessions, tokens, bus, events } = build();
    const res = await svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'PUBLISHER',
        roomId: 'r',
        userId: 'u1',
        zegoRoomId: 'zego-1',
      }),
    );
    expect(tokens.issueForRoom).toHaveBeenCalledWith(
      expect.objectContaining({ canPublish: true, userId: 'u1', mediaRoomId: 'zego-1' }),
    );
    expect(res.stage.participants.some((p) => p.userId === 'u1')).toBe(true);
    expect(res.mediaSession.token).toBe('t');
    expect(bus.publish).toHaveBeenCalled();
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r', actorId: 'u1', eventType: 'media.joined' }),
    );
  });

  it('joinMedia derives SUBSCRIBER + non-publish token for an unseated user', async () => {
    const { svc, mediaSessions, tokens } = build();
    await svc.joinMedia({ id: 'u2', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'SUBSCRIBER' }),
    );
    expect(tokens.issueForRoom).toHaveBeenCalledWith(
      expect.objectContaining({ canPublish: false }),
    );
  });

  it('joinMedia grants the room OWNER a publish token even without a seat (host can go live)', async () => {
    // 'owner' === room.ownerId and holds no seat; the owner is the host/broadcaster,
    // so their token MUST grant publish or they cannot stream in production.
    const { svc, mediaSessions, tokens } = build();
    await svc.joinMedia({ id: 'owner', roles: [] } as never, 'r', {} as never);
    expect(mediaSessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'PUBLISHER' }),
    );
    expect(tokens.issueForRoom).toHaveBeenCalledWith(
      expect.objectContaining({ canPublish: true, userId: 'owner' }),
    );
  });

  it('joinMedia rejects a non-member', async () => {
    const { svc, permissions } = build();
    permissions.resolveEffectiveRole.mockResolvedValue(null);
    await expect(
      svc.joinMedia({ id: 'ghost', roles: [] } as never, 'r', {} as never),
    ).rejects.toThrow();
  });

  it('joinMedia throws NOT_FOUND for a missing room', async () => {
    const { svc, rooms } = build();
    rooms.findById.mockResolvedValue(null);
    await expect(
      svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never),
    ).rejects.toThrow();
  });

  it('joinMedia throws INVALID_STATE when the room is not live', async () => {
    const { svc, rooms } = build();
    rooms.findById.mockResolvedValue({ ...room, status: 'OFFLINE' });
    await expect(
      svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never),
    ).rejects.toThrow();
  });

  it('joinMedia 503s when the provider is unconfigured and no handle exists', async () => {
    const { svc, rooms, tokens } = build();
    rooms.findById.mockResolvedValue({ ...room, zegoRoomId: null });
    tokens.isConfigured.mockReturnValue(false);
    await expect(
      svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });

  it('joinMedia lazily mints a media room id under the lock when none exists yet', async () => {
    const { svc, rooms, tokens, locks } = build();
    rooms.findById
      .mockResolvedValueOnce({ ...room, zegoRoomId: null }) // loadLiveRoom
      .mockResolvedValueOnce({ ...room, zegoRoomId: null }); // fresh re-check inside the lock
    const res = await svc.joinMedia({ id: 'u1', roles: [] } as never, 'r', {} as never);
    expect(tokens.mintMediaRoomId).toHaveBeenCalled();
    expect(rooms.setZegoRoomId).toHaveBeenCalledWith('r', 'minted', 'u1');
    expect(locks.withLock).toHaveBeenCalledWith('video-room:media:{r}', expect.any(Function));
    expect(res.mediaSession).toBeDefined();
  });

  it('leaveMedia is idempotent and ends the durable session', async () => {
    const { svc, mediaSessions, bus, events } = build();
    const joinedAt = new Date(Date.now() - 5000);
    mediaSessions.find = jest.fn().mockResolvedValue({ joinedAt });
    await svc.leaveMedia({ id: 'u1', roles: [] } as never, 'r');
    expect(mediaSessions.end).toHaveBeenCalledWith('r', 'u1', expect.any(BigInt));
    expect(bus.publish).toHaveBeenCalled();
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r', actorId: 'u1', eventType: 'media.left' }),
    );
  });

  it('leaveMedia is a no-op when there is no active session (double leave)', async () => {
    const { svc, mediaSessions, bus } = build();
    mediaSessions.find = jest.fn().mockResolvedValue(null);
    const stage = await svc.leaveMedia({ id: 'u1', roles: [] } as never, 'r');
    expect(mediaSessions.end).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(stage.version).toBeDefined();
  });

  it('getMediaState returns the current stage view from the cached snapshot', async () => {
    const { svc, mediaState } = build();
    const stage = await svc.getMediaState({ id: 'u1', roles: [] } as never, 'r');
    expect(stage.roomId).toBe('r');
    expect(mediaState.rebuild).not.toHaveBeenCalled();
  });

  it('getMediaState rebuilds when the snapshot is cold', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue(null);
    mediaState.rebuild.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'zego-1',
      provider: MediaProviderKind.ZEGO,
      participants: [],
    });
    const stage = await svc.getMediaState({ id: 'u1', roles: [] } as never, 'r');
    expect(mediaState.rebuild).toHaveBeenCalledWith('r');
    expect(stage.roomId).toBe('r');
  });

  it('refreshToken re-issues a token for an active session', async () => {
    const { svc, mediaSessions, tokens } = build();
    mediaSessions.find = jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'PUBLISHER' });
    const session = await svc.refreshToken({ id: 'u1', roles: [] } as never, 'r');
    expect(tokens.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        mediaRoomId: 'zego-1',
        role: ConnectionType.PUBLISHER,
      }),
    );
    expect(session.token).toBe('refreshed');
  });

  it('refreshToken throws when there is no active media session', async () => {
    const { svc, mediaSessions } = build();
    mediaSessions.find = jest.fn().mockResolvedValue(null);
    await expect(svc.refreshToken({ id: 'u1', roles: [] } as never, 'r')).rejects.toThrow();
  });

  it('refreshToken throws when the session is already ended', async () => {
    const { svc, mediaSessions } = build();
    mediaSessions.find = jest.fn().mockResolvedValue({ status: 'ENDED', role: 'PUBLISHER' });
    await expect(svc.refreshToken({ id: 'u1', roles: [] } as never, 'r')).rejects.toThrow();
  });
});

describe('VideoRoomMediaService — publishing', () => {
  it('startPublish requires seat occupancy', async () => {
    const { svc, seatState } = build();
    seatState.getSnapshot.mockResolvedValue({ seats: [] }); // no occupancy
    await expect(
      svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never),
    ).rejects.toThrow();
  });
  it('startPublish moves CREATED→LIVE and sets a streamId', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: null,
          streamState: 'CREATED',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: false, facing: 'FRONT' },
          mic: { on: false, selfMuted: false, adminMuted: false },
        },
      ],
    });
    const stage = await svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never);
    const p = stage.participants.find((x) => x.userId === 'u1')!;
    expect(p.streamState).toBe('LIVE');
    expect(p.streamId).toBeTruthy();
  });
  it('startPublish rejects a duplicate active stream', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'LIVE',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    await expect(
      svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never),
    ).rejects.toThrow();
  });

  it('pausePublish on the sole LIVE publisher reconciles room streamingStatus to PAUSED and audits media.pause', async () => {
    const { svc, mediaState, rooms, events, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'LIVE',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    const stage = await svc.pausePublish({ id: 'u1', roles: [] } as never, 'r');
    const p = stage.participants.find((x) => x.userId === 'u1')!;
    expect(p.streamState).toBe('PAUSED');
    expect(rooms.setStreamingStatus).toHaveBeenCalledWith('r', 'PAUSED', 'u1');
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r', actorId: 'u1', eventType: 'media.pause' }),
    );
    expect(bus.publish).toHaveBeenCalled();
  });

  it('resumePublish reconciles room streamingStatus to PUBLISHING and audits media.resume', async () => {
    const { svc, mediaState, rooms, events, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'PAUSED',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    const stage = await svc.resumePublish({ id: 'u1', roles: [] } as never, 'r');
    const p = stage.participants.find((x) => x.userId === 'u1')!;
    expect(p.streamState).toBe('LIVE');
    expect(rooms.setStreamingStatus).toHaveBeenCalledWith('r', 'PUBLISHING', 'u1');
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r', actorId: 'u1', eventType: 'media.resume' }),
    );
    expect(bus.publish).toHaveBeenCalled();
  });

  it('a stop→republish sequence succeeds: stopPublish (STOPPED) then startPublish yields LIVE + a streamId (no 409)', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'LIVE',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    const stopped = await svc.stopPublish({ id: 'u1', roles: [] } as never, 'r');
    const stoppedParticipant = stopped.participants.find((x) => x.userId === 'u1')!;
    expect(stoppedParticipant.streamState).toBe('STOPPED');
    expect(stoppedParticipant.streamId).toBeNull();

    // Reflect the post-stop stage as the snapshot going into the republish attempt.
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: stopped.version,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: null,
          streamState: 'STOPPED',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: false, facing: 'FRONT' },
          mic: { on: false, selfMuted: false, adminMuted: false },
        },
      ],
    });
    const republished = await svc.startPublish({ id: 'u1', roles: [] } as never, 'r', {} as never);
    const p = republished.participants.find((x) => x.userId === 'u1')!;
    expect(p.streamState).toBe('LIVE');
    expect(p.streamId).toBeTruthy();
  });

  it('demoteToSubscriber flips a live publisher to subscriber', async () => {
    const { svc, mediaState, mediaSessions, events, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'LIVE',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    await svc.demoteToSubscriber('r', 'u1', 'owner');
    expect(mediaSessions.setRole).toHaveBeenCalledWith('r', 'u1', VideoRoomPublishRole.SUBSCRIBER);
    const [, , patch] = mediaState.commit.mock.calls[0];
    const p = patch.participants.find((x: { userId: string }) => x.userId === 'u1');
    expect(p.role).toBe(ConnectionType.SUBSCRIBER);
    expect(p.streamState).toBe('STOPPED');
    expect(p.streamId).toBeNull();
    expect(p.seatIndex).toBeNull();
    expect(events.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r', actorId: 'owner', eventType: 'media.demoted' }),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ roomId: 'r', userId: 'u1', streamId: null }),
      }),
    );
  });

  it('demoteToSubscriber is a no-op when the user is not publishing', async () => {
    const { svc, mediaState, mediaSessions, events, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: 2,
          streamId: 'live',
          streamState: 'LIVE',
          subscriptions: [],
          role: 'PUBLISHER',
          camera: { on: true, facing: 'FRONT' },
          mic: { on: true, selfMuted: false, adminMuted: false },
        },
      ],
    });
    await svc.demoteToSubscriber('r', 'u2', 'owner');
    expect(mediaSessions.setRole).not.toHaveBeenCalled();
    expect(mediaState.commit).not.toHaveBeenCalled();
    expect(events.appendEvent).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('demoteToSubscriber is a no-op when the user is already a demoted subscriber', async () => {
    const { svc, mediaState, mediaSessions, events, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      roomId: 'r',
      version: 1,
      updatedAt: '',
      mediaRoomId: 'z',
      provider: 'ZEGO',
      participants: [
        {
          userId: 'u1',
          seatIndex: null,
          streamId: null,
          streamState: 'STOPPED',
          subscriptions: [],
          role: 'SUBSCRIBER',
          camera: { on: false, facing: 'FRONT' },
          mic: { on: false, selfMuted: false, adminMuted: false },
        },
      ],
    });
    await svc.demoteToSubscriber('r', 'u1', 'owner');
    expect(mediaSessions.setRole).not.toHaveBeenCalled();
    expect(mediaState.commit).not.toHaveBeenCalled();
    expect(events.appendEvent).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

describe('VideoRoomMediaService — subscription', () => {
  const publisherStage = {
    roomId: 'r',
    version: 1,
    updatedAt: '',
    mediaRoomId: 'z',
    provider: 'ZEGO',
    participants: [
      {
        userId: 'u1',
        seatIndex: null,
        streamId: null,
        streamState: 'CREATED',
        subscriptions: [],
        role: 'SUBSCRIBER',
        camera: { on: false, facing: 'FRONT' },
        mic: { on: false, selfMuted: false, adminMuted: false },
      },
      {
        userId: 'pub',
        seatIndex: 0,
        streamId: 'live',
        streamState: 'LIVE',
        subscriptions: [],
        role: 'PUBLISHER',
        camera: { on: true, facing: 'FRONT' },
        mic: { on: true, selfMuted: false, adminMuted: false },
      },
    ],
  };
  it('subscribe adds a publishing target', async () => {
    const { svc, mediaState, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(publisherStage);
    const stage = await svc.subscribe({ id: 'u1', roles: [] } as never, 'r', {
      targetUserId: 'pub',
    } as never);
    expect(stage.participants.find((p) => p.userId === 'u1')!.subscriptions).toContain('pub');
    expect(bus.publish).toHaveBeenCalled();
  });
  it('subscribe rejects a non-publishing target', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({
      ...publisherStage,
      participants: [
        publisherStage.participants[0],
        { ...publisherStage.participants[1], streamId: null, streamState: 'CREATED' },
      ],
    });
    await expect(
      svc.subscribe({ id: 'u1', roles: [] } as never, 'r', { targetUserId: 'pub' } as never),
    ).rejects.toThrow();
  });
  it('subscribe enforces the per-user cap', async () => {
    const { svc, mediaState } = build();
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    mediaState.getSnapshot.mockResolvedValue({
      ...publisherStage,
      participants: [
        { ...publisherStage.participants[0], subscriptions: many },
        publisherStage.participants[1],
      ],
    });
    await expect(
      svc.subscribe({ id: 'u1', roles: [] } as never, 'r', { targetUserId: 'pub' } as never),
    ).rejects.toThrow();
  });
});

describe('VideoRoomMediaService — device controls', () => {
  const seated = {
    roomId: 'r',
    version: 1,
    updatedAt: '',
    mediaRoomId: 'z',
    provider: 'ZEGO',
    participants: [
      {
        userId: 'u1',
        seatIndex: 2,
        streamId: 'live',
        streamState: 'LIVE',
        subscriptions: [],
        role: 'PUBLISHER',
        quality: 'ADAPTIVE',
        audioOutput: 'SPEAKER',
        beauty: {
          enabled: false,
          level: 0,
          smoothSkin: 0,
          brightness: 0,
          sharpen: 0,
          faceEnhance: 0,
        },
        camera: { on: true, facing: 'FRONT' },
        mic: { on: true, selfMuted: false, adminMuted: false },
      },
    ],
  };

  it('cameraOff mutes video + writes through', async () => {
    const { svc, mediaState, mediaSessions, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    mediaSessions.setSelfMedia = jest.fn();
    const stage = await svc.cameraOff({ id: 'u1', roles: [] } as never, 'r');
    expect(stage.participants[0].camera.on).toBe(false);
    expect(mediaSessions.setSelfMedia).toHaveBeenCalledWith(
      'r',
      'u1',
      expect.objectContaining({ selfMutedVideo: true }),
    );
    expect(bus.publish).toHaveBeenCalled();
  });

  it('setSelfMute blocked when admin-muted', async () => {
    const { svc, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue({
      ...seated,
      participants: [
        { ...seated.participants[0], mic: { on: false, selfMuted: true, adminMuted: true } },
      ],
    });
    await expect(svc.setSelfMute({ id: 'u1', roles: [] } as never, 'r', false)).rejects.toThrow();
  });

  it('forceMute requires MANAGE_PARTICIPANTS + outrank', async () => {
    const { svc, permissions, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    permissions.assertPermission = jest.fn();
    permissions.assertOutranks = jest.fn();
    await svc.forceMute({ id: 'admin', roles: [] } as never, 'r', {
      targetUserId: 'u1',
      muted: true,
    });
    expect(permissions.assertPermission).toHaveBeenCalled();
    expect(permissions.assertOutranks).toHaveBeenCalledWith(expect.any(Object), 'admin', 'u1');
  });

  it('setBeauty clamps + broadcasts', async () => {
    const { svc, mediaState, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    const stage = await svc.setBeauty({ id: 'u1', roles: [] } as never, 'r', {
      enabled: true,
      level: 250,
    });
    expect(stage.participants[0].beauty.level).toBe(100);
    expect(bus.publish).toHaveBeenCalled();
  });

  it('switchCamera rejects when the actor has no media participant (seated but no session)', async () => {
    const { svc, mediaSessions } = build();
    // Default mediaState snapshot has an empty participants list, so a seated
    // user (per the default seatState mock) with no media participant yet
    // must be rejected before the write-through, not throw a raw Prisma error.
    await expect(
      svc.switchCamera({ id: 'u1', roles: [] } as never, 'r', { facing: 'REAR' } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CAMERA_ERROR });
    expect(mediaSessions.setSelfMedia).not.toHaveBeenCalled();
  });
});

describe('VideoRoomMediaService — heartbeat adaptive throttle', () => {
  const seated = {
    roomId: 'r',
    version: 1,
    updatedAt: '',
    mediaRoomId: 'z',
    provider: 'ZEGO',
    participants: [
      {
        userId: 'u1',
        seatIndex: 2,
        streamId: 'live',
        streamState: 'LIVE',
        subscriptions: [],
        role: 'PUBLISHER',
        quality: 'ADAPTIVE',
        audioOutput: 'SPEAKER',
        beauty: {
          enabled: false,
          level: 0,
          smoothSkin: 0,
          brightness: 0,
          sharpen: 0,
          faceEnhance: 0,
        },
        camera: { on: true, facing: 'FRONT' },
        mic: { on: true, selfMuted: false, adminMuted: false },
      },
    ],
  };

  it('publishes QualityChanged on the very first heartbeat (pre-increment count 0) for an ADAPTIVE publisher', async () => {
    const { svc, mediaState, mediaSessions, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    mediaSessions.find = jest
      .fn()
      .mockResolvedValue({ qualitySampleCount: 0, role: 'PUBLISHER', status: 'ACTIVE' });
    mediaSessions.recordQuality = jest.fn().mockResolvedValue(undefined);

    await svc.heartbeat({ id: 'u1', roles: [] } as never, 'r', { rttMs: 50 });

    expect(mediaSessions.recordQuality).toHaveBeenCalledWith(
      'r',
      'u1',
      expect.objectContaining({
        lastHeartbeatAt: expect.any(Date),
        qualitySampleCount: { increment: 1 },
      }),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          profile: expect.any(String),
          bitrateKbps: expect.any(Number),
        }),
      }),
    );
  });

  it('does not publish QualityChanged when the pre-increment count is not a multiple of qualitySampleEvery', async () => {
    const { svc, mediaState, mediaSessions, bus } = build();
    mediaState.getSnapshot.mockResolvedValue(seated);
    // qualitySampleEvery is 6 (per the shared cfg mock); 3 % 6 !== 0.
    mediaSessions.find = jest
      .fn()
      .mockResolvedValue({ qualitySampleCount: 3, role: 'PUBLISHER', status: 'ACTIVE' });
    mediaSessions.recordQuality = jest.fn().mockResolvedValue(undefined);

    await svc.heartbeat({ id: 'u1', roles: [] } as never, 'r', { rttMs: 50 });

    expect(mediaSessions.recordQuality).toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does not publish QualityChanged for a non-ADAPTIVE participant, even on count 0', async () => {
    const { svc, mediaState, mediaSessions, bus } = build();
    mediaState.getSnapshot.mockResolvedValue({
      ...seated,
      participants: [{ ...seated.participants[0], quality: 'HD' }],
    });
    mediaSessions.find = jest
      .fn()
      .mockResolvedValue({ qualitySampleCount: 0, role: 'PUBLISHER', status: 'ACTIVE' });
    mediaSessions.recordQuality = jest.fn().mockResolvedValue(undefined);

    await svc.heartbeat({ id: 'u1', roles: [] } as never, 'r', { rttMs: 50 });

    expect(mediaSessions.recordQuality).toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

describe('VideoRoomMediaService — VR-17 media policy gates', () => {
  const seatedForCamera = {
    roomId: 'r',
    version: 1,
    updatedAt: '',
    mediaRoomId: 'z',
    provider: 'ZEGO',
    participants: [
      {
        userId: 'u1',
        seatIndex: 2,
        streamId: 'live',
        streamState: 'LIVE',
        subscriptions: [],
        role: 'PUBLISHER',
        camera: { on: true, facing: 'FRONT' },
        mic: { on: true, selfMuted: false, adminMuted: false },
      },
    ],
  };
  const seatedForBeauty = {
    ...seatedForCamera,
    participants: [
      {
        ...seatedForCamera.participants[0],
        beauty: {
          enabled: false,
          level: 0,
          smoothSkin: 0,
          brightness: 0,
          sharpen: 0,
          faceEnhance: 0,
        },
      },
    ],
  };

  it('setBeauty rejects with VIDEO_ROOM_FORBIDDEN when allowBeauty is disabled, without mutating the stage', async () => {
    const { svc, rooms, mediaState } = build();
    rooms.getSettings.mockResolvedValue({ allowBeauty: false, allowCameraSwitch: true });
    await expect(
      svc.setBeauty({ id: 'u1', roles: [] } as never, 'r', { enabled: true, level: 50 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN });
    expect(mediaState.commit).not.toHaveBeenCalled();
  });

  it('setBeauty resolves when allowBeauty is enabled', async () => {
    const { svc, rooms, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue(seatedForBeauty);
    rooms.getSettings.mockResolvedValue({ allowBeauty: true, allowCameraSwitch: true });
    await expect(
      svc.setBeauty({ id: 'u1', roles: [] } as never, 'r', { enabled: true, level: 50 }),
    ).resolves.toBeDefined();
  });

  it('switchCamera rejects with VIDEO_ROOM_FORBIDDEN when allowCameraSwitch is disabled, without mutating the stage', async () => {
    const { svc, rooms, mediaState } = build();
    rooms.getSettings.mockResolvedValue({ allowBeauty: true, allowCameraSwitch: false });
    await expect(
      svc.switchCamera({ id: 'u1', roles: [] } as never, 'r', { facing: 'REAR' } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN });
    expect(mediaState.commit).not.toHaveBeenCalled();
  });

  it('switchCamera resolves when allowCameraSwitch is enabled', async () => {
    const { svc, rooms, mediaState } = build();
    mediaState.getSnapshot.mockResolvedValue(seatedForCamera);
    rooms.getSettings.mockResolvedValue({ allowBeauty: true, allowCameraSwitch: true });
    await expect(
      svc.switchCamera({ id: 'u1', roles: [] } as never, 'r', { facing: 'REAR' } as never),
    ).resolves.toBeDefined();
  });

  it('switchCamera runs the seating check BEFORE the policy gate', async () => {
    const { svc, seatState, rooms } = build();
    seatState.getSnapshot.mockResolvedValue({ seats: [] }); // u1 holds no seat
    await expect(
      svc.switchCamera({ id: 'u1', roles: [] } as never, 'r', { facing: 'REAR' } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_MEDIA_SEAT_REQUIRED });
    expect(rooms.requireSettings).not.toHaveBeenCalled();
  });

  // The two media policy flags are the only settings reads in this service.
  // A missing row must not silently permit beauty/camera-switch.
  it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
    const { svc, rooms } = build();
    rooms.requireSettings.mockRejectedValue(
      new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
    );
    await expect(
      svc.setBeauty({ id: 'u1', roles: [] } as never, 'r', { enabled: true, level: 50 }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING });
  });
});
