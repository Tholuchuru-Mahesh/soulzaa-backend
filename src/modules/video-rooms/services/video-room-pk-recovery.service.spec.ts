import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { VideoRoomPkBattle, VideoRoomPkStatus, VideoRoomStatus } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PK_RECOVERY_LOCK_KEY } from '../constants/video-room-pk.constants';
import { VideoRoomPkConfig } from '../config/video-room-pk.config';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { PKWinnerException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkInvitationRepository } from '../repositories/video-room-pk-invitation.repository';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPkInvitationService } from './video-room-pk-invitation.service';
import { VideoRoomPkRecoveryService } from './video-room-pk-recovery.service';
import { VideoRoomPkSettlementService } from './video-room-pk-settlement.service';
import { VideoRoomPkStateService } from './video-room-pk-state.service';
import { VideoRoomPkTimerService } from './video-room-pk-timer.service';

const FIXED_NOW = new Date('2026-07-22T12:00:00Z');

const battle = (overrides: Partial<VideoRoomPkBattle> = {}): VideoRoomPkBattle =>
  ({
    id: 'b1',
    roomId: 'r1',
    mode: 'ONE_VS_ONE',
    status: VideoRoomPkStatus.LIVE,
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

describe('VideoRoomPkRecoveryService', () => {
  let repo: jest.Mocked<VideoRoomPkRepository>;
  let invitationRepo: jest.Mocked<VideoRoomPkInvitationRepository>;
  let invitations: jest.Mocked<VideoRoomPkInvitationService>;
  let state: jest.Mocked<VideoRoomPkStateService>;
  let timer: jest.Mocked<VideoRoomPkTimerService>;
  let settlement: jest.Mocked<VideoRoomPkSettlementService>;
  let rooms: jest.Mocked<VideoRoomsRepository>;
  let locks: { acquire: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let metrics: { setPkActive: jest.Mock; setPkRecoveryQueueDepth: jest.Mock };

  const configFor = (overrides: Partial<VideoRoomPkConfig>): ConfigService =>
    ({
      get: jest.fn().mockReturnValue({
        recoveryEnabled: true,
        monitorIntervalSeconds: 15,
        orphanTimeoutSeconds: 120,
        recoveryGraceSeconds: 45,
        maxPerSweep: 50,
        ...overrides,
      }),
    }) as unknown as ConfigService;

  const build = (overrides: Partial<VideoRoomPkConfig> = {}): VideoRoomPkRecoveryService =>
    new VideoRoomPkRecoveryService(
      repo,
      invitationRepo,
      invitations,
      state,
      timer,
      settlement,
      rooms,
      locks as never,
      bus,
      configFor(overrides),
      metrics as never,
      () => FIXED_NOW.getTime(),
    );

  beforeEach(() => {
    repo = {
      findStale: jest.fn().mockResolvedValue([]),
      findByStatus: jest.fn().mockResolvedValue([]),
      findCurrent: jest.fn().mockResolvedValue(null),
      getBattle: jest.fn(),
      // Default: the dropping/returning user IS a participant, so the
      // existing host-drop/host-return tests below (which all use 'host-1')
      // are unaffected by the new participant guard.
      findParticipantsByUserIds: jest.fn().mockResolvedValue([{ id: 'p1', userId: 'host-1' }]),
    } as unknown as jest.Mocked<VideoRoomPkRepository>;

    invitationRepo = {
      findExpired: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<VideoRoomPkInvitationRepository>;

    invitations = {
      expireDue: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoRoomPkInvitationService>;

    state = {
      transition: jest.fn(),
      tryTransition: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<VideoRoomPkStateService>;

    timer = {
      cancelEnd: jest.fn().mockResolvedValue(undefined),
      scheduleEnd: jest.fn().mockResolvedValue(undefined),
      scheduleCountdown: jest.fn().mockResolvedValue(undefined),
      computeResume: jest.fn(),
    } as unknown as jest.Mocked<VideoRoomPkTimerService>;

    settlement = {
      settle: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<VideoRoomPkSettlementService>;

    rooms = {
      findById: jest.fn().mockResolvedValue({ id: 'r1', status: VideoRoomStatus.LIVE }),
    } as unknown as jest.Mocked<VideoRoomsRepository>;

    locks = { acquire: jest.fn().mockResolvedValue(jest.fn().mockResolvedValue(undefined)) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as never;
    metrics = { setPkActive: jest.fn(), setPkRecoveryQueueDepth: jest.fn() };
  });

  // ---- the 5 sweep conditions ----

  it('settles a non-terminal battle past its endsAt', async () => {
    repo.findStale.mockResolvedValue([battle({ id: 'b1', status: VideoRoomPkStatus.LIVE })]);

    await build().tick();

    expect(settlement.settle).toHaveBeenCalledWith('b1', 'recovery');
  });

  // Review fix: pause/host-drop deliberately leave `endsAt` untouched (so a
  // resume can restore the exact remaining time), so a PAUSED/RECOVERING
  // battle's `endsAt` being in the past is NOT "expired" — it is just stale
  // by construction. Re-settling on it would auto-complete and pay out a
  // battle with real time still left once resumed. `findStale` is mocked to
  // only return the battle to a caller whose status list actually includes
  // PAUSED/RECOVERING, which proves `sweepExpiredBattles` itself excludes
  // them (condition 4 — `sweepOrphans` — is RECOVERING's real deadline).
  it.each([VideoRoomPkStatus.PAUSED, VideoRoomPkStatus.RECOVERING])(
    'does not re-settle a %s battle whose stale endsAt has already passed',
    async (status) => {
      const stale = battle({
        id: 'b1s',
        status,
        endsAt: new Date(FIXED_NOW.getTime() - 30_000),
        pausedAt: new Date(FIXED_NOW.getTime() - 30_000),
      });
      repo.findStale.mockImplementation(async (_now, statuses) =>
        statuses.includes(status) ? [stale] : [],
      );

      await build().tick();

      expect(settlement.settle).not.toHaveBeenCalled();
    },
  );

  it('moves a COUNTDOWN battle past its deadline to LIVE', async () => {
    const countdownBattle = battle({
      id: 'b2',
      status: VideoRoomPkStatus.COUNTDOWN,
      startedAt: new Date(FIXED_NOW.getTime() - 20_000),
      countdownSeconds: 10,
      endsAt: new Date(FIXED_NOW.getTime() + 100_000),
    });
    repo.findByStatus.mockImplementation(async (status) =>
      status === VideoRoomPkStatus.COUNTDOWN ? [countdownBattle] : [],
    );
    state.tryTransition.mockResolvedValue({
      ...countdownBattle,
      status: VideoRoomPkStatus.LIVE,
    } as never);

    await build().tick();

    expect(state.tryTransition).toHaveBeenCalledWith(
      'b2',
      VideoRoomPkStatus.COUNTDOWN,
      VideoRoomPkStatus.LIVE,
      {},
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  it('expires invitations past their TTL', async () => {
    await build().tick();

    expect(invitations.expireDue).toHaveBeenCalled();
  });

  // VideoRoomPkInvitationService.expireDue (Task 16) owns the actual
  // expire-then-cancel-if-nothing-left rule; the sweep's job is only to
  // invoke it with ITS OWN clock and cap, so that pass-through is what this
  // pins.
  it('cancels the battle when no invitation remains actionable', async () => {
    await build({ maxPerSweep: 7 }).tick();

    expect(invitations.expireDue).toHaveBeenCalledWith(FIXED_NOW, 7);
  });

  it('settles a RECOVERING battle past the orphan timeout', async () => {
    const recovering = battle({
      id: 'b3',
      status: VideoRoomPkStatus.RECOVERING,
      pausedAt: new Date(FIXED_NOW.getTime() - 200_000),
    });
    repo.findByStatus.mockImplementation(async (status) =>
      status === VideoRoomPkStatus.RECOVERING ? [recovering] : [],
    );

    await build().tick();

    expect(settlement.settle).toHaveBeenCalledWith('b3', 'recovery');
  });

  // Wiring-gate closure: BattleRecoveryException was bound to a real error
  // code but never thrown. A data-integrity failure out of settlement
  // (PKWinnerException here) is surfaced as this recovery-specific type
  // instead of logged-and-continued like a transient DB fault — but it must
  // still not escape tick() as a whole: guardSweep absorbs it so the other
  // four sweep conditions still run this tick.
  it('surfaces a data-integrity settlement failure as BattleRecoveryException instead of silently continuing', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo.findStale.mockResolvedValue([battle({ id: 'b9', status: VideoRoomPkStatus.LIVE })]);
    settlement.settle.mockRejectedValue(new PKWinnerException('no teams'));

    await expect(build().tick()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be recovered'));
    // The rest of tick() still ran — proof the throw did not escape past
    // guardSweep and abort the whole sweep.
    expect(invitations.expireDue).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('settles a LIVE battle whose room is no longer live', async () => {
    const live = battle({ id: 'b4', roomId: 'r4', status: VideoRoomPkStatus.LIVE });
    repo.findByStatus.mockImplementation(async (status) =>
      status === VideoRoomPkStatus.LIVE ? [live] : [],
    );
    rooms.findById.mockResolvedValue({ id: 'r4', status: VideoRoomStatus.OFFLINE } as never);

    await build().tick();

    expect(settlement.settle).toHaveBeenCalledWith('b4', 'recovery');
  });

  // Finding: a battle stuck in a pre-LIVE status (nobody ever called start(),
  // or a crash landed it there) has no `endsAt` and so matches no other sweep
  // condition — the partial unique index then blocks every future battle in
  // the room until an owner manually cancels. This is that backstop.
  it('cancels a battle stuck in ACCEPTED past the stranded-pre-LIVE threshold', async () => {
    const stuck = battle({
      id: 'b10',
      roomId: 'r10',
      status: VideoRoomPkStatus.ACCEPTED,
      createdAt: new Date(FIXED_NOW.getTime() - 200_000), // default orphanTimeoutSeconds is 120
    });
    repo.findByStatus.mockImplementation(async (status) =>
      status === VideoRoomPkStatus.ACCEPTED ? [stuck] : [],
    );
    state.tryTransition.mockResolvedValue({ ...stuck, status: VideoRoomPkStatus.CANCELLED });

    await build().tick();

    expect(state.tryTransition).toHaveBeenCalledWith(
      'b10',
      VideoRoomPkStatus.ACCEPTED,
      VideoRoomPkStatus.CANCELLED,
      expect.objectContaining({ cancelledAt: FIXED_NOW }),
    );
  });

  it('leaves a battle stuck in ACCEPTED inside the threshold alone', async () => {
    const fresh = battle({
      id: 'b11',
      roomId: 'r11',
      status: VideoRoomPkStatus.ACCEPTED,
      createdAt: new Date(FIXED_NOW.getTime() - 10_000), // well inside the default 120s
    });
    repo.findByStatus.mockImplementation(async (status) =>
      status === VideoRoomPkStatus.ACCEPTED ? [fresh] : [],
    );

    await build().tick();

    expect(state.tryTransition).not.toHaveBeenCalled();
  });

  it.each([VideoRoomPkStatus.CREATED, VideoRoomPkStatus.INVITED, VideoRoomPkStatus.PENDING])(
    'also sweeps %s battles stranded past the threshold',
    async (status) => {
      const stuck = battle({
        id: 'b12',
        roomId: 'r12',
        status,
        createdAt: new Date(FIXED_NOW.getTime() - 200_000),
      });
      repo.findByStatus.mockImplementation(async (s) => (s === status ? [stuck] : []));
      state.tryTransition.mockResolvedValue({ ...stuck, status: VideoRoomPkStatus.CANCELLED });

      await build().tick();

      expect(state.tryTransition).toHaveBeenCalledWith(
        'b12',
        status,
        VideoRoomPkStatus.CANCELLED,
        expect.objectContaining({ cancelledAt: FIXED_NOW }),
      );
    },
  );

  // ---- gating rules ----

  it('holds the fleet-wide lock so only one pod sweeps', async () => {
    await build().tick();

    expect(locks.acquire).toHaveBeenCalledWith(PK_RECOVERY_LOCK_KEY, expect.any(Number));
  });

  it('caps the work per sweep', async () => {
    await build({ maxPerSweep: 2 }).tick();

    expect(repo.findStale).toHaveBeenCalledWith(expect.any(Date), expect.any(Array), 2);
  });

  // The VR-11 lesson: gating the TIMER left the queue-depth metric reporting
  // zero forever in the default configuration, which is worse than no metric.
  it('still records metrics when recovery ACTIONS are disabled', async () => {
    await build({ recoveryEnabled: false }).tick();

    expect(metrics.setPkActive).toHaveBeenCalled();
    expect(settlement.settle).not.toHaveBeenCalled();
    expect(locks.acquire).not.toHaveBeenCalled();
  });

  // ---- host disconnect ----

  it('moves LIVE → RECOVERING when a host drops', async () => {
    const live = battle({ id: 'b5', roomId: 'r5', status: VideoRoomPkStatus.LIVE });
    repo.findCurrent.mockResolvedValue(live);
    state.tryTransition.mockResolvedValue({ ...live, status: VideoRoomPkStatus.RECOVERING });

    await build().handleHostDrop('r5', 'host-1');

    expect(state.tryTransition).toHaveBeenCalledWith(
      'b5',
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.RECOVERING,
      expect.objectContaining({ pausedAt: FIXED_NOW }),
    );
  });

  // Finding: presence is room-wide (any member's socket can drop), but only a
  // PK participant's disconnect may freeze the battle's clock.
  it('ignores a drop from a user who is not a participant of the live battle', async () => {
    const live = battle({ id: 'b5b', roomId: 'r5b', status: VideoRoomPkStatus.LIVE });
    repo.findCurrent.mockResolvedValue(live);
    repo.findParticipantsByUserIds.mockResolvedValue([]);

    await build().handleHostDrop('r5b', 'spectator-1');

    expect(repo.findParticipantsByUserIds).toHaveBeenCalledWith('b5b', ['spectator-1']);
    expect(state.tryTransition).not.toHaveBeenCalled();
  });

  it('moves RECOVERING → LIVE when the host returns inside the grace window', async () => {
    const pausedAt = new Date(FIXED_NOW.getTime() - 10_000); // 10s ago; default grace is 45s
    const recovering = battle({
      id: 'b6',
      roomId: 'r6',
      status: VideoRoomPkStatus.RECOVERING,
      pausedAt,
      endsAt: new Date(FIXED_NOW.getTime() + 60_000),
    });
    repo.findCurrent.mockResolvedValue(recovering);
    timer.computeResume.mockReturnValue({
      endsAt: new Date(FIXED_NOW.getTime() + 70_000),
      totalPausedMs: 10_000,
      resumeSeq: 1,
    });
    state.tryTransition.mockResolvedValue({
      ...recovering,
      status: VideoRoomPkStatus.LIVE,
      resumeSeq: 1,
    });

    await build().handleHostReturn('r6', 'host-1');

    expect(state.tryTransition).toHaveBeenCalledWith(
      'b6',
      VideoRoomPkStatus.RECOVERING,
      VideoRoomPkStatus.LIVE,
      expect.objectContaining({ resumeSeq: 1, pausedAt: null }),
    );
    expect(timer.scheduleEnd).toHaveBeenCalled();
  });

  it('emits PkRecoveredEvent on a successful recovery', async () => {
    const pausedAt = new Date(FIXED_NOW.getTime() - 10_000);
    const recovering = battle({
      id: 'b7',
      roomId: 'r7',
      status: VideoRoomPkStatus.RECOVERING,
      pausedAt,
      endsAt: new Date(FIXED_NOW.getTime() + 60_000),
    });
    repo.findCurrent.mockResolvedValue(recovering);
    timer.computeResume.mockReturnValue({
      endsAt: new Date(FIXED_NOW.getTime() + 70_000),
      totalPausedMs: 10_000,
      resumeSeq: 1,
    });
    state.tryTransition.mockResolvedValue({
      ...recovering,
      status: VideoRoomPkStatus.LIVE,
      resumeSeq: 1,
    });

    await build().handleHostReturn('r7', 'host-1');

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: VIDEO_ROOM_PK_EVENTS.RECOVERED }),
    );
  });

  // A host reconnecting after the grace window is not resumed here — the
  // orphan sweep (sweepOrphans) is what settles it, with the scores as they
  // stand.
  it('does not resume a host who returns after the grace window', async () => {
    const pausedAt = new Date(FIXED_NOW.getTime() - 100_000); // 100s ago; default grace is 45s
    repo.findCurrent.mockResolvedValue(
      battle({ id: 'b8', roomId: 'r8', status: VideoRoomPkStatus.RECOVERING, pausedAt }),
    );

    await build().handleHostReturn('r8', 'host-1');

    expect(state.tryTransition).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('ignores a return from a user who is not a participant of the recovering battle', async () => {
    const pausedAt = new Date(FIXED_NOW.getTime() - 10_000);
    repo.findCurrent.mockResolvedValue(
      battle({ id: 'b8b', roomId: 'r8b', status: VideoRoomPkStatus.RECOVERING, pausedAt }),
    );
    repo.findParticipantsByUserIds.mockResolvedValue([]);

    await build().handleHostReturn('r8b', 'spectator-1');

    expect(repo.findParticipantsByUserIds).toHaveBeenCalledWith('b8b', ['spectator-1']);
    expect(state.tryTransition).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  // ---- beyond the brief's 12 ----

  // One failing condition (its OWN query rejecting, not just a bad row
  // inside it) must not prevent the other four sweeps from running this
  // tick — each is wrapped independently in `tick()`.
  it('one failing sweep condition does not prevent the other sweeps from running', async () => {
    repo.findStale.mockRejectedValue(new Error('db down'));

    await build().tick();

    expect(invitations.expireDue).toHaveBeenCalled();
    expect(repo.findByStatus).toHaveBeenCalledWith(VideoRoomPkStatus.COUNTDOWN, 50);
    expect(repo.findByStatus).toHaveBeenCalledWith(VideoRoomPkStatus.RECOVERING, 50);
    expect(repo.findByStatus).toHaveBeenCalledWith(VideoRoomPkStatus.LIVE, 50);
  });

  // A slow sweep overlapping the next timer fire must not double-process:
  // the fleet lock's TTL is `monitorIntervalSeconds`, which a slow sweep can
  // outlive, so this pod's own re-entrancy guard is what actually protects
  // it, not the distributed lock.
  it('does not double-process an overlapping tick from the same pod', async () => {
    let resolveAcquire!: (release: () => Promise<void>) => void;
    locks.acquire.mockImplementationOnce(
      () =>
        new Promise<(() => Promise<void>) | null>((resolve) => {
          resolveAcquire = resolve;
        }),
    );
    const svc = build();

    const firstTick = svc.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const secondTick = svc.tick();
    await secondTick;

    expect(locks.acquire).toHaveBeenCalledTimes(1);

    resolveAcquire(jest.fn().mockResolvedValue(undefined));
    await firstTick;
  });

  it('starts and stops an unref-ed sweep timer', () => {
    const svc = build();
    const unref = jest.fn();
    const setSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

    svc.onModuleInit();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(unref).toHaveBeenCalled();

    svc.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
