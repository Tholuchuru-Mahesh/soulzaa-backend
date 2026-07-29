import { HttpStatus } from '@nestjs/common';
import { VideoRoomMemberRole, VideoRoomPkMode, VideoRoomStatus } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { ConnectionStatus } from '../enums';
import { DuplicatePKException, PKBattleException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkValidationService } from './video-room-pk-validation.service';

const ACTOR = { id: 'actor-1', roles: ['USER'] } as never;
const ROOM_ID = 'r1';

// A plain (uncast) base so `{ ...DTO_BASE, ... }` spreads still type-check;
// `DTO` itself stays `never` so it can be passed directly wherever the real
// `CreatePKInvitationDto` is expected without a second cast at each call site.
const DTO_BASE = {
  mode: VideoRoomPkMode.ONE_VS_ONE,
  durationSeconds: 300,
  red: ['u1'],
  blue: ['u2'],
};
const DTO = DTO_BASE as never;

describe('VideoRoomPkValidationService', () => {
  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let presence: Record<string, jest.Mock>;
  let mediaState: Record<string, jest.Mock>;
  let pkRepo: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let members: Record<string, { isActive: boolean; role: VideoRoomMemberRole } | null>;
  let online: Record<string, boolean>;
  let participantOnline: Record<string, boolean>;
  let mediaConnected: Record<string, boolean>;
  let service: VideoRoomPkValidationService;

  const build = () =>
    new VideoRoomPkValidationService(
      rooms as never,
      permissions as never,
      presence as never,
      mediaState as never,
      pkRepo as never,
      config as never,
    );

  beforeEach(() => {
    members = {
      u1: { isActive: true, role: VideoRoomMemberRole.HOST },
      u2: { isActive: true, role: VideoRoomMemberRole.PARTICIPANT },
    };
    online = { u1: true, u2: true };
    participantOnline = {};
    mediaConnected = { u1: true, u2: true };

    rooms = {
      findById: jest.fn().mockResolvedValue({
        id: ROOM_ID,
        ownerId: 'owner-1',
        status: VideoRoomStatus.LIVE,
      }),
      getSettings: jest.fn().mockResolvedValue({ allowPk: true }),
      // Mirrors `getSettings` by default (delegates to it) so every test that
      // overrides `getSettings` keeps working now that the service reads
      // `requireSettings` instead; tests targeting the missing-row path
      // override this mock directly.
      requireSettings: jest.fn(),
      getMember: jest.fn((_roomId: string, userId: string) =>
        Promise.resolve(members[userId] ?? null),
      ),
    };
    rooms.requireSettings.mockImplementation(async () => {
      const row = await rooms.getSettings();
      if (!row) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
          'Room settings are missing.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return row;
    });
    permissions = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    presence = {
      isHost: jest.fn((_roomId: string, userId: string) =>
        Promise.resolve(online[userId] ?? false),
      ),
      isParticipant: jest.fn((_roomId: string, userId: string) =>
        Promise.resolve(participantOnline[userId] ?? false),
      ),
    };
    mediaState = {
      getSnapshot: jest.fn().mockImplementation(() =>
        Promise.resolve({
          roomId: ROOM_ID,
          version: 1,
          updatedAt: new Date().toISOString(),
          mediaRoomId: 'zego-1',
          provider: 'ZEGOCLOUD',
          participants: Object.entries(mediaConnected).map(([userId, connected]) => ({
            userId,
            connection: connected ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED,
          })),
        }),
      ),
    };
    pkRepo = { findCurrent: jest.fn().mockResolvedValue(null) };
    config = { get: jest.fn().mockReturnValue({}) };

    service = build();
  });

  it('refuses when PK is disabled by config', async () => {
    config.get.mockReturnValue({ enabled: 'false' });
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toMatchObject({
      errorCode: 'VIDEO_ROOM_PK_DISABLED',
    });
    // Cheapest gate first: nothing downstream should have run.
    expect(rooms.findById).not.toHaveBeenCalled();
  });

  it('refuses when the room is not LIVE', async () => {
    rooms.findById.mockResolvedValue({
      id: ROOM_ID,
      ownerId: 'owner-1',
      status: VideoRoomStatus.OFFLINE,
    });
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
    // Gate ordering: a not-LIVE room must never reach the permission check —
    // that would leak the room's authorization surface to an unauthorized caller.
    expect(permissions.assertPermission).not.toHaveBeenCalled();
    expect(rooms.requireSettings).not.toHaveBeenCalled();
  });

  // Guard hardening: a missing settings row must NOT read as "allowed".
  it('raises VIDEO_ROOM_SETTINGS_MISSING when the settings row is absent', async () => {
    rooms.requireSettings.mockRejectedValue(
      new BusinessException(
        ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
        'Room settings are missing.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      ),
    );
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toMatchObject({
      errorCode: ERROR_CODES.VIDEO_ROOM_SETTINGS_MISSING,
    });
  });

  it('refuses when the actor lacks START_PK', async () => {
    permissions.assertPermission.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    );
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toThrow('forbidden');
    // Gate ordering: no participant reads should happen before authorization passes.
    expect(rooms.getMember).not.toHaveBeenCalled();
    expect(presence.isHost).not.toHaveBeenCalled();
    expect(mediaState.getSnapshot).not.toHaveBeenCalled();
    expect(pkRepo.findCurrent).not.toHaveBeenCalled();
  });

  it('refuses overlapping sides', () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({ mode: 'TEAM', red: ['u1', 'u2'], blue: ['u2'] } as never),
    ).toThrow(PKBattleException);
  });

  it('refuses a 1v1 with more than one per side', () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({
        mode: 'ONE_VS_ONE',
        red: ['u1', 'u2'],
        blue: ['u3'],
      } as never),
    ).toThrow(PKBattleException);
  });

  it('refuses a duplicate within one side', () => {
    const svc = build();
    expect(() =>
      svc.assertParticipantsDistinct({ mode: 'TEAM', red: ['u1', 'u1'], blue: ['u2'] } as never),
    ).toThrow(PKBattleException);
  });

  it('refuses a VIEWER as a participant', async () => {
    // A VIEWER has no seat and no stream, so it can never be a PK side.
    members.u2 = { isActive: true, role: VideoRoomMemberRole.VIEWER };
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
    expect(presence.isHost).not.toHaveBeenCalled();
  });

  it('refuses an inactive member as a participant', async () => {
    members.u1 = { isActive: false, role: VideoRoomMemberRole.HOST };
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
  });

  it('refuses an offline participant', async () => {
    online.u2 = false;
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
    // Gate ordering: an offline participant must be caught before media is read.
    expect(mediaState.getSnapshot).not.toHaveBeenCalled();
  });

  it('accepts a PARTICIPANT-role contestant tracked only in the participants set', async () => {
    // Regression for the gate 8/gate 9 contradiction: gate 8 admits PARTICIPANT
    // role, but hosts and seat-holding participants live in separate Redis
    // sets. u2 is absent from the hosts set (isHost -> false) and present only
    // in the participants set (isParticipant -> true) — gate 9 must still pass.
    online.u2 = false;
    participantOnline.u2 = true;
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).resolves.toMatchObject({
      id: ROOM_ID,
    });
  });

  it('refuses a participant absent from both the hosts and participants sets', async () => {
    // Guards against the fix becoming overly permissive: being tracked in
    // neither Redis set must still fail gate 9.
    online.u2 = false;
    participantOnline.u2 = false;
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
    expect(mediaState.getSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a participant with no active media', async () => {
    mediaConnected.u2 = false;
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      PKBattleException,
    );
    expect(pkRepo.findCurrent).not.toHaveBeenCalled();
  });

  it('refuses when the room already has a non-terminal battle', async () => {
    pkRepo.findCurrent.mockResolvedValue({ id: 'battle-1', roomId: ROOM_ID, status: 'LIVE' });
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).rejects.toBeInstanceOf(
      DuplicatePKException,
    );
  });

  it('accepts a fully valid 1v1', async () => {
    await expect(service.assertCanCreate(ACTOR, ROOM_ID, DTO)).resolves.toMatchObject({
      id: ROOM_ID,
    });
  });

  // ---- Wiring-gate closure: minDurationSeconds/maxDurationSeconds/
  // defaultDurationSeconds were declared in config but read nowhere. These
  // three prove the bounds are read from CONFIG, not the DTO's own hardcoded
  // @Min(60)/@Max(1800) — the DTO decorators are a cheap first-pass guard
  // that this unit-level call bypasses entirely (it calls the service
  // directly, no HTTP validation pipe involved).

  it('rejects durationSeconds below the configured minimum', async () => {
    config.get.mockReturnValue({ minDurationSeconds: 120, maxDurationSeconds: 1800 });
    await expect(
      service.assertCanCreate(ACTOR, ROOM_ID, { ...DTO_BASE, durationSeconds: 90 }),
    ).rejects.toBeInstanceOf(PKBattleException);
    // Cheap, no-I/O gate: must reject before ever touching the room.
    expect(rooms.findById).not.toHaveBeenCalled();
  });

  it('rejects durationSeconds above the configured maximum', async () => {
    config.get.mockReturnValue({ minDurationSeconds: 60, maxDurationSeconds: 600 });
    await expect(
      service.assertCanCreate(ACTOR, ROOM_ID, { ...DTO_BASE, durationSeconds: 900 }),
    ).rejects.toBeInstanceOf(PKBattleException);
    expect(rooms.findById).not.toHaveBeenCalled();
  });

  // The load-bearing proof: bounds far outside the DTO's own hardcoded
  // 60-1800 range are honoured. 90s would pass the DTO's @Min(60), but must
  // still be rejected here because THIS config's minimum is 100; 150s must
  // be accepted even though it sits well below the DTO's own 1800s ceiling,
  // proving the service checked the CONFIGURED 200s ceiling, not 1800.
  it('honours a non-default configured bound rather than the hardcoded 60/1800', async () => {
    config.get.mockReturnValue({ minDurationSeconds: 100, maxDurationSeconds: 200 });

    await expect(
      service.assertCanCreate(ACTOR, ROOM_ID, { ...DTO_BASE, durationSeconds: 90 }),
    ).rejects.toBeInstanceOf(PKBattleException);
    await expect(
      service.assertCanCreate(ACTOR, ROOM_ID, { ...DTO_BASE, durationSeconds: 150 }),
    ).resolves.toMatchObject({ id: ROOM_ID });
  });

  // durationSeconds is optional on the DTO; when absent, the EFFECTIVE
  // duration used for this gate is defaultDurationSeconds — a misconfigured
  // default must be caught here too, not silently accepted.
  it('validates the config default when durationSeconds is omitted from the DTO', async () => {
    config.get.mockReturnValue({
      minDurationSeconds: 60,
      maxDurationSeconds: 1800,
      defaultDurationSeconds: 5000,
    });
    const { durationSeconds: _omit, ...withoutDuration } = DTO as Record<string, unknown>;

    await expect(
      service.assertCanCreate(ACTOR, ROOM_ID, withoutDuration as never),
    ).rejects.toBeInstanceOf(PKBattleException);
  });

  // ---- Review fix: assertCanManage (second line of defence for start/pause/resume/cancel/end) ----

  describe('assertCanManage', () => {
    it('throws 404 when the room is absent', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(service.assertCanManage(ACTOR, ROOM_ID)).rejects.toMatchObject({
        errorCode: 'VIDEO_ROOM_NOT_FOUND',
      });
      expect(permissions.assertPermission).not.toHaveBeenCalled();
    });

    it('throws 403 when START_PK is denied', async () => {
      permissions.assertPermission.mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
      await expect(service.assertCanManage(ACTOR, ROOM_ID)).rejects.toThrow('forbidden');
    });

    it('returns the room on success', async () => {
      await expect(service.assertCanManage(ACTOR, ROOM_ID)).resolves.toMatchObject({
        id: ROOM_ID,
      });
      expect(permissions.assertPermission).toHaveBeenCalledWith(
        ACTOR,
        { id: ROOM_ID, ownerId: 'owner-1' },
        'START_PK',
      );
    });
  });
});
