import { VoicePublishRole } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { QueueService } from 'src/infra/queue/queue.service';
import { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import type { IAudioRoomsService } from '../interfaces/audio-rooms.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import { VoiceSessionRepository } from '../repositories/voice-session.repository';
import { VoiceService } from './voice.service';

const ACTOR: RoomActor = { id: 'user-1', roles: ['USER'] };

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    roomId: 'room-1',
    userId: ACTOR.id,
    zegoRoomId: 'zego-1',
    role: VoicePublishRole.SUBSCRIBER,
    status: 'ACTIVE',
    selfMuted: false,
    isSpeaking: false,
    inBackground: false,
    audioRoute: null,
    reconnectCount: 0,
    joinedAt: new Date(Date.now() - 30_000),
    qualitySampleCount: 0,
    avgRttMs: null,
    worstRttMs: null,
    avgPacketLossPct: null,
    ...overrides,
  } as never;
}

describe('VoiceService', () => {
  let voice: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let zego: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let queue: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let roomsSvc: Record<string, jest.Mock>;
  let service: VoiceService;

  beforeEach(() => {
    voice = {
      getActiveSession: jest.fn().mockResolvedValue(null),
      findSession: jest.fn().mockResolvedValue(null),
      upsertJoin: jest.fn().mockResolvedValue({ session: session(), wasActive: false }),
      endSession: jest.fn().mockResolvedValue(undefined),
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
      updateSelfMute: jest.fn().mockResolvedValue(undefined),
      updateSpeaking: jest.fn().mockResolvedValue(undefined),
      updateRoute: jest.fn().mockResolvedValue(undefined),
      updateBackground: jest.fn().mockResolvedValue(undefined),
      updateRole: jest.fn().mockResolvedValue(undefined),
      updateQualityRolling: jest.fn().mockResolvedValue(undefined),
      addVoicePresence: jest.fn().mockResolvedValue(undefined),
      removeVoicePresence: jest.fn().mockResolvedValue(undefined),
      setHeartbeat: jest.fn().mockResolvedValue(undefined),
      clearHeartbeat: jest.fn().mockResolvedValue(undefined),
      addSpeaking: jest.fn().mockResolvedValue(undefined),
      removeSpeaking: jest.fn().mockResolvedValue(undefined),
      speakingMembers: jest.fn().mockResolvedValue([]),
      voiceCount: jest.fn().mockResolvedValue(1),
      listActiveSessions: jest.fn().mockResolvedValue([]),
      listOtherActiveSessions: jest.fn().mockResolvedValue([]),
      appendVoiceSessionLog: jest.fn().mockResolvedValue(undefined),
      setCachedState: jest.fn().mockResolvedValue(undefined),
      getCachedState: jest.fn().mockResolvedValue(null),
      invalidateState: jest.fn().mockResolvedValue(undefined),
    };
    rooms = {
      getZegoRoomId: jest.fn().mockResolvedValue('zego-1'),
      setZegoRoomId: jest.fn().mockResolvedValue(undefined),
      findRoomRow: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }),
    };
    moderation = { isMutedCached: jest.fn().mockResolvedValue(false) };
    zego = {
      isConfigured: jest.fn().mockReturnValue(true),
      buildRoomToken: jest
        .fn()
        .mockReturnValue({ appId: 42, token: 'tok', expiresInSeconds: 3600 }),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) as never };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    roomsSvc = {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isSpeaker: jest.fn().mockResolvedValue(false),
      isRoomMuted: jest.fn().mockResolvedValue(false),
      isSeatMuted: jest.fn().mockResolvedValue(false),
    };

    service = new VoiceService(
      voice as unknown as VoiceSessionRepository,
      rooms as unknown as AudioRoomsRepository,
      moderation as unknown as ModerationRepository,
      zego as unknown as ZegoTokenService,
      locks as unknown as LockService,
      queue as unknown as QueueService,
      bus,
      roomsSvc as unknown as IAudioRoomsService,
    );
  });

  describe('issueToken', () => {
    it('issues a subscriber token for the audience', async () => {
      const res = await service.issueToken(ACTOR, 'room-1');
      expect(res.role).toBe(VoicePublishRole.SUBSCRIBER);
      expect(zego.buildRoomToken).toHaveBeenCalledWith(ACTOR.id, 'zego-1', false);
    });

    it('issues a publisher token for a speaker (on a seat)', async () => {
      roomsSvc.isSpeaker.mockResolvedValue(true);
      const res = await service.issueToken(ACTOR, 'room-1');
      expect(res.role).toBe(VoicePublishRole.PUBLISHER);
      expect(zego.buildRoomToken).toHaveBeenCalledWith(ACTOR.id, 'zego-1', true);
    });

    it('503s when voice is not configured', async () => {
      zego.isConfigured.mockReturnValue(false);
      await expect(service.issueToken(ACTOR, 'room-1')).rejects.toBeInstanceOf(BusinessException);
    });

    it('lazily assigns a zegoRoomId to a legacy room', async () => {
      rooms.getZegoRoomId.mockResolvedValue(null);
      await service.issueToken(ACTOR, 'room-1');
      expect(rooms.setZegoRoomId).toHaveBeenCalled();
    });
  });

  describe('join / reconnect', () => {
    it('creates a session and publishes voice.joined', async () => {
      const res = await service.join(ACTOR, 'room-1', {});
      expect(voice.upsertJoin).toHaveBeenCalled();
      expect(voice.addVoicePresence).toHaveBeenCalledWith('room-1', ACTOR.id);
      expect(res.token).toBe('tok');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_joined' }),
      );
    });

    it('treats a rejoin of an active session as a reconnect', async () => {
      voice.upsertJoin.mockResolvedValue({
        session: session({ reconnectCount: 1 }),
        wasActive: true,
      });
      await service.join(ACTOR, 'room-1', {});
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_reconnected' }),
      );
    });

    it('requires membership', async () => {
      roomsSvc.assertMember.mockRejectedValue(new Error('not a member'));
      await expect(service.join(ACTOR, 'room-1', {})).rejects.toBeDefined();
    });
  });

  /**
   * Regression coverage for the cross-room audio leak: a user who becomes a
   * speaker in room-0, never calls /voice/leave there (a stale client, a
   * minimized/backgrounded session, a crash), and then joins room-1's voice
   * channel as a listener. The backend must stop treating them as live in
   * room-0 the moment room-1 confirms them, rather than relying on the client
   * to have cleaned up or on the heartbeat-timeout backstop.
   */
  describe('cross-room session cleanup on join/reconnect', () => {
    it('ends another room’s active session when joining a new room', async () => {
      const stale = session({ id: 'sess-0', roomId: 'room-0', role: VoicePublishRole.PUBLISHER });
      voice.listOtherActiveSessions.mockResolvedValue([stale]);

      await service.join(ACTOR, 'room-1', {});

      expect(voice.listOtherActiveSessions).toHaveBeenCalledWith(ACTOR.id, 'room-1');
      expect(voice.endSession).toHaveBeenCalledWith('room-0', ACTOR.id, expect.any(Number));
      expect(voice.removeVoicePresence).toHaveBeenCalledWith('room-0', ACTOR.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.voice_left',
          payload: expect.objectContaining({ roomId: 'room-0', userId: ACTOR.id }),
        }),
      );
    });

    it('ends every other stale session, not just one', async () => {
      voice.listOtherActiveSessions.mockResolvedValue([
        session({ id: 'sess-0', roomId: 'room-0' }),
        session({ id: 'sess-2', roomId: 'room-2' }),
      ]);

      await service.join(ACTOR, 'room-1', {});

      expect(voice.endSession).toHaveBeenCalledWith('room-0', ACTOR.id, expect.any(Number));
      expect(voice.endSession).toHaveBeenCalledWith('room-2', ACTOR.id, expect.any(Number));
    });

    it('does nothing extra when the user holds no other active session', async () => {
      await service.join(ACTOR, 'room-1', {});

      expect(voice.endSession).not.toHaveBeenCalled();
    });

    it('also runs on reconnect, not just a fresh join', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      voice.listOtherActiveSessions.mockResolvedValue([
        session({ id: 'sess-0', roomId: 'room-0' }),
      ]);

      await service.reconnect(ACTOR, 'room-1');

      expect(voice.endSession).toHaveBeenCalledWith('room-0', ACTOR.id, expect.any(Number));
    });
  });

  describe('leave', () => {
    it('ends the session, emits voice.left and enqueues analytics', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      await service.leave(ACTOR, 'room-1');
      expect(voice.endSession).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_left' }),
      );
      expect(queue.enqueue).toHaveBeenCalledWith(
        'analytics-processing',
        'voice.session.ended',
        expect.objectContaining({ roomId: 'room-1', userId: ACTOR.id }),
      );
    });

    it('is idempotent when no session exists', async () => {
      voice.getActiveSession.mockResolvedValue(null);
      await service.leave(ACTOR, 'room-1');
      expect(voice.endSession).not.toHaveBeenCalled();
      expect(voice.removeVoicePresence).toHaveBeenCalled();
    });
  });

  describe('self mute', () => {
    it('updates and emits voice.muted', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      await service.setSelfMute(ACTOR, 'room-1', true);
      expect(voice.updateSelfMute).toHaveBeenCalledWith('sess-1', true);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_muted' }),
      );
    });

    it('throws when not in the channel', async () => {
      voice.getActiveSession.mockResolvedValue(null);
      await expect(service.setSelfMute(ACTOR, 'room-1', true)).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    /**
     * The client already refuses to offer the toggle while a force-mute is in
     * force (`canToggleMic` is false for both a seat mute and Broad Mute), so
     * the only way to reach these paths is a modified client calling the
     * endpoint directly. Room mute was already rejected here; a seat mute was
     * not, which left the per-seat half of Broad Mute bypassable.
     */
    it('rejects self-unmute while the room is under broad mute', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      roomsSvc.isRoomMuted.mockResolvedValue(true);
      await expect(service.setSelfMute(ACTOR, 'room-1', false)).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(voice.updateSelfMute).not.toHaveBeenCalled();
    });

    it("rejects self-unmute while the caller's seat is muted", async () => {
      voice.getActiveSession.mockResolvedValue(session());
      roomsSvc.isSeatMuted.mockResolvedValue(true);
      await expect(service.setSelfMute(ACTOR, 'room-1', false)).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(voice.updateSelfMute).not.toHaveBeenCalled();
    });

    /** The owner outranks every force-mute — the rest of the module agrees. */
    it('lets the owner unmute through broad mute and a seat mute', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      rooms.findRoomRow.mockResolvedValue({ ownerId: ACTOR.id });
      roomsSvc.isRoomMuted.mockResolvedValue(true);
      roomsSvc.isSeatMuted.mockResolvedValue(true);
      await service.setSelfMute(ACTOR, 'room-1', false);
      expect(voice.updateSelfMute).toHaveBeenCalledWith('sess-1', false);
    });

    it('allows self-unmute when no force-mute is in effect', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      await service.setSelfMute(ACTOR, 'room-1', false);
      expect(voice.updateSelfMute).toHaveBeenCalledWith('sess-1', false);
    });
  });

  describe('heartbeat', () => {
    it('emits voice.speaking on a speaking transition', async () => {
      voice.getActiveSession.mockResolvedValue(session({ isSpeaking: false }));
      await service.heartbeat(ACTOR, 'room-1', { networkQualityLevel: 1, isSpeaking: true });
      expect(voice.addSpeaking).toHaveBeenCalledWith('room-1', ACTOR.id);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_speaking' }),
      );
    });

    it('does not emit speaking when state is unchanged', async () => {
      voice.getActiveSession.mockResolvedValue(session({ isSpeaking: true }));
      await service.heartbeat(ACTOR, 'room-1', { networkQualityLevel: 1, isSpeaking: true });
      expect(voice.updateSpeaking).not.toHaveBeenCalled();
    });

    it('folds a quality sample into the heartbeat write', async () => {
      voice.getActiveSession.mockResolvedValue(session());
      await service.heartbeat(ACTOR, 'room-1', {
        networkQualityLevel: 2,
        isSpeaking: false,
        rttMs: 120,
        packetLossPct: 3,
      });
      expect(voice.recordHeartbeat).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rttMs: 120, packetLossPct: 3 }),
      );
    });
  });

  describe('syncRoleFromSeat', () => {
    it('upgrades a subscriber to publisher when they take a seat', async () => {
      voice.getActiveSession.mockResolvedValue(session({ role: VoicePublishRole.SUBSCRIBER }));
      roomsSvc.isSpeaker.mockResolvedValue(true);
      await service.syncRoleFromSeat('room-1', ACTOR.id);
      expect(voice.updateRole).toHaveBeenCalledWith('sess-1', VoicePublishRole.PUBLISHER);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_state' }),
      );
    });

    it('no-ops when the user has no voice session', async () => {
      voice.getActiveSession.mockResolvedValue(null);
      await service.syncRoleFromSeat('room-1', ACTOR.id);
      expect(voice.updateRole).not.toHaveBeenCalled();
    });

    it('no-ops when the role is unchanged', async () => {
      voice.getActiveSession.mockResolvedValue(session({ role: VoicePublishRole.SUBSCRIBER }));
      roomsSvc.isSpeaker.mockResolvedValue(false);
      await service.syncRoleFromSeat('room-1', ACTOR.id);
      expect(voice.updateRole).not.toHaveBeenCalled();
    });
  });

  describe('expireSession (heartbeat timeout)', () => {
    it('ends the session with timeout logs and voice.left', async () => {
      await service.expireSession(session());
      expect(voice.endSession).toHaveBeenCalled();
      expect(voice.appendVoiceSessionLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'HEARTBEAT_TIMEOUT' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.voice_left' }),
      );
    });
  });

  /**
   * Voice sessions are keyed on (room,user) and reactivated on rejoin, so a
   * session left ACTIVE when the live ends is inherited by the next one — along
   * with its publisher role and self-mute flag. The room end is where they die.
   */
  describe('onRoomClosed', () => {
    it('ends every active session in the room', async () => {
      voice.listActiveSessions.mockResolvedValue([
        session({ id: 's1', userId: 'u1' }),
        session({ id: 's2', userId: 'u2' }),
      ]);

      await service.onRoomClosed('room-1');

      expect(voice.endSession).toHaveBeenCalledTimes(2);
      expect(voice.endSession).toHaveBeenCalledWith('room-1', 'u1', expect.any(Number));
      expect(voice.endSession).toHaveBeenCalledWith('room-1', 'u2', expect.any(Number));
    });

    it('clears the Redis presence, speaking and heartbeat keys per user', async () => {
      voice.listActiveSessions.mockResolvedValue([session({ userId: 'u1' })]);

      await service.onRoomClosed('room-1');

      expect(voice.removeVoicePresence).toHaveBeenCalledWith('room-1', 'u1');
      expect(voice.removeSpeaking).toHaveBeenCalledWith('room-1', 'u1');
      expect(voice.clearHeartbeat).toHaveBeenCalledWith('room-1', 'u1');
    });

    it('drops the cached voice-state snapshot', async () => {
      await service.onRoomClosed('room-1');

      expect(voice.invalidateState).toHaveBeenCalledWith('room-1');
    });

    it('is a no-op beyond cache invalidation when nobody was in voice', async () => {
      voice.listActiveSessions.mockResolvedValue([]);

      await service.onRoomClosed('room-1');

      expect(voice.endSession).not.toHaveBeenCalled();
      expect(voice.invalidateState).toHaveBeenCalledWith('room-1');
    });
  });
});
