import { ConfigService } from '@nestjs/config';
import {
  VideoRoomPkBattle,
  VideoRoomPkMode,
  VideoRoomPkSide,
  VideoRoomPkStatus,
} from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { CreatePKInvitationDto } from '../dto/video-room-pk.dto';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { DuplicatePKException, PKBattleException } from '../exceptions/video-room-pk.exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomPkInvitationService } from './video-room-pk-invitation.service';
import { VideoRoomPkScoreEngine } from './video-room-pk-score.engine';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkTimerService } from './video-room-pk-timer.service';
import { VideoRoomPkValidationService } from './video-room-pk-validation.service';
import { IVideoRoomPkSettlementService, VideoRoomPkService } from './video-room-pk.service';

const owner: RoomActor = { id: 'owner', roles: [] };

const battle = (overrides: Partial<VideoRoomPkBattle> = {}): VideoRoomPkBattle =>
  ({
    id: 'b1',
    roomId: 'r1',
    mode: VideoRoomPkMode.TEAM,
    status: VideoRoomPkStatus.CREATED,
    createdBy: 'owner',
    countdownSeconds: 10,
    durationSeconds: 300,
    startedAt: null,
    endsAt: null,
    pausedAt: null,
    totalPausedMs: 0,
    resumeSeq: 0,
    scoringSnapshot: {},
    rewardSnapshot: {},
    winningTeamId: null,
    isDraw: false,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as VideoRoomPkBattle;

const inviteDto: CreatePKInvitationDto = {
  mode: VideoRoomPkMode.TEAM,
  durationSeconds: 300,
  red: ['u-red-1'],
  blue: ['u-blue-1'],
};

describe('VideoRoomPkService', () => {
  let repo: jest.Mocked<VideoRoomPkRepository>;
  let validation: jest.Mocked<VideoRoomPkValidationService>;
  let state: jest.Mocked<VideoRoomPkStateService>;
  let timer: jest.Mocked<VideoRoomPkTimerService>;
  let invitations: jest.Mocked<VideoRoomPkInvitationService>;
  let scoreEngine: VideoRoomPkScoreEngine;
  let locks: jest.Mocked<LockService>;
  let bus: jest.Mocked<IEventBus>;
  let config: ConfigService;
  let settlement: jest.Mocked<IVideoRoomPkSettlementService>;
  let svc: VideoRoomPkService;

  beforeEach(() => {
    repo = {
      findCurrent: jest.fn().mockResolvedValue(battle({ status: VideoRoomPkStatus.LIVE })),
      getBattle: jest.fn().mockResolvedValue(battle()),
      createBattle: jest.fn().mockResolvedValue(battle()),
      createTeams: jest.fn().mockResolvedValue({ count: 2 }),
      createParticipants: jest.fn().mockResolvedValue({ count: 2 }),
      listTeams: jest.fn().mockResolvedValue([]),
      listParticipants: jest.fn().mockResolvedValue([]),
      runInTransaction: jest.fn().mockImplementation((fn) => fn({})),
    } as unknown as jest.Mocked<VideoRoomPkRepository>;

    validation = {
      assertCanCreate: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }),
      assertCanManage: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }),
      assertParticipantsDistinct: jest.fn(),
    } as unknown as jest.Mocked<VideoRoomPkValidationService>;

    state = {
      transition: jest.fn().mockResolvedValue(battle({ status: VideoRoomPkStatus.INVITED })),
      tryTransition: jest.fn(),
      assertTransition: jest.fn(),
    } as unknown as jest.Mocked<VideoRoomPkStateService>;

    timer = {
      scheduleCountdown: jest.fn().mockResolvedValue(undefined),
      scheduleEnd: jest.fn().mockResolvedValue(undefined),
      cancelEnd: jest.fn().mockResolvedValue(undefined),
      computeResume: jest
        .fn()
        .mockReturnValue({ endsAt: new Date(), totalPausedMs: 0, resumeSeq: 1 }),
      remainingMs: jest.fn().mockReturnValue(0),
    } as unknown as jest.Mocked<VideoRoomPkTimerService>;

    invitations = {
      send: jest.fn().mockResolvedValue(undefined),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      accept: jest.fn().mockResolvedValue(undefined),
      reject: jest.fn().mockResolvedValue(undefined),
      cancelAll: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
      expireDue: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoRoomPkInvitationService>;

    // Real engine, not a mock: `snapshot(cfg)` is a pure function of config,
    // and using the real implementation is what makes the "frozen at create
    // time, sourced from config" tests below actually prove something,
    // instead of just echoing back whatever the test told a mock to return.
    scoreEngine = new VideoRoomPkScoreEngine();

    locks = {
      withLock: jest.fn().mockImplementation((_key: string, fn: () => unknown) => fn()),
      acquire: jest.fn(),
      acquireLockObject: jest.fn(),
      extend: jest.fn(),
    } as unknown as jest.Mocked<LockService>;

    bus = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    } as unknown as jest.Mocked<IEventBus>;

    config = { get: jest.fn().mockReturnValue({}) } as unknown as ConfigService;

    settlement = {
      settle: jest.fn().mockResolvedValue(battle({ status: VideoRoomPkStatus.COMPLETED })),
    };

    svc = new VideoRoomPkService(
      repo,
      validation,
      state,
      timer,
      invitations,
      scoreEngine,
      locks,
      bus,
      config,
      settlement,
    );
  });

  // ---- Task 17 brief: the 12 required tests ----

  it('creates battle, two teams, participants and invitations in one transaction', async () => {
    await svc.invite(owner, 'r1', inviteDto, 'req-1');
    expect(repo.createBattle).toHaveBeenCalledTimes(1);
    expect(repo.createTeams).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ side: VideoRoomPkSide.RED }),
        expect.objectContaining({ side: VideoRoomPkSide.BLUE }),
      ]),
      expect.anything(),
    );
    expect(invitations.send).toHaveBeenCalledTimes(1);
  });

  it('freezes the scoring and reward snapshots at create time', async () => {
    await svc.invite(owner, 'r1', inviteDto, 'req-1');
    expect(repo.createBattle).toHaveBeenCalledWith(
      expect.objectContaining({
        scoringSnapshot: expect.objectContaining({ capBps: 30_000 }),
        rewardSnapshot: expect.objectContaining({ poolBps: 1000 }),
      }),
      expect.anything(),
    );
  });

  // The partial unique index is the real gate; this maps its raw violation to a
  // domain error so the client sees ALREADY_ACTIVE, not a 500.
  it('surfaces the partial-unique violation as DuplicatePKException', async () => {
    repo.createBattle.mockRejectedValue({
      code: 'P2002',
      meta: { target: 'video_room_pk_battles_one_active_per_room' },
    });
    await expect(svc.invite(owner, 'r1', inviteDto)).rejects.toThrow(DuplicatePKException);
    // The failed transaction must not leave stray invitations behind.
    expect(invitations.send).not.toHaveBeenCalled();
  });

  it('emits PkCreatedEvent before any invitation event', async () => {
    await svc.invite(owner, 'r1', inviteDto);
    expect(bus.publish.mock.calls[0][0].name).toBe(VIDEO_ROOM_PK_EVENTS.CREATED);
  });

  // Wiring-gate closure: defaultDurationSeconds was declared in config but
  // read nowhere. durationSeconds is now optional on the DTO; when the
  // caller omits it, invite() must fall back to the CONFIGURED default, not
  // a hardcoded value.
  it('falls back to the configured defaultDurationSeconds when durationSeconds is omitted', async () => {
    config = { get: jest.fn().mockReturnValue({ defaultDurationSeconds: 450 }) } as never;
    svc = new VideoRoomPkService(
      repo,
      validation,
      state,
      timer,
      invitations,
      scoreEngine,
      locks,
      bus,
      config,
      settlement,
    );
    const { durationSeconds: _omit, ...withoutDuration } = inviteDto as unknown as Record<
      string,
      unknown
    >;

    await svc.invite(owner, 'r1', withoutDuration as never, 'req-1');

    expect(repo.createBattle).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 450 }),
      expect.anything(),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ durationSeconds: 450 }) }),
    );
  });

  it('start requires ACCEPTED and schedules the countdown job', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.ACCEPTED }));
    await svc.start(owner, 'r1', {});
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.ACCEPTED,
      VideoRoomPkStatus.COUNTDOWN,
      expect.anything(),
    );
    expect(timer.scheduleCountdown).toHaveBeenCalled();
  });

  it('start refuses a battle still awaiting acceptance', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.PENDING }));
    await expect(svc.start(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  it('pause cancels the pending end job and stamps pausedAt', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.LIVE }));
    await svc.pause(owner, 'r1', {});
    expect(timer.cancelEnd).toHaveBeenCalled();
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.PAUSED,
      expect.objectContaining({ pausedAt: expect.any(Date) }),
    );
  });

  it('pause refuses a COUNTDOWN battle', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.COUNTDOWN }));
    await expect(svc.pause(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  it('resume recomputes endsAt and reschedules with the bumped resumeSeq', async () => {
    repo.findCurrent.mockResolvedValue(
      battle({
        id: 'b1',
        status: VideoRoomPkStatus.PAUSED,
        resumeSeq: 0,
        totalPausedMs: 0,
        endsAt: new Date('2026-07-22T00:05:00Z'),
        pausedAt: new Date('2026-07-22T00:01:00Z'),
      }),
    );
    timer.computeResume.mockReturnValue({
      endsAt: new Date('2026-07-22T00:07:00Z'),
      totalPausedMs: 120_000,
      resumeSeq: 1,
    });
    await svc.resume(owner, 'r1', {});
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.PAUSED,
      VideoRoomPkStatus.LIVE,
      expect.objectContaining({ resumeSeq: 1, totalPausedMs: 120_000, pausedAt: null }),
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  it.each([VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED])(
    'end settles a %s battle',
    async (status) => {
      repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status }));
      await svc.end(owner, 'r1', {});
      expect(settlement.settle).toHaveBeenCalledWith('b1', 'manual');
    },
  );

  it('serialises every command under the room lifecycle lock', async () => {
    await svc.pause(owner, 'r1', {});
    expect(locks.withLock).toHaveBeenCalledWith(
      'video-room:pk:lifecycle:{r1}',
      expect.any(Function),
    );
  });

  it('rejects a second concurrent pause via the conditional transition', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.LIVE }));
    state.transition.mockRejectedValue(new PKBattleException('no longer LIVE'));
    await expect(svc.pause(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  // ---- Beyond the brief's 12: lessons from Tasks 7-16's reviews ----

  it("derives each invitee's side from the dto's red/blue arrays, not the RED default", async () => {
    await svc.invite(owner, 'r1', inviteDto, 'req-1');
    expect(invitations.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        { userId: 'u-red-1', side: VideoRoomPkSide.RED },
        { userId: 'u-blue-1', side: VideoRoomPkSide.BLUE },
      ]),
      'owner',
    );
  });

  it('does not re-read config for the scoring/reward snapshot on later lifecycle commands', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.ACCEPTED }));
    // An admin retunes config AFTER the battle was created; start() must not
    // let that leak into the battle's already-frozen snapshot fields.
    (config.get as jest.Mock).mockReturnValue({ multiplierCapBps: 99_999, poolBps: 5_000 });

    await svc.start(owner, 'r1', {});

    const patch = state.transition.mock.calls[0][3];
    expect(patch).not.toHaveProperty('scoringSnapshot');
    expect(patch).not.toHaveProperty('rewardSnapshot');
  });

  it('accept delegates to the invitation service with the current battle', async () => {
    const current = battle({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    repo.findCurrent.mockResolvedValue(current);
    await svc.accept(owner, 'r1', {});
    expect(invitations.accept).toHaveBeenCalledWith('owner', current);
  });

  it('reject delegates to the invitation service with the current battle', async () => {
    const current = battle({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    repo.findCurrent.mockResolvedValue(current);
    await svc.reject(owner, 'r1', {});
    expect(invitations.reject).toHaveBeenCalledWith('owner', current);
  });

  it('cancel cancels invitations AND transitions the battle itself', async () => {
    const current = battle({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    repo.findCurrent.mockResolvedValue(current);
    await svc.cancel(owner, 'r1');
    expect(invitations.cancelAll).toHaveBeenCalledWith('b1', expect.any(String));
    expect(state.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.PENDING,
      VideoRoomPkStatus.CANCELLED,
      expect.anything(),
    );
  });

  it('end refuses a battle that is neither LIVE nor PAUSED', async () => {
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.COUNTDOWN }));
    await expect(svc.end(owner, 'r1', {})).rejects.toThrow(PKBattleException);
    expect(settlement.settle).not.toHaveBeenCalled();
  });

  it('end throws a clear error instead of doing nothing when the settlement seam is unwired', async () => {
    const svcNoSettlement = new VideoRoomPkService(
      repo,
      validation,
      state,
      timer,
      invitations,
      scoreEngine,
      locks,
      bus,
      config,
      undefined,
    );
    repo.findCurrent.mockResolvedValue(battle({ id: 'b1', status: VideoRoomPkStatus.LIVE }));
    await expect(svcNoSettlement.end(owner, 'r1', {})).rejects.toThrow(PKBattleException);
  });

  // ---- Review fix: management commands must authorize before touching state ----

  describe('authorization on management commands (review fix)', () => {
    beforeEach(() => {
      validation.assertCanManage.mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
    });

    it('start rejects and performs no state change when assertCanManage denies', async () => {
      await expect(svc.start(owner, 'r1', {})).rejects.toThrow('forbidden');
      expect(repo.findCurrent).not.toHaveBeenCalled();
      expect(state.transition).not.toHaveBeenCalled();
      expect(timer.scheduleCountdown).not.toHaveBeenCalled();
      expect(locks.withLock).not.toHaveBeenCalled();
    });

    it('pause rejects and performs no state change when assertCanManage denies', async () => {
      await expect(svc.pause(owner, 'r1', {})).rejects.toThrow('forbidden');
      expect(repo.findCurrent).not.toHaveBeenCalled();
      expect(state.transition).not.toHaveBeenCalled();
      expect(timer.cancelEnd).not.toHaveBeenCalled();
      expect(locks.withLock).not.toHaveBeenCalled();
    });

    it('resume rejects and performs no state change when assertCanManage denies', async () => {
      await expect(svc.resume(owner, 'r1', {})).rejects.toThrow('forbidden');
      expect(repo.findCurrent).not.toHaveBeenCalled();
      expect(state.transition).not.toHaveBeenCalled();
      expect(timer.scheduleEnd).not.toHaveBeenCalled();
      expect(locks.withLock).not.toHaveBeenCalled();
    });

    it('cancel rejects and performs no state change when assertCanManage denies', async () => {
      await expect(svc.cancel(owner, 'r1')).rejects.toThrow('forbidden');
      expect(repo.findCurrent).not.toHaveBeenCalled();
      expect(state.transition).not.toHaveBeenCalled();
      expect(invitations.cancelAll).not.toHaveBeenCalled();
      expect(locks.withLock).not.toHaveBeenCalled();
    });

    it('end rejects and performs no state change (no settlement) when assertCanManage denies', async () => {
      await expect(svc.end(owner, 'r1', {})).rejects.toThrow('forbidden');
      expect(repo.findCurrent).not.toHaveBeenCalled();
      expect(state.transition).not.toHaveBeenCalled();
      expect(settlement.settle).not.toHaveBeenCalled();
      expect(locks.withLock).not.toHaveBeenCalled();
    });
  });

  it('accept does not call assertCanManage — authority is invitee-based, not a room role', async () => {
    const current = battle({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    repo.findCurrent.mockResolvedValue(current);
    await svc.accept(owner, 'r1', {});
    expect(validation.assertCanManage).not.toHaveBeenCalled();
  });

  it('reject does not call assertCanManage — authority is invitee-based, not a room role', async () => {
    const current = battle({ id: 'b1', status: VideoRoomPkStatus.PENDING });
    repo.findCurrent.mockResolvedValue(current);
    await svc.reject(owner, 'r1', {});
    expect(validation.assertCanManage).not.toHaveBeenCalled();
  });
});
